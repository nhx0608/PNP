import Fastify from "fastify";
import { GatewayCore } from "../core/gateway-core.ts";
import { PnpError, asPnpError } from "../core/errors.ts";
import type { ModelSelection, PromptRequest, PublicEvent } from "../contracts/index.ts";
import { CreateSessionSchema, PromptSchema } from "./schemas.ts";
import type { CreateSessionBody, PromptBody } from "./schemas.ts";

interface FastifyHttpError {
  code?: string;
  validation?: unknown;
}

export interface BuildAppOptions {
  /** SSE per-connection buffer cap in bytes. Defaults to 8 MiB; overridable for tests only. */
  sseMaxBufferedBytes?: number;
}

/** Event types whose payload is a full-text content update rather than session control state.
 *  These are the only events safe to drop silently when a slow reader backs up the buffer. */
const CONTENT_EVENT_TYPES = new Set<string>(["message.part.updated"]);
function isContentEvent(type: string): boolean {
  return CONTENT_EVENT_TYPES.has(type);
}

/** Upper bound on a single resume so one reconnect cannot walk the whole event table. */
const REPLAY_PAGE = 256;
const REPLAY_LIMIT = 4096;
/**
 * Replays committed events after `lastEventId` in ascending sequence order. The caller subscribes
 * first and buffers live events, so this can never leave a gap between the replay and the stream.
 * Returns the highest sequence written, which the caller uses to drop live duplicates.
 */
async function replayMissedEvents(
  core: GatewayCore, lastEventId: number, emit: (event: PublicEvent) => void, stopped: () => boolean,
): Promise<number> {
  let cursor = lastEventId;
  let written = 0;
  while (!stopped() && written < REPLAY_LIMIT) {
    const page = await core.journal.since(cursor, REPLAY_PAGE);
    if (page.length === 0) break;
    for (const event of page) {
      if (stopped()) break;
      emit(event);
      cursor = event.sequence;
      written += 1;
    }
    if (page.length < REPLAY_PAGE) break;
  }
  return cursor;
}
function parseLastEventId(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).type === "text" && typeof (value as Record<string, unknown>).text === "string";
}
/** The empty-string selection is a sentinel meaning "no model requested"; config never allows
 *  empty providerID/modelID, so it can never collide with a real configured selection. The
 *  integration provider (ConfiguredIntegration) is responsible for resolving it to a default. */
function parseModelSelection(model: PromptBody["model"]): ModelSelection {
  if (model === undefined) return { providerID: "", modelID: "" };
  if (typeof model === "string") {
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) {
      throw new PnpError("VALIDATION_ERROR", 'model string must be in "provider/model" form.', 400);
    }
    return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
  }
  return model;
}
function resolvePromptRequest(body: PromptBody): PromptRequest {
  const parts = body.parts.filter(isTextPart);
  if (parts.length === 0) throw new PnpError("VALIDATION_ERROR", "No recognized message parts.", 400);
  return { parts, model: parseModelSelection(body.model), agent: body.agent };
}

function asHttpError(error: unknown): PnpError {
  if (error instanceof PnpError) return error;
  if (typeof error !== "object" || error === null) return asPnpError(error);
  const candidate = error as FastifyHttpError;
  if (candidate.validation !== undefined) {
    return new PnpError("VALIDATION_ERROR", "Invalid request.", 400);
  }
  switch (candidate.code) {
    case "FST_ERR_CTP_BODY_TOO_LARGE":
      return new PnpError("BODY_TOO_LARGE", "Request body is too large.", 413);
    case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
      return new PnpError("UNSUPPORTED_MEDIA_TYPE", "Unsupported media type.", 415);
    case "FST_ERR_CTP_EMPTY_JSON_BODY":
    case "FST_ERR_CTP_INVALID_JSON_BODY":
      return new PnpError("VALIDATION_ERROR", "Invalid JSON body.", 400);
    default:
      return asPnpError(error);
  }
}

