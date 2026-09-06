#!/usr/bin/env node
// North-bound protocol client for the PNP end-to-end smoke test.
// Speaks only the documented gateway HTTP surface (docs/gateway-api-baseline.md)
// through global fetch: no gateway internals are imported.
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    workspace: { type: "string" },
    report: { type: "string" },
    "expect-tools": { type: "boolean" },
    marker: { type: "string" },
    "model-provider": { type: "string" },
    "model-id": { type: "string" },
    "ready-timeout-ms": { type: "string" },
    "prompt-timeout-ms": { type: "string" },
    "abort-attempts": { type: "string" },
    "abort-busy-timeout-ms": { type: "string" },
    "require-default-model": { type: "boolean" },
    "write-file-name": { type: "string" },
  },
});
const base = (values.base ?? "http://127.0.0.1:6217").replace(/\/$/, "");
const workspaceInput = values.workspace;
if (workspaceInput === undefined) throw new Error("--workspace is required.");
const reportPath = values.report;
const expectTools = values["expect-tools"] === true;
const marker = values.marker ?? (expectTools ? "E2E_HELLO_OK" : "E2E_HELLO");
const model = { providerID: values["model-provider"] ?? "e2e", modelID: values["model-id"] ?? "mock-1" };
const readyTimeoutMs = Number(values["ready-timeout-ms"] ?? 90_000);
const promptTimeoutMs = Number(values["prompt-timeout-ms"] ?? 180_000);
const abortAttempts = Math.max(1, Number(values["abort-attempts"] ?? (expectTools ? 1 : 6)));
const abortBusyTimeoutMs = Number(values["abort-busy-timeout-ms"] ?? 2_000);
const requireDefaultModel = values["require-default-model"] === true;
const writeFileName = values["write-file-name"] ?? "e2e-output.txt";
const writeFileBody = "hello-from-e2e";

await mkdir(workspaceInput, { recursive: true });
// The gateway canonicalises the directory, so assertions must use the same real path.
const workspace = await realpath(workspaceInput);

const steps = [];
let currentSessionId = null;
function record(name, status, evidence, startedAt) {
  const step = { name, status, duration_ms: Date.now() - startedAt, evidence };
  steps.push(step);
  const tag = { pass: "PASS", fail: "FAIL", warn: "WARN", skip: "SKIP" }[status];
  process.stdout.write(`[${tag}] ${name} (${step.duration_ms}ms)\n`);
  if (status !== "pass") process.stdout.write(`       ${JSON.stringify(evidence)}\n`);
  return step;
}
/** Runs one step; a thrown assertion is recorded as a failure and the suite continues. */
async function step(name, fn, { status = "fail" } = {}) {
  const startedAt = Date.now();
  const evidence = {};
  try {
    const outcome = await fn(evidence);
    if (outcome === "skip") return record(name, "skip", evidence, startedAt);
    if (outcome === "warn") return record(name, "warn", evidence, startedAt);
    return record(name, "pass", evidence, startedAt);
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    return record(name, status, evidence, startedAt);
  }
}
function assert(condition, message, detail) {
  if (!condition) {
    const error = new Error(message);
    if (detail !== undefined) error.message = `${message} :: ${JSON.stringify(detail).slice(0, 600)}`;
    throw error;
  }
}

