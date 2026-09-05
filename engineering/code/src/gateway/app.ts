import Fastify from "fastify";
import { GatewayCore } from "../core/gateway-core.ts";
import { PnpError, asPnpError } from "../core/errors.ts";
import type { PublicEvent } from "../contracts/index.ts";
import { CreateSessionSchema, PromptSchema } from "./schemas.ts";
import type { CreateSessionBody, PromptBody } from "./schemas.ts";

interface FastifyHttpError {
  code?: string;
  validation?: unknown;
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

export function buildApp(core: GatewayCore) {
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
      await core.run(request.params.id, request.body, rawKey);
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
  app.get("/event", async (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no",
    });
    let closed = false;
    let backpressured = false;
    let queuedBytes = 0;
    const queued: string[] = [];
    const maxBufferedBytes = 2 * 1024 * 1024;
    const onDrain = () => {
      if (closed) return;
      backpressured = false;
      while (queued.length > 0) {
        const frame = queued.shift()!;
        queuedBytes -= Buffer.byteLength(frame);
        if (!reply.raw.write(frame)) {
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
      const frame = `${"sequence" in event ? `id: ${event.sequence}\n` : ""}data: ${JSON.stringify(event)}\n\n`;
      const frameBytes = Buffer.byteLength(frame);
      if (backpressured) {
        if (event.type === "server.heartbeat") return;
        if (reply.raw.writableLength + queuedBytes + frameBytes > maxBufferedBytes) { cleanup(true); return; }
        queued.push(frame);
        queuedBytes += frameBytes;
        return;
      }
      if (reply.raw.writableLength + frameBytes > maxBufferedBytes) { cleanup(true); return; }
      // A false result means this frame was accepted into Node's buffer. Queue only later frames.
      if (!reply.raw.write(frame)) backpressured = true;
    };
    const unsubscribe = core.journal.subscribe(send);
    const timer = setInterval(() => send({ type: "server.heartbeat", properties: {} }), 15_000);
    closeStreams.add(cleanup);
    reply.raw.once("close", cleanup);
    reply.raw.once("error", cleanup);
    reply.raw.on("drain", onDrain);
    send({ type: "server.connected", properties: {} });
  });
  app.addHook("preClose", async () => {
    try { await core.close(); } finally { for (const cleanup of closeStreams) cleanup(); }
  });
  return app;
}
