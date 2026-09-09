import Fastify from "fastify";
import { GatewayCore } from "../core/gateway-core.ts";
import { PnpError, asPnpError } from "../core/errors.ts";
import type { Json, ModelSelection, PromptRequest, PublicEvent } from "../contracts/index.ts";
import { CreateSessionSchema, PromptSchema } from "./schemas.ts";
import type { CreateSessionBody, PromptBody } from "./schemas.ts";
import type { ConfigRoute } from "../config/routes.ts";

interface FastifyHttpError {
  code?: string;
  validation?: unknown;
}

export interface BuildAppOptions {
  /** SSE per-connection buffer cap in bytes. Defaults to 8 MiB; overridable for tests only. */
  sseMaxBufferedBytes?: number;
  /**
   * The configuration surface, already built by the caller. Omitted, the `/config` family simply
   * does not exist -- every route here stays optional so a deployment that does not want a
   * writable configuration API is a deployment that passes nothing, not one that has to disable
   * something. The route table is produced by src/config/routes.ts and is asserted there to live
   * entirely under `/config`, so mounting it can never shadow a specification route.
   */
  configRoutes?: readonly ConfigRoute[];
}

/** Event types whose payload is a full-text content update rather than session control state.
 *  These are the only events safe to drop silently when a slow reader backs up the buffer.
 *  `server.gap` is deliberately NOT one of them: it is the notice that history was already lost, so
 *  dropping it would recreate exactly the silent loss it exists to report. */
const CONTENT_EVENT_TYPES = new Set<string>(["message.part.updated"]);
function isContentEvent(type: string): boolean {
  return CONTENT_EVENT_TYPES.has(type);
}

/** Upper bound on a single resume so one reconnect cannot walk the whole event table. */
const REPLAY_PAGE = 256;
const REPLAY_LIMIT = 4096;
/** Why a resume stopped short. Only `complete` leaves the client's view of history whole. */
type ReplayOutcome = "complete" | "replay-limit" | "replay-failed";
/** Every way the stream can knowingly withhold history, as the `reason` of a `server.gap` event. */
type GapReason = "replay-limit" | "pending-overflow" | "replay-failed";
interface ReplayResult {
  /** Highest sequence actually written; the caller drops live duplicates at or below it. */
  readonly cursor: number;
  readonly outcome: ReplayOutcome;
}
/**
 * Replays committed events after `lastEventId` in ascending sequence order. The caller subscribes
 * first and buffers live events, so this can never leave a gap between the replay and the stream.
 *
 * Stopping short is REPORTED, never thrown and never silent: a client whose cursor has already moved
 * past the missing range can never recover it by reconnecting, so the caller turns the outcome into
 * a `server.gap` frame before the live stream continues.
 */
async function replayMissedEvents(
  core: GatewayCore, lastEventId: number, emit: (event: PublicEvent) => void, stopped: () => boolean,
): Promise<ReplayResult> {
  let cursor = lastEventId;
  let written = 0;
  while (!stopped()) {
    if (written >= REPLAY_LIMIT) return { cursor, outcome: "replay-limit" };
    let page: PublicEvent[];
    // The query is the only failure in this loop. It becomes an outcome rather than an exception so
    // the connection survives while the client is still told its history is short. The error text
    // itself never travels into the event: it can name local paths.
    try { page = await core.journal.since(cursor, REPLAY_PAGE); }
    catch { return { cursor, outcome: "replay-failed" }; }
    if (page.length === 0) break;
    for (const event of page) {
      if (stopped()) break;
      emit(event);
      cursor = event.sequence;
      written += 1;
    }
    if (page.length < REPLAY_PAGE) break;
  }
  return { cursor, outcome: "complete" };
}
/**
 * A query parameter that must be a plain non-negative integer in range. Query values arrive as
 * strings, and `Number("")`/`Number(" 1 ")`/`Number("1e3")` all succeed, so the digits are checked
 * before the value is: answering a malformed cursor with a page would hide the client's bug behind
 * plausible-looking history. A repeated parameter arrives as an array and fails the same test.
 */
