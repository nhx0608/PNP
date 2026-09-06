#!/usr/bin/env node
// Zero-dependency OpenAI Chat Completions stand-in for the PNP end-to-end smoke test.
// It is the only mocked component of the smoke run: gateway, process host, ACP driver
// and the OpenCode binary itself are all real.
import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
]);
const REDACTED = "[redacted]";

const { values } = parseArgs({
  options: {
    host: { type: "string" },
    port: { type: "string" },
    log: { type: "string" },
    "stall-ms": { type: "string" },
    "model-id": { type: "string" },
    "chunk-delay-ms": { type: "string" },
  },
});
const host = values.host ?? "127.0.0.1";
const port = Number(values.port ?? 0);
const logPath = values.log;
const stallMs = Number(values["stall-ms"] ?? 120_000);
const defaultModelId = values["model-id"] ?? "mock-1";
const chunkDelayMs = Number(values["chunk-delay-ms"] ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be a valid port.");
if (!Number.isFinite(stallMs) || stallMs < 0) throw new Error("--stall-ms must be a non-negative number.");

/** Masks credential-shaped values so no artifact can carry a live token. */
function redactText(value) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, REDACTED);
}
function redactHeaders(headers) {
  const safe = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    safe[key] = SECRET_HEADERS.has(key) ? REDACTED : redactText(String(value));
  }
  return safe;
}
let logTail = Promise.resolve();
function log(entry) {
  if (logPath === undefined) return;
  const line = `${redactText(JSON.stringify(entry))}\n`;
  logTail = logTail.then(() => appendFile(logPath, line, "utf8")).catch(() => undefined);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part !== null && typeof part === "object" && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}
function splitFirstToken(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"")) {
    const end = trimmed.indexOf("\"", 1);
    if (end > 0) return [trimmed.slice(1, end), trimmed.slice(end + 1).trim()];
  }
  const match = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
  return match === null ? [trimmed, ""] : [match[1], match[2].trim()];
}

const TITLE_PREFIX = "generate a title for this conversation";

/**
 * Only the NEWEST user message selects the scenario. OpenCode replays the whole
 * conversation on every request, so an older turn's keyword must never be re-triggered.
 * The single exception is the tool-result continuation: a `tool` role appearing AFTER
 * that newest user message belongs to the same turn.
 */
function pickScenario(messages) {
  let index = -1;
  for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor];
    if (message !== null && typeof message === "object" && message.role === "user") { index = cursor; break; }
  }
  if (index < 0) return { name: "default", toolResultFollows: false };
  const text = textOf(messages[index].content);
  const toolResultFollows = messages
    .slice(index + 1)
    .some((message) => message !== null && typeof message === "object" && message.role === "tool");
  if (text.trim().toLowerCase().startsWith(TITLE_PREFIX)) return { name: "title", toolResultFollows };
  if (text.includes("E2E_WRITE_FILE")) {
    const rest = text.slice(text.indexOf("E2E_WRITE_FILE") + "E2E_WRITE_FILE".length);
    const [target, remainder] = splitFirstToken(rest);
    const body = remainder.split(/\r?\n/, 1)[0].trim();
    return { name: "write_file", target, body: body === "" ? "hello-from-e2e" : body, toolResultFollows };
  }
  if (text.includes("E2E_STALL")) return { name: "stall", toolResultFollows };
  if (text.includes("E2E_HELLO")) return { name: "hello", toolResultFollows };
  return { name: "default", toolResultFollows };
}