async function call(method, route, { body, timeoutMs = 30_000, headers } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json;
  if (text !== "") { try { json = JSON.parse(text); } catch { json = undefined; } }
  return { status: response.status, json, text };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- SSE collector
const events = [];
const waiters = new Set();
const eventsController = new AbortController();
let eventStreamError = null;
function notice(event) {
  events.push(event);
  for (const waiter of [...waiters]) {
    if (waiter.predicate(event)) { waiters.delete(waiter); waiter.resolve(event); }
  }
}
function waitForEvent(predicate, timeoutMs) {
  const existing = events.find(predicate);
  if (existing !== undefined) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const waiter = { predicate, resolve };
    waiters.add(waiter);
    setTimeout(() => { waiters.delete(waiter); resolve(null); }, timeoutMs).unref?.();
  });
}
async function openEventStream() {
  const response = await fetch(`${base}/event`, {
    headers: { Accept: "text/event-stream" },
    signal: eventsController.signal,
  });
  if (response.status !== 200) throw new Error(`GET /event returned ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let id = null;
          const dataLines = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("id:")) id = line.slice(3).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length > 0) {
            try { notice({ id, ...JSON.parse(dataLines.join("\n")) }); } catch { /* Ignore an unparsable frame. */ }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!eventsController.signal.aborted) eventStreamError = String(error);
    }
  })();
  return response;
}

// ---------------------------------------------------------------- prompt helpers
function promptBody(text, withModel = true) {
  return { parts: [{ type: "text", text }], ...(withModel ? { model } : {}) };
}
async function messagesOf(sessionId) {
  const response = await call("GET", `/session/${sessionId}/message`);
  assert(response.status === 200, "GET /session/{id}/message must return 200", { status: response.status });
  assert(Array.isArray(response.json), "GET /session/{id}/message must return an array");
  return response.json;
}
function finalAssistant(messages) {
  return messages.length === 0 ? undefined : messages[messages.length - 1];
}
function summarise(messages) {
  return messages.map((message) => ({
    role: message.role,
    finish: message.info?.finish ?? null,
    tool_calls: (message.tool_calls ?? []).map((call) => call.name),
    part_types: (message.parts ?? []).map((part) => part.type),
    content: String(message.content ?? "").slice(0, 160),
  }));
}

/** Case 1 assertions, shared by the first and the second session. */
async function helloCase(label, sessionId, { probeDefaultModel }) {
  let defaultModelStatus = null;
  if (probeDefaultModel) {
    await step(`${label}/prompt-without-model`, async (evidence) => {
      const response = await call("POST", `/session/${sessionId}/prompt_async`,
        { body: promptBody("E2E_HELLO", false), timeoutMs: promptTimeoutMs });
      defaultModelStatus = response.status;
      evidence.status = response.status;
      evidence.body = response.json ?? response.text.slice(0, 200);
      if (response.status === 204) { evidence.default_model_resolution = "supported"; return "pass"; }
      // `model` is optional on the wire (PromptSchema) and the integration provider resolves the
      // omitted selection to its default; the driver must then see that binding, not a switch.
      evidence.default_model_resolution = "unsupported";
      assert(!requireDefaultModel, "prompt_async without model must return 204", { status: response.status, body: evidence.body });
      return "warn";
    });
  }
  if (defaultModelStatus !== 204) {
    await step(`${label}/prompt-hello`, async (evidence) => {
      const response = await call("POST", `/session/${sessionId}/prompt_async`,
        { body: promptBody("E2E_HELLO"), timeoutMs: promptTimeoutMs });
      evidence.status = response.status;
      evidence.body = response.json ?? response.text.slice(0, 200);
      assert(response.status === 204, "prompt_async must return 204", { status: response.status, body: evidence.body });
    });
  }
  await step(`${label}/hello-trace`, async (evidence) => {
    const messages = await messagesOf(sessionId);
    evidence.messages = summarise(messages);
    const last = finalAssistant(messages);
    assert(last !== undefined, "the session must have messages");
    assert(last.role === "assistant", "the last message must be an assistant message", { role: last.role });
    evidence.finish = last.info?.finish ?? null;
    assert(last.info?.finish === "stop", "the final assistant message must finish with stop", { info: last.info });
    const parts = last.parts ?? [];
    evidence.last_part = parts[parts.length - 1] ?? null;
    assert(parts.length > 0 && parts[parts.length - 1].type === "step-finish",
      "the final assistant message must end with a step-finish part", { parts });
    evidence.content = String(last.content ?? "").slice(0, 300);
    assert(String(last.content ?? "").includes(marker), `the final text must contain ${marker}`, { content: evidence.content });
  });
}

// ---------------------------------------------------------------- suite
const startedAt = new Date().toISOString();

await step("health-ready", async (evidence) => {
  const deadline = Date.now() + readyTimeoutMs;
  let last = null;
  for (;;) {
    try {
      const response = await call("GET", "/health/ready", { timeoutMs: 5_000 });
      last = { status: response.status, body: response.json };
      if (response.status === 200) { evidence.attempts_ms = readyTimeoutMs - (deadline - Date.now()); evidence.body = response.json; return; }
    } catch (error) { last = { error: String(error) }; }
    assert(Date.now() < deadline, "the gateway did not become ready", last);
    await sleep(250);
  }
});

await step("event-stream-open", async (evidence) => {
  await openEventStream();
  const connected = await waitForEvent((event) => event.type === "server.connected", 5_000);
  evidence.server_connected = connected !== null;
  assert(connected !== null, "the SSE stream must deliver server.connected");
});

await step("create-session", async (evidence) => {
  const response = await call("POST", "/session", { body: { directory: workspace, title: "pnp e2e smoke" } });
  evidence.status = response.status;
  evidence.body = response.json;
  assert(response.status === 200, "POST /session must return 200", { status: response.status, body: response.json });
  assert(typeof response.json?.id === "string", "POST /session must return an id", response.json);
  assert(response.json.status === "idle", "a new session must be idle", response.json);
  currentSessionId = response.json.id;
  evidence.session_id = currentSessionId;
});

if (currentSessionId !== null) {
  await helloCase("case1", currentSessionId, { probeDefaultModel: true });

  const writeTarget = path.join(workspace, writeFileName);
  await step("case2/write-file", async (evidence) => {
    if (!expectTools) { evidence.reason = "--expect-tools is off; this engine produces no tool trace."; return "skip"; }
    evidence.target = writeTarget;
    const response = await call("POST", `/session/${currentSessionId}/prompt_async`, {
      body: promptBody(`E2E_WRITE_FILE "${writeTarget}" ${writeFileBody}`),
      timeoutMs: promptTimeoutMs,
    });
    evidence.status = response.status;
    evidence.body = response.json ?? response.text.slice(0, 200);
    assert(response.status === 204, "prompt_async must return 204", { status: response.status, body: evidence.body });
    const messages = await messagesOf(currentSessionId);
    evidence.messages = summarise(messages);
    const toolCallMessage = messages.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
    assert(toolCallMessage !== undefined, "the trace must contain an assistant message carrying tool_calls");
    evidence.tool_calls = toolCallMessage.tool_calls.map((call) => call.name);
    const toolResult = messages.find((message) => message.role === "tool");
    assert(toolResult !== undefined, "the trace must contain a tool result message");
    evidence.tool_result_name = toolResult.tool_name ?? null;
    const last = finalAssistant(messages);
    assert(last?.info?.finish === "stop", "the final assistant message must finish with stop", { info: last?.info });
    const content = await readFile(writeTarget, "utf8");
    evidence.file_bytes = content.length;
    evidence.file_head = content.slice(0, 160);
    assert(content.includes(writeFileBody), `${writeFileName} must contain ${writeFileBody}`, { head: evidence.file_head });
  });

  await step("case3/abort", async (evidence) => {
    evidence.attempts = [];
    for (let attempt = 1; attempt <= abortAttempts; attempt += 1) {
      const attemptEvidence = { attempt };
      const before = events.length;
      const prompt = call("POST", `/session/${currentSessionId}/prompt_async`,
        { body: promptBody("E2E_STALL"), timeoutMs: promptTimeoutMs })
        .then((response) => ({ status: response.status, body: response.json ?? response.text.slice(0, 200) }))
        .catch((error) => ({ status: null, error: String(error) }));
      const busy = await waitForEvent((event) => event.type === "session.status"
        && event.properties?.sessionID === currentSessionId
        && event.properties?.status?.type === "busy"
        && events.indexOf(event) >= before, abortBusyTimeoutMs);
      attemptEvidence.saw_busy = busy !== null;
      const aborted = await call("POST", `/session/${currentSessionId}/abort`, { timeoutMs: 60_000 });
      attemptEvidence.abort_status = aborted.status;
      attemptEvidence.abort_body = aborted.json;
      attemptEvidence.prompt = await prompt;
      const messages = await messagesOf(currentSessionId);
      const last = finalAssistant(messages);
      attemptEvidence.finish = last?.info?.finish ?? null;
      attemptEvidence.native_finish = last?.info?.nativeFinish ?? null;
      const status = await call("GET", "/session/status");
      attemptEvidence.session_status = status.json?.[currentSessionId] ?? null;
      evidence.attempts.push(attemptEvidence);
      if (attemptEvidence.finish === "cancelled") {
        assert(aborted.status === 200, "POST /session/{id}/abort must return 200", { status: aborted.status });
        assert(aborted.json?.ok === true, "abort must answer {ok:true}", aborted.json);
        assert([204, 409].includes(attemptEvidence.prompt.status),
          "the aborted prompt_async must settle with 204 or 409", attemptEvidence.prompt);
        assert(status.json?.[currentSessionId]?.type === "idle",
          "the session must return to idle after abort", status.json);
        evidence.winning_attempt = attempt;
        return "pass";
      }
      assert(attemptEvidence.finish !== null, "the aborted run must produce a final message", attemptEvidence);
    }
    // The mock engine has a fixed ~10 ms turn and no stall hook, so the cancel window
    // may close before the abort lands. That is a property of the control engine, not
    // of the abort path, so it is only fatal where a stallable model is in the loop.
    evidence.reason = "no attempt observed finish=cancelled";
    assert(!expectTools, "the aborted run must record finish=cancelled", evidence);
    return "warn";
  });

  await step("question-and-permission", async (evidence) => {
    const question = await call("GET", "/question");
    const permission = await call("GET", "/permission");
    evidence.question = { status: question.status, count: Array.isArray(question.json) ? question.json.length : null };
    evidence.permission = { status: permission.status, count: Array.isArray(permission.json) ? permission.json.length : null };
    assert(question.status === 200 && Array.isArray(question.json), "GET /question must return an array", evidence.question);
    assert(permission.status === 200 && Array.isArray(permission.json), "GET /permission must return an array", evidence.permission);
  });

  await step("session-lifecycle", async (evidence) => {
    const detail = await call("GET", `/session/${currentSessionId}`);
    evidence.get = { status: detail.status, message_count: detail.json?.message_count ?? null };
    assert(detail.status === 200, "GET /session/{id} must return 200", evidence.get);
    assert(typeof detail.json?.message_count === "number" && detail.json.message_count > 0,
      "message_count must be greater than zero", evidence.get);
    const removed = await call("DELETE", `/session/${currentSessionId}`, { timeoutMs: 60_000 });
    evidence.delete = { status: removed.status, body: removed.json };
    assert(removed.status === 200, "DELETE /session/{id} must return 200", evidence.delete);
    const missing = await call("GET", `/session/${currentSessionId}`);
    evidence.after_delete = { status: missing.status, body: missing.json };
    assert(missing.status === 404, "a deleted session must return 404", evidence.after_delete);
  });
}

let secondSessionId = null;
await step("second-session/create", async (evidence) => {
  const response = await call("POST", "/session", { body: { directory: workspace, title: "pnp e2e smoke 2" } });
  evidence.status = response.status;
  evidence.body = response.json;
  assert(response.status === 200 && typeof response.json?.id === "string",
    "the second POST /session must return 200 with an id", { status: response.status, body: response.json });
  secondSessionId = response.json.id;
  assert(secondSessionId !== null, "the second session must have an id");
});
if (secondSessionId !== null) await helloCase("second-session", secondSessionId, { probeDefaultModel: false });

await step("event-sequence", async (evidence) => {
  const seen = [...new Set(events.map((event) => event.type))];
  evidence.event_types = seen;
  evidence.event_count = events.length;
  evidence.stream_error = eventStreamError;
  const required = ["server.connected", "session.status", "session.idle", "message.part.updated"];
  const missing = required.filter((type) => !seen.includes(type));
  evidence.missing = missing;
  assert(missing.length === 0, "the SSE stream must carry the baseline event types", { seen, missing });
});

eventsController.abort();

const failed = steps.filter((entry) => entry.status === "fail");
const report = {
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  base,
  workspace,
  model,
  expectations: { expect_tools: expectTools, marker, require_default_model: requireDefaultModel },
  totals: {
    total: steps.length,
    passed: steps.filter((entry) => entry.status === "pass").length,
    failed: failed.length,
    warned: steps.filter((entry) => entry.status === "warn").length,
    skipped: steps.filter((entry) => entry.status === "skip").length,
  },
  event_types: [...new Set(events.map((event) => event.type))],
  event_sequence: events.slice(0, 400).map((event) => event.type),
  steps,
  passed: failed.length === 0,
};
if (reportPath !== undefined) {
  await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
process.stdout.write(`\n${JSON.stringify(report.totals)}\n`);
process.exit(failed.length === 0 ? 0 : 1);