export function buildApp(core: GatewayCore, options: BuildAppOptions = {}) {
  const sseMaxBufferedBytes = options.sseMaxBufferedBytes ?? 8 * 1024 * 1024;
  const app = Fastify({
    logger: { redact: ["req.headers.authorization", "req.headers.cookie"] },
    disableRequestLogging: true,
    bodyLimit: 1024 * 1024,
    requestTimeout: 30_000, // Receiving the body, NOT the Agent run deadline.
    connectionTimeout: 0,
  });
  const closeStreams = new Set<() => void>();
  const defaultJsonParser = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "" && /\/session\/:id\/(?:abort|stop)$/.test(request.routeOptions.url ?? "")) {
      done(null, {});
      return;
    }
    defaultJsonParser(request, text, done);
  });
  app.setErrorHandler((error, _request, reply) => {
    const safe = asHttpError(error);
    // A full execution queue is the one refusal that is purely about timing: tell the caller so
    // rather than leaving it to guess an interval.
    if (safe.code === "GATEWAY_BUSY") reply.header("Retry-After", "5");
    return reply.code(safe.status).send({ code: safe.code, message: safe.message });
  });
  app.get("/health/live", async () => ({ status: "alive" }));
  app.get("/health/ready", async (_request, reply) => reply.code(core.readiness ? 200 : 503)
    .send({ status: core.readiness ? "ready" : "not-ready", engine: core.engineId }));
  app.post<{ Body: CreateSessionBody }>("/session", { schema: { body: CreateSessionSchema } }, async (request) => {
    const session = await core.createSession(request.body.directory, request.body.title);
    return { id: session.id, title: session.title, created_at: session.createdAt, status: session.status };
  });
  app.get("/session/status", async () => core.status());
  app.get<{ Params: { id: string } }>("/session/:id", async (request) => {
    const session = await core.getSession(request.params.id);
    return {
      id: session.id, title: session.title, created_at: session.createdAt,
      status: session.status, message_count: (await core.messages(session.id)).length,
    };
  });
  app.get<{ Params: { id: string } }>("/session/:id/message", async (request) => core.messages(request.params.id));
  app.post<{ Params: { id: string }; Body: PromptBody }>("/session/:id/prompt_async",
    { schema: { body: PromptSchema } }, async (request, reply) => {
      const rawKey = request.headers["idempotency-key"];
      if (rawKey !== undefined && (typeof rawKey !== "string" || rawKey.length > 200)) {
        throw new PnpError("VALIDATION_ERROR", "Invalid Idempotency-Key.", 400);
      }
      await core.run(request.params.id, resolvePromptRequest(request.body), rawKey);
      return reply.code(204).send();
    });
  for (const suffix of ["abort", "stop"]) {
    app.post<{ Params: { id: string } }>(`/session/:id/${suffix}`, async (request) => {
      await core.abort(request.params.id);
      return { ok: true };
    });
  }
  app.delete<{ Params: { id: string } }>("/session/:id", async (request) => {
    await core.deleteSession(request.params.id);
    return { ok: true };
  });
  app.get("/diagnostics", async () => core.diagnostics());
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ code: "NOT_FOUND", message: "Route not found." }));
  app.get("/question", async () => core.interactions.list("question"));
  app.get("/permission", async () => core.interactions.list("permission"));
  app.post<{ Params: { id: string }; Body: { answers: string[][] } }>("/question/:id/reply", async (request) => {
    const answers = request.body?.answers;
    if (!Array.isArray(answers) || !answers.every((a) => Array.isArray(a) && a.every((v) => typeof v === "string"))) {
      throw new PnpError("VALIDATION_ERROR", "answers must be a string array of arrays.", 400);
    }
    await core.interactions.reply(request.params.id, "question", { decision: "answer", answers });
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { reply: string } }>("/permission/:id/reply", async (request) => {
    const value = request.body?.reply;
    if (!["once", "always", "reject"].includes(value)) throw new PnpError("VALIDATION_ERROR", "Invalid permission reply.", 400);
    await core.interactions.reply(request.params.id, "permission", { decision: value === "reject" ? "deny" : "allow" });
    return { ok: true };
  });
  app.get("/event", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no",
    });
    reply.raw.write("retry: 3000\n\n");
    const lastEventId = parseLastEventId(request.headers["last-event-id"]);
    let closed = false;
    let backpressured = false;
    let queuedBytes = 0;
    interface QueuedFrame { readonly frame: string; readonly bytes: number; readonly content: boolean }
    const queued: QueuedFrame[] = [];
    const onDrain = () => {
      if (closed) return;
      backpressured = false;
      while (queued.length > 0) {
        const next = queued.shift()!;
        queuedBytes -= next.bytes;
        if (!reply.raw.write(next.frame)) {
          backpressured = true;
          return;
        }
      }
    };
    const cleanup = (force = false) => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      unsubscribe();
      reply.raw.off("drain", onDrain);
      queued.length = 0;
      queuedBytes = 0;
      closeStreams.delete(cleanup);
      if (force) reply.raw.destroy();
      else if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    };
    const send = (event: PublicEvent | { type: string; properties: Record<string, never> }) => {
      if (closed) return;
      if (backpressured && event.type === "server.heartbeat") return; // Heartbeats are best-effort; never queued.
      const frame = `${"sequence" in event ? `id: ${event.sequence}\n` : ""}data: ${JSON.stringify(event)}\n\n`;
      const frameBytes = Buffer.byteLength(frame);
      const content = isContentEvent(event.type);
      const fits = (bytes: number) => reply.raw.writableLength + queuedBytes + bytes <= sseMaxBufferedBytes;
      if (!fits(frameBytes)) {
        // Content updates (full-text checkpoints) are the amplification source; drop the update
        // rather than tear down the connection. Control events must never be silently lost, so a
        // control event first tries to evict already-queued content frames to make room.
        if (content) return;
        for (let i = queued.length - 1; i >= 0 && !fits(frameBytes); i--) {
          const candidate = queued[i];
          if (candidate === undefined || !candidate.content) continue;
          queuedBytes -= candidate.bytes;
          queued.splice(i, 1);
        }
        if (!fits(frameBytes)) { cleanup(true); return; } // Control backlog itself exceeds the cap.
      }
      if (backpressured) {
        queued.push({ frame, bytes: frameBytes, content });
        queuedBytes += frameBytes;
        return;
      }
      // A false result means this frame was accepted into Node's buffer. Queue only later frames.
      if (!reply.raw.write(frame)) backpressured = true;
    };
    // Live events are held until the replay finishes, so the client never sees a newer sequence
    // before an older one. Duplicates are dropped by sequence rather than by guessing.
    let replaying = lastEventId !== undefined;
    const pendingLive: PublicEvent[] = [];
    const receive = (event: PublicEvent) => {
      if (!replaying) { send(event); return; }
      if (pendingLive.length < REPLAY_LIMIT) pendingLive.push(event);
    };
    const unsubscribe = core.journal.subscribe(receive);
    const timer = setInterval(() => send({ type: "server.heartbeat", properties: {} }), 15_000);
    closeStreams.add(cleanup);
    reply.raw.once("close", cleanup);
    reply.raw.once("error", cleanup);
    reply.raw.on("drain", onDrain);
    send({ type: "server.connected", properties: {} });
    if (lastEventId !== undefined) {
      let resumed = lastEventId;
      // A failed resume degrades to the live stream: losing history beats losing the only connection.
      try { resumed = await replayMissedEvents(core, lastEventId, send, () => closed); }
      catch { /* The client can ask again; the stream itself stays up. */ }
      replaying = false;
      for (const event of pendingLive.splice(0)) if (event.sequence > resumed) send(event);
    }
  });
  app.addHook("preClose", async () => {
    try { await core.close(); } finally { for (const cleanup of closeStreams) cleanup(); }
  });
  return app;
}