const FILE_KEYS = ["filePath", "file_path", "path", "filepath", "file", "target"];
const CONTENT_KEYS = ["content", "contents", "text", "body", "data"];
function pickKey(properties, preferred, fallback) {
  for (const key of preferred) if (Object.hasOwn(properties, key)) return key;
  const remaining = Object.keys(properties).filter((key) => !preferred.includes(key));
  return remaining.length > 0 ? remaining[0] : fallback;
}
/** Tool arguments follow the schema the client actually advertised, never a hardcoded shape. */
function buildWriteCall(tools, scenario) {
  const named = (name) => tools.find((tool) => tool?.function?.name === name);
  const write = named("write");
  if (write !== undefined) {
    const properties = write.function?.parameters?.properties ?? {};
    const fileKey = pickKey(properties, FILE_KEYS, "filePath");
    const contentKey = pickKey(properties, CONTENT_KEYS, "content");
    return { name: "write", arguments: { [fileKey]: scenario.target, [contentKey]: scenario.body } };
  }
  const bash = named("bash");
  if (bash !== undefined) {
    const properties = bash.function?.parameters?.properties ?? {};
    const commandKey = pickKey(properties, ["command", "cmd", "script"], "command");
    const quoted = scenario.target.replace(/'/g, "'\\''");
    return {
      name: "bash",
      arguments: { [commandKey]: `printf '%s' '${scenario.body.replace(/'/g, "'\\''")}' > '${quoted}'` },
    };
  }
  return undefined;
}

const usage = (completionTokens) => ({
  prompt_tokens: 42,
  completion_tokens: completionTokens,
  total_tokens: 42 + completionTokens,
});

/**
 * Decides the reply for one request.
 * A request that advertises no tools always gets plain text: OpenCode's internal side
 * call carries `tools: []` and must never be answered with a function call.
 */
function plan(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const scenario = pickScenario(messages);
  // OpenCode's title-generation side call carries no tools. It must never receive a
  // function call and must never stall, whatever keyword the quoted prompt contains.
  if (scenario.name === "title") {
    return { kind: "text", scenario: "title", text: "E2E Smoke Session" };
  }
  if (tools.length === 0) {
    return { kind: "text", scenario: `${scenario.name}:no-tools`, text: "E2E_SIDECALL_OK" };
  }
  if (scenario.name === "hello") {
    return { kind: "text", scenario: scenario.name, text: "E2E_HELLO_OK the gateway reached the model service." };
  }
  if (scenario.name === "stall") {
    return { kind: "stall", scenario: scenario.name };
  }
  if (scenario.name === "write_file") {
    if (scenario.toolResultFollows) {
      return { kind: "text", scenario: `${scenario.name}:after-tool`, text: "E2E_WRITE_DONE" };
    }
    const call = buildWriteCall(tools, scenario);
    if (call === undefined) {
      return { kind: "text", scenario: `${scenario.name}:no-write-tool`, text: "E2E_WRITE_UNAVAILABLE" };
    }
    return { kind: "tool_call", scenario: scenario.name, call };
  }
  return { kind: "text", scenario: scenario.name, text: "E2E_DEFAULT" };
}

function chunkFrame(id, model, created, delta, finishReason, extra = {}) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    ...extra,
  };
}
function pieces(value, count) {
  if (value.length === 0) return [""];
  const size = Math.max(1, Math.ceil(value.length / count));
  const out = [];
  for (let index = 0; index < value.length; index += size) out.push(value.slice(index, index + size));
  return out;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function streamResponse(response, body, decision) {
  const id = `chatcmpl-${randomUUID()}`;
  const model = typeof body.model === "string" ? body.model : defaultModelId;
  const created = Math.floor(Date.now() / 1000);
  const includeUsage = body.stream_options?.include_usage === true;
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const write = (frame) => {
    if (response.writableEnded || response.destroyed) return false;
    response.write(`data: ${JSON.stringify(frame)}\n\n`);
    return true;
  };
  write(chunkFrame(id, model, created, { role: "assistant", content: "" }, null));

  if (decision.kind === "stall") {
    // Hold the turn open so the gateway abort path has something real to cancel.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, stallMs);
      const release = () => { clearTimeout(timer); resolve(); };
      response.on("close", release);
      response.on("error", release);
    });
    if (!response.writableEnded && !response.destroyed) response.end();
    return;
  }

  let completionTokens = 0;
  if (decision.kind === "tool_call") {
    const serialized = JSON.stringify(decision.call.arguments);
    completionTokens = Math.max(1, Math.ceil(serialized.length / 4));
    const callId = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    write(chunkFrame(id, model, created, {
      tool_calls: [{ index: 0, id: callId, type: "function", function: { name: decision.call.name, arguments: "" } }],
    }, null));
    for (const fragment of pieces(serialized, 3)) {
      if (chunkDelayMs > 0) await sleep(chunkDelayMs);
      write(chunkFrame(id, model, created, {
        tool_calls: [{ index: 0, function: { arguments: fragment } }],
      }, null));
    }
  } else {
    completionTokens = Math.max(1, Math.ceil(decision.text.length / 4));
    for (const fragment of pieces(decision.text, 3)) {
      if (chunkDelayMs > 0) await sleep(chunkDelayMs);
      write(chunkFrame(id, model, created, { content: fragment }, null));
    }
  }
  const finishReason = decision.kind === "tool_call" ? "tool_calls" : "stop";
  if (includeUsage) {
    write(chunkFrame(id, model, created, {}, finishReason, { usage: null }));
    write({ id, object: "chat.completion.chunk", created, model, choices: [], usage: usage(completionTokens) });
  } else {
    write(chunkFrame(id, model, created, {}, finishReason, { usage: usage(completionTokens) }));
  }
  if (!response.writableEnded && !response.destroyed) {
    response.write("data: [DONE]\n\n");
    response.end();
  }
}

