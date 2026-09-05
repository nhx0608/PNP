import Fastify from "fastify";
import { GatewayCore } from "../core/gateway-core.ts";
import { PnpError, asPnpError } from "../core/errors.ts";
import type { PublicEvent } from "../contracts/index.ts";
import { CreateSessionSchema, PromptSchema } from "./schemas.ts";
import type { CreateSessionBody, PromptBody } from "./schemas.ts";

export function buildApp(core: GatewayCore) {
  const app = Fastify({
    logger: { redact: ["req.headers.authorization", "req.headers.cookie"] },
    disableRequestLogging: true,
    bodyLimit: 1024 * 1024,
    requestTimeout: 30_000, // Receiving the body, NOT the Agent run deadline.
    connectionTimeout: 0,
  });
  const closeStreams = new Set<() => void>();
  app.setErrorHandler((error, _request, reply) => {
    if (typeof error === "object" && error !== null && "validation" in error && error.validation) {
      return reply.code(400).send({ code: "VALIDATION_ERROR", message: "Invalid request." });
    }
    const safe = asPnpError(error);
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
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      unsubscribe();
      closeStreams.delete(cleanup);
      reply.raw.end();
    };
    const send = (event: PublicEvent | { type: string; properties: Record<string, never> }) => {
      if (closed) return;
      const frame = `${"sequence" in event ? `id: ${event.sequence}\n` : ""}data: ${JSON.stringify(event)}\n\n`;
      // Conservative bounded backpressure: disconnect rather than queue unbounded output.
      if (reply.raw.writableLength > 256 * 1024) { cleanup(); return; }
      if (!reply.raw.write(frame)) cleanup();
    };
    const unsubscribe = core.journal.subscribe(send);
    const timer = setInterval(() => send({ type: "server.heartbeat", properties: {} }), 15_000);
    closeStreams.add(cleanup);
    reply.raw.once("close", cleanup);
    reply.raw.once("error", cleanup);
    send({ type: "server.connected", properties: {} });
  });
  app.addHook("preClose", async () => {
    try { await core.close(); } finally { for (const cleanup of closeStreams) cleanup(); }
  });
  return app;
}