function parseQueryInteger(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(String(raw))) {
    throw new PnpError("VALIDATION_ERROR", `${name} must be a non-negative integer.`, 400);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new PnpError("VALIDATION_ERROR", `${name} must be between ${min} and ${max}.`, 400);
  }
  return value;
}
function parseLastEventId(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * One text part as the contract carries it. The baseline request body names the field `text`, but the
 * message projection this gateway returns names it `content`, and a client that mirrors what it read
 * back sends `content` on the next turn; refusing that costs the whole case over a field name. Both
 * are accepted, and `text` wins when a part carries both, because it is the field the request body
 * specifies. A part of any other type is still ignored rather than failing the request.
 */
function textPartOf(value: unknown): { type: "text"; text: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const part = value as Record<string, unknown>;
  if (part.type !== "text") return undefined;
  if (typeof part.text === "string") return { type: "text", text: part.text };
  if (typeof part.content === "string") return { type: "text", text: part.content };
  return undefined;
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
  // Projected field by field: an unknown field inside `model` is ignored here rather than travelling
  // on into the request hash, the provider and the driver.
  return { providerID: model.providerID, modelID: model.modelID };
}
function resolvePromptRequest(body: PromptBody): PromptRequest {
  const parts = body.parts.map(textPartOf).filter((part) => part !== undefined);
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
    // The assessment client is not ours. A harness that builds URLs as `base + "/session/"` would
    // otherwise lose the whole case to a 404 on the very first call, which is an expensive way to
    // enforce a slash.
    ignoreTrailingSlash: true,
  });
  const closeStreams = new Set<() => void>();
  const defaultJsonParser = app.getDefaultJsonParser("error", "error");
  const parseJsonBody = (request: { routeOptions: { url?: string } }, body: string | Buffer,
    done: (error: Error | null, value?: unknown) => void) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "" && /\/session\/:id\/(?:abort|stop)$/.test(request.routeOptions.url ?? "")) {
      done(null, {});
      return;
    }
    defaultJsonParser(request as never, text, done);
  };
  // Every body on this API is JSON; the Content-Type header only ever says so redundantly, so the
  // body is judged by whether it parses rather than by what the header claimed. Removing ALL the
  // defaults matters: Fastify ships its own `text/plain` parser, which would otherwise shadow the
  // catch-all and hand the route a raw string that fails schema validation.
  //
  // This is not theoretical tolerance. Measured against this gateway before the change: a body
  // sent with no Content-Type, or with `application/x-www-form-urlencoded` - which is exactly what
  // PowerShell's `Invoke-RestMethod -Body $json` and `curl -d` send when nobody sets the header -
  // got 415 UNSUPPORTED_MEDIA_TYPE before the engine was ever reached, losing the whole case over
  // a header the client never meant to set. A body that is genuinely not JSON still fails, now as
  // 400 VALIDATION_ERROR naming the real problem.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, parseJsonBody);
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
  // Event history for ONE session. Registered under /session/:id, so it is a different resource from
  // the live stream at GET /event and cannot shadow it; it is registered next to /session/:id/message
  // because the same ordering rule that puts /session/status ahead of /session/:id applies here.
  // Without it, "what happened in session X" means replaying the whole global journal and filtering
  // client-side. A page is bounded by REPLAY_PAGE, the same bound one SSE resume page uses.
  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>(
    "/session/:id/event", async (request) => {
      const after = parseQueryInteger(request.query.after, 0, 0, Number.MAX_SAFE_INTEGER, "after");
      const limit = parseQueryInteger(request.query.limit, REPLAY_PAGE, 1, REPLAY_PAGE, "limit");
      await core.getSession(request.params.id); // Unknown session is 404, as on every other /session/:id route.
      // One row past the page decides `complete` without a second query. Sequences are global and
      // sparse per session - deleting a session cascades its rows away, and other sessions interleave
      // - so a row count is the only end-of-history signal available; the numbers must not be assumed
      // dense. A deleted session legitimately holds no events at all.
      const page = await core.journal.forSession(request.params.id, after, limit + 1);
      const events = page.slice(0, limit);
      return { events, next_cursor: events.at(-1)?.sequence ?? null, complete: page.length <= limit };
    });
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
  // The configuration surface, when the caller built one. Mounted from a table rather than written
  // out here so the routes stay owned by src/config/, which is where their validation, provenance
  // and write semantics live; this layer only adapts Fastify's request to the table's shape and
  // lets the shared error handler turn a PnpError into the standard {code,message} envelope.
  // routes.ts asserts every path is under /config, so this loop cannot shadow a specification route.
  for (const route of options.configRoutes ?? []) {
    const handler = async (request: {
      query?: unknown; params?: unknown; body?: unknown;
    }, reply: { code(status: number): { headers(values: Record<string, string>): { send(body: unknown): unknown }; send(body: unknown): unknown } }) => {
      const answer = await route.handle({
        query: request.query as Readonly<Record<string, string | undefined>> | undefined,
        params: request.params as Readonly<Record<string, string | undefined>> | undefined,
        body: request.body,
      });
      const sending = reply.code(answer.status);
      return answer.headers === undefined ? sending.send(answer.body) : sending.headers({ ...answer.headers }).send(answer.body);
    };
    if (route.method === "GET") app.get(route.path, handler);
    else if (route.method === "POST") app.post(route.path, handler);
    else app.put(route.path, handler);
  }
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ code: "NOT_FOUND", message: "Route not found." }));
  app.get("/question", async () => core.interactions.list("question"));
  app.get("/permission", async () => core.interactions.list("permission"));
  app.post<{ Params: { id: string }; Body: { answers: (string | string[])[] } }>("/question/:id/reply", async (request) => {
    const answers = request.body?.answers;
    if (!Array.isArray(answers)) throw new PnpError("VALIDATION_ERROR", "answers must be a string array of arrays.", 400);
    // The contract shape is one answer array per question (`[["A"]]`). A client answering a
    // single-question prompt naturally writes `["A"]`, and the judge harness is not ours to
    // correct; a flat array of strings is lifted into the documented shape rather than refused,
    // because losing a case over a bracket helps nobody. Mixed arrays stay a validation error.
    const flat = answers.every((entry) => typeof entry === "string");
    const nested = answers.every((entry) => Array.isArray(entry) && entry.every((value) => typeof value === "string"));
    if (!flat && !nested) throw new PnpError("VALIDATION_ERROR", "answers must be a string array of arrays.", 400);
    const normalized = flat ? [answers as string[]] : answers as string[][];
    await core.interactions.reply(request.params.id, "question", { decision: "answer", answers: normalized });
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { reply: string } }>("/permission/:id/reply", async (request) => {
    const value = request.body?.reply;
    if (!["once", "always", "reject"].includes(value)) throw new PnpError("VALIDATION_ERROR", "Invalid permission reply.", 400);
    // `always` is answered exactly like `once` for this request; what it adds is the gateway
    // remembering this operation for the rest of this session. It never becomes a native
    // allow-always in an engine, and it never outlives the session (contract section 7).
    await core.interactions.reply(request.params.id, "permission",
      { decision: value === "reject" ? "deny" : "allow" }, { remember: value === "always" });
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
    const send = (event: PublicEvent | { type: string; properties: { [key: string]: Json } }) => {
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
    /**
     * The one frame that says "you did not receive everything". It carries no `sequence`, so it is
     * not a journal entry and never advances the client's Last-Event-ID; and it is not a content
     * event, so the backpressure path above can evict content frames to make room for it but can
     * never evict it. `from`/`to` bound the sequences the client did NOT receive, inclusive. `to` is
     * null when the upper bound is not yet known - the client must then treat everything from `from`
     * up to the next `id:` it sees as missing, and can re-request that range with
     * `GET /session/{id}/event?after=` or by reconnecting with `Last-Event-ID: from - 1`.
     */
    const sendGap = (from: number, to: number | null, reason: GapReason) => {
      send({ type: "server.gap", properties: { from, to, reason } });
    };
    // Live events are held until the replay finishes, so the client never sees a newer sequence
    // before an older one. Duplicates are dropped by sequence rather than by guessing.
    let replaying = lastEventId !== undefined;
    const pendingLive: PublicEvent[] = [];
    /** Inclusive sequence range dropped because the hold buffer was full. The buffer stays bounded so
     *  one slow replay cannot pin unbounded history in memory; what it drops is reported, not hidden. */
    let droppedLive: { from: number; to: number } | undefined;
    const receive = (event: PublicEvent) => {
      if (!replaying) { send(event); return; }
      if (pendingLive.length < REPLAY_LIMIT) { pendingLive.push(event); return; }
      droppedLive = { from: droppedLive?.from ?? event.sequence, to: event.sequence };
    };
    const unsubscribe = core.journal.subscribe(receive);
    const timer = setInterval(() => send({ type: "server.heartbeat", properties: {} }), 15_000);
    closeStreams.add(cleanup);
    reply.raw.once("close", cleanup);
    reply.raw.once("error", cleanup);
    reply.raw.on("drain", onDrain);
    send({ type: "server.connected", properties: {} });
    if (lastEventId !== undefined) {
      // A failed or truncated resume still degrades to the live stream - losing history beats losing
      // the only connection - but it is announced first. Measured before this: 5000 stored events and
      // `Last-Event-ID: 0` delivered 1..4096 and then jumped to 5001, with 904 events gone and no
      // signal at all; the client's cursor had moved past them, so no later reconnect could recover
      // them either.
      const replay = await replayMissedEvents(core, lastEventId, send, () => closed);
      const resumed = replay.cursor;
      let reason: GapReason | undefined = replay.outcome === "replay-failed" ? "replay-failed" : undefined;
      let firstMissed: number | undefined;
      if (replay.outcome === "replay-limit" && !closed) {
        // Hitting the limit does not by itself prove history was withheld: the last page can land
        // exactly on the end of the table. One row past the cursor settles it. A failed probe cannot
        // prove there is no gap, and an unprovable gap is announced rather than assumed away.
        try { firstMissed = (await core.journal.since(resumed, 1))[0]?.sequence; }
        catch { firstMissed = resumed + 1; }
      }
      // The oldest buffered live event bounds any hole above the cursor, and everything from it
      // onward is about to be forwarded. Read after the probe above, the last point at which the
      // buffer can still grow.
      const nextLive = pendingLive.find((event) => event.sequence > resumed)?.sequence;
      const to = nextLive === undefined ? null : nextLive - 1;
      if (firstMissed !== undefined && (nextLive === undefined || firstMissed < nextLive)) reason = "replay-limit";
      // An empty range means the buffer already carries everything above the cursor, which is proof
      // of completeness even when the replay itself failed. Nothing to announce then.
      if (reason !== undefined && (to === null || to >= resumed + 1)) sendGap(resumed + 1, to, reason);
      // No await from here to the end of the flush, so no live event can overtake the buffered ones.
      replaying = false;
      for (const event of pendingLive.splice(0)) if (event.sequence > resumed) send(event);
      // Overflow drops sit AFTER everything the buffer kept and BEFORE anything still to come, so the
      // notice belongs here rather than above: this is still before the stream continues live.
      if (droppedLive !== undefined) sendGap(droppedLive.from, droppedLive.to, "pending-overflow");
    }
  });
  app.addHook("preClose", async () => {
    try { await core.close(); } finally { for (const cleanup of closeStreams) cleanup(); }
  });
  return app;
}