async function jsonResponse(response, body, decision) {
  const id = `chatcmpl-${randomUUID()}`;
  const model = typeof body.model === "string" ? body.model : defaultModelId;
  const created = Math.floor(Date.now() / 1000);
  if (decision.kind === "stall") {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, stallMs);
      const release = () => { clearTimeout(timer); resolve(); };
      response.on("close", release);
      response.on("error", release);
    });
    if (!response.writableEnded && !response.destroyed) response.end();
    return;
  }
  const message = decision.kind === "tool_call"
    ? {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "function",
        function: { name: decision.call.name, arguments: JSON.stringify(decision.call.arguments) },
      }],
    }
    : { role: "assistant", content: decision.text };
  const completionTokens = Math.max(1, Math.ceil(
    (decision.kind === "tool_call" ? JSON.stringify(decision.call.arguments) : decision.text).length / 4,
  ));
  const payload = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: decision.kind === "tool_call" ? "tool_calls" : "stop" }],
    usage: usage(completionTokens),
  };
  const serialized = JSON.stringify(payload);
  response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(serialized) });
  response.end(serialized);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { reject(new Error("Request body is too large.")); request.destroy(); return; }
      parts.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    request.on("error", reject);
  });
}

let requestCount = 0;
const server = createServer(async (request, response) => {
  const started = Date.now();
  const sequence = (requestCount += 1);
  const url = new URL(request.url ?? "/", `http://${host}`);
  const raw = request.method === "POST" ? await readBody(request).catch(() => "") : "";
  let body = {};
  if (raw !== "") { try { body = JSON.parse(raw); } catch { body = {}; } }

  if (url.pathname === "/v1/models" || url.pathname === "/models") {
    const payload = JSON.stringify({
      object: "list",
      data: [{ id: defaultModelId, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "pnp-e2e" }],
    });
    log({ sequence, at: new Date().toISOString(), method: request.method, path: url.pathname,
      headers: redactHeaders(request.headers), authorization_present: request.headers.authorization !== undefined,
      response: "models" });
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    response.end(payload);
    return;
  }
  if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/chat/completions") {
    log({ sequence, at: new Date().toISOString(), method: request.method, path: url.pathname,
      headers: redactHeaders(request.headers), response: "not-found" });
    const payload = JSON.stringify({ error: { message: "Unknown route.", type: "invalid_request_error" } });
    response.writeHead(404, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    response.end(payload);
    return;
  }

  const decision = plan(body);
  const streaming = body.stream !== false;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  log({
    sequence,
    at: new Date().toISOString(),
    method: request.method,
    path: url.pathname,
    headers: redactHeaders(request.headers),
    authorization_present: request.headers.authorization !== undefined,
    model: body.model ?? null,
    stream: streaming,
    tool_names: tools.map((tool) => tool?.function?.name ?? null),
    message_roles: messages.map((message) => message?.role ?? null),
    user_texts: messages.filter((message) => message?.role === "user").map((message) => textOf(message.content).slice(0, 400)),
    scenario: decision.scenario,
    decision: decision.kind,
    tool_call: decision.kind === "tool_call" ? decision.call : null,
    started_at_ms: started,
  });

  try {
    if (streaming) await streamResponse(response, body, decision);
    else await jsonResponse(response, body, decision);
  } catch {
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
    if (!response.writableEnded) response.end(JSON.stringify({ error: { message: "Mock failure.", type: "server_error" } }));
  }
});

server.keepAliveTimeout = 5_000;
server.headersTimeout = 10_000;
server.requestTimeout = 0;
server.on("listening", () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ port: address.port, host: address.address })}\n`);
});
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
server.listen(port, host);
