#!/usr/bin/env node
// North-bound protocol client for the PNP end-to-end smoke test.
// Speaks only the documented gateway HTTP surface (docs/gateway-api-baseline.md)
// through global fetch: no gateway internals are imported.
import { mkdir, readFile, stat, writeFile, realpath } from "node:fs/promises";
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
    "reject-file-name": { type: "string" },
    "permission-timeout-ms": { type: "string" },
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
const rejectFileName = values["reject-file-name"] ?? "e2e-rejected.txt";
// The gateway denies an unanswered interaction after its own timeout (45 s by default), so a budget
// longer than that would only be spent waiting for a request that has already been taken away.
const permissionTimeoutMs = Number(values["permission-timeout-ms"] ?? 60_000);
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
function promptBody(text, withModel = true, extra = {}) {
  return { parts: [{ type: "text", text }], ...(withModel ? { model } : {}), ...extra };
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

// ---------------------------------------------------------------- the evaluator's permission loop
/**
 * A request whose settlement can be read without awaiting it. `prompt_async` only answers when the run
 * ends, and a run blocked on a permission cannot end until that permission is answered: awaiting the
 * prompt first would deadlock the very loop this exercises.
 */
function inFlight(promise) {
  const state = { outcome: undefined };
  const tracked = promise.then((value) => { state.outcome = value; return value; });
  return { promise: tracked, outcome: () => state.outcome };
}
function promptAsync(sessionId, text, extra = {}) {
  return inFlight(call("POST", `/session/${sessionId}/prompt_async`, { body: promptBody(text, true, extra), timeoutMs: promptTimeoutMs })
    .then((response) => ({ status: response.status, body: response.json ?? response.text.slice(0, 200) }))
    .catch((error) => ({ status: null, error: String(error) })));
}
async function listPermissions() {
  const response = await call("GET", "/permission", { timeoutMs: 15_000 });
  assert(response.status === 200 && Array.isArray(response.json),
    "GET /permission must return 200 with an array", { status: response.status, body: response.text.slice(0, 200) });
  return response.json;
}
/** Everything an approver would decide on, small enough to keep in the report. */
function permissionEvidence(entry) {
  const content = Array.isArray(entry.content) ? entry.content : [];
  const diffs = content.filter((part) => part !== null && typeof part === "object" && part.type === "diff");
  return {
    id: entry.id ?? null,
    session_id: entry.sessionID ?? null,
    permission: entry.permission ?? null,
    // The specification's permission object carries the paths the request is about; it is always
    // present, so an entry without the key is a contract failure and not merely "no paths named".
    patterns: Array.isArray(entry.patterns) ? entry.patterns : null,
    title: entry.title ?? null,
    name: entry.name ?? null,
    kind: entry.kind ?? null,
    content_types: content.map((part) => part?.type ?? null),
    diff_paths: diffs.map((part) => part.path ?? null),
    diff_new_text: diffs.map((part) => String(part.newText ?? "").slice(0, 80)),
    locations: Array.isArray(entry.locations) ? entry.locations.map((location) => location?.path ?? null) : null,
    raw_input_keys: entry.rawInput !== null && typeof entry.rawInput === "object" ? Object.keys(entry.rawInput) : null,
    option_kinds: Array.isArray(entry.options) ? entry.options.map((option) => option?.kind ?? null) : null,
  };
}
/** Polls GET /permission exactly as the evaluator does, until this session has a pending request. */
async function waitForPermission(sessionId, budgetMs, outcome) {
  const startedAt = Date.now();
  let polls = 0;
  for (;;) {
    polls += 1;
    const entries = await listPermissions();
    const entry = entries.find((candidate) => candidate.sessionID === sessionId);
    if (entry !== undefined) return { entry, polls, waited_ms: Date.now() - startedAt };
    // A run that already finished will never ask; report that instead of spending the whole budget.
    assert(outcome === undefined || outcome() === undefined,
      "the run ended without ever asking for permission", { polls, prompt: outcome?.() });
    assert(Date.now() - startedAt < budgetMs, "no permission request appeared for this session",
      { polls, waited_ms: Date.now() - startedAt, pending: entries.length });
    await sleep(250);
  }
}
async function replyPermission(id, reply) {
  const response = await call("POST", `/permission/${id}/reply`, { body: { reply }, timeoutMs: 30_000 });
  return { reply, status: response.status, body: response.json ?? response.text.slice(0, 200) };
}
/**
 * Waits for the run to end, answering every further permission it raises the same way — an unattended
 * evaluator answers what it finds rather than assuming how many requests an engine makes.
 */
async function settleAnswering(prompt, sessionId, reply, answered, limit = 6) {
  while (prompt.outcome() === undefined && answered.length < limit) {
    for (const entry of await listPermissions()) {
      if (entry.sessionID !== sessionId) continue;
      answered.push({ ...permissionEvidence(entry), ...(await replyPermission(entry.id, reply)) });
    }
    if (prompt.outcome() !== undefined) break;
    await sleep(250);
  }
  return prompt.promise;
}
/** True only for a directory that is really there. */
async function isDirectory(target) {
  try { return (await stat(target)).isDirectory(); }
  catch { return false; }
}
/** Reports a file without pretending an unreadable one is an absent one. */
async function describeFile(target) {
  try {
    const content = await readFile(target, "utf8");
    return { exists: true, bytes: content.length, head: content.slice(0, 160) };
  } catch (error) {
    return { exists: false, error_code: String(error?.code ?? error) };
  }
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
  // The unknown `trace_id` is the evaluator's own; an inbound body must ignore what it does not know.
  const body = { directory: workspace, title: "pnp e2e smoke", trace_id: "e2e-trace-session" };
  const response = await call("POST", "/session", { body });
  evidence.unknown_fields_sent = ["trace_id"];
  evidence.status = response.status;
  evidence.body = response.json;
  assert(response.status === 200, "POST /session must return 200", { status: response.status, body: response.json });
  assert(typeof response.json?.id === "string", "POST /session must return an id", response.json);
  assert(response.json.status === "idle", "a new session must be idle", response.json);
  currentSessionId = response.json.id;
  evidence.session_id = currentSessionId;
});

await step("create-session-missing-directory", async (evidence) => {
  // The assessment names a working directory; it never promises to have created it first. A round
  // that fails at POST /session over a missing folder is a round that produces no trajectory.
  const target = path.join(workspace, `created-by-gateway-${Date.now()}`);
  evidence.target = target;
  evidence.existed_before = await isDirectory(target);
  assert(evidence.existed_before === false, "the fixture directory must not exist yet", { target });
  const response = await call("POST", "/session", { body: { directory: target, title: "pnp e2e fresh directory" } });
  evidence.status = response.status;
  evidence.body = response.json;
  assert(response.status === 200 && typeof response.json?.id === "string",
    "POST /session must accept a directory that does not exist yet", { status: response.status, body: response.json });
  evidence.exists_after = await isDirectory(target);
  assert(evidence.exists_after, "the gateway must create the working directory it was given", { target });
  // Deleting the session clears gateway and native state only: the working directory is the user's.
  const removed = await call("DELETE", `/session/${response.json.id}`, { timeoutMs: 60_000 });
  evidence.delete = { status: removed.status, body: removed.json };
  assert(removed.status === 200, "DELETE /session/{id} must return 200", evidence.delete);
  evidence.exists_after_delete = await isDirectory(target);
  assert(evidence.exists_after_delete, "deleting a session must not remove its working directory", { target });
});

if (currentSessionId !== null) {
  await helloCase("case1", currentSessionId, { probeDefaultModel: true });

  const writeTarget = path.join(workspace, writeFileName);
  const rejectTarget = path.join(workspace, rejectFileName);
  await step("case2/write-file", async (evidence) => {
    if (!expectTools) { evidence.reason = "--expect-tools is off; this engine produces no tool trace."; return "skip"; }
    evidence.target = writeTarget;
    // 1. Send and do NOT await: this is the evaluator's own shape, and the run cannot finish before the
    //    permission it raises has been answered.
    const prompt = promptAsync(currentSessionId, `E2E_WRITE_FILE "${writeTarget}" ${writeFileBody}`);
    // 2. Find the request the same way the evaluator does.
    const asked = await waitForPermission(currentSessionId, permissionTimeoutMs, prompt.outcome);
    evidence.permission = { ...permissionEvidence(asked.entry), polls: asked.polls, waited_ms: asked.waited_ms };
    assert(typeof asked.entry.id === "string" && asked.entry.id !== "",
      "a pending permission must carry the id the reply is addressed to", evidence.permission);
    assert(asked.entry.sessionID === currentSessionId,
      "the pending permission must name the session it belongs to", evidence.permission);
    // The operation is the key a policy is written against. A per-file title here (which is all the ACP
    // request carries for an opencode edit) would match no configured operation at all.
    assert(asked.entry.permission === "write",
      "the permission must be keyed on the tool name, not on the file being written", evidence.permission);
    const named = [...evidence.permission.diff_paths, ...(evidence.permission.locations ?? []), evidence.permission.title];
    evidence.permission.names_target = named.some((value) => typeof value === "string" && value.includes(writeFileName));
    assert(evidence.permission.names_target,
      "the payload must tell the approver which file is being written", evidence.permission);
    // `patterns` is the specification's own field for that target, and it is read off what the engine
    // asked for. It must be there, and it must name the file this prompt asked to write.
    assert(Array.isArray(evidence.permission.patterns),
      "the permission object must carry patterns", evidence.permission);
    evidence.permission.patterns_exact_target = evidence.permission.patterns.includes(writeTarget);
    assert(evidence.permission.patterns.some((value) => typeof value === "string" && value.includes(writeFileName)),
      "the permission patterns must name the file being written", evidence.permission);
    // The published request carries the same field, so a subscriber learns the target without polling.
    const askedEvent = await waitForEvent((event) => event.type === "permission.asked"
      && event.properties?.id === asked.entry.id, 10_000);
    evidence.permission.event = askedEvent === null ? null : {
      permission: askedEvent.properties?.permission ?? null,
      patterns: Array.isArray(askedEvent.properties?.patterns) ? askedEvent.properties.patterns : null,
    };
    assert(evidence.permission.event !== null,
      "the pending permission must have been published as permission.asked", { id: asked.entry.id });
    assert(Array.isArray(evidence.permission.event.patterns)
      && evidence.permission.event.patterns.some((value) => typeof value === "string" && value.includes(writeFileName)),
      "the permission.asked event must carry the same patterns", evidence.permission.event);
    // 3. Answer once, and prove a repeated answer cannot pass for a second approval.
    const once = await replyPermission(asked.entry.id, "once");
    evidence.reply = once;
    assert(once.status === 200, "POST /permission/{id}/reply must return 200", once);
    assert(once.body?.ok === true, "the reply must answer {ok:true}", once);
    const repeated = await replyPermission(asked.entry.id, "once");
    evidence.repeated_reply = repeated;
    assert([404, 409].includes(repeated.status),
      "replying twice to the same permission must not silently succeed", repeated);
    // 4. Only now can the run end.
    evidence.further_permissions = [];
    evidence.prompt = await settleAnswering(prompt, currentSessionId, "once", evidence.further_permissions);
    assert(evidence.prompt.status === 204, "prompt_async must settle with 204", evidence.prompt);
    const messages = await messagesOf(currentSessionId);
    evidence.messages = summarise(messages);
    const toolCallMessage = messages.find((message) => message.role === "assistant"
      && Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
    const observations = messages.flatMap((message) => Array.isArray(message.parts)
      ? message.parts.filter((part) => part?.type === "tool") : []);
    assert(observations.length > 0, "the trace must preserve the engine's tool observations");
    evidence.tool_observations = observations.map((part) => ({
      call_id: part.callID ?? null,
      tool: part.tool ?? null,
      phase: part.phase ?? null,
      status: part.state?.status ?? null,
      name_source: part.state?.nameSource ?? null,
      state_title: part.state?.title ?? null,
      terminal_status: part.state?.terminalStatus ?? null,
      input_keys: part.input !== null && typeof part.input === "object" ? Object.keys(part.input) : null,
    }));
    assert(observations.some((part) => part.input?.filepath === writeTarget || part.input?.filePath === writeTarget),
      "the observed tool input must preserve the exact file target", evidence.tool_observations);
    assert(observations.some((part) => ["completed", "failed"].includes(part.state?.status)),
      "the observed tool trajectory must reach an engine-reported terminal state", evidence.tool_observations);

    // opencode announces this call with `title: "write"` and no programmatic `name`; the announced title
    // is the engine's own label for the call, so it is the canonical identity and its provenance is
    // recorded. The trajectory therefore carries the reference shape a judge reads, without inventing
    // anything: a call named by a later title, or a result the engine never produced.
    const identified = observations.filter((part) => typeof part.tool === "string");
    evidence.name_sources = [...new Set(identified.map((part) => part.state?.nameSource ?? null))];
    assert(identified.length > 0, "a canonical observation must carry the tool it belongs to", evidence.tool_observations);
    assert(evidence.name_sources.every((source) => source === "name" || source === "announced-title"),
      "every canonical observation must record where its name came from", evidence.name_sources);
    assert(identified.some((part) => typeof part.state?.title === "string"),
      "the observation must mirror the engine's title into the spec-shaped state", evidence.tool_observations);
    assert(toolCallMessage !== undefined, "the engine's announced call must be recorded as a canonical tool call",
      evidence.messages);
    evidence.tool_calls = toolCallMessage.tool_calls.map((call) => call.name);
    evidence.tool_call_finish = toolCallMessage.info?.finish ?? null;
    assert(evidence.tool_call_finish === "tool-calls",
      "the canonical tool-calling assistant message must finish with tool-calls", { info: toolCallMessage.info });
    assert(evidence.tool_calls.includes("write"), "the canonical recorded tool call must be write", evidence.tool_calls);
    const toolResult = messages.find((message) => message.role === "tool");
    assert(toolResult !== undefined, "a canonical tool call must have a tool result message");
    evidence.tool_result_name = toolResult.tool_name ?? null;
    assert(evidence.tool_result_name === "write", "the tool result must name the tool that ran", evidence.tool_result_name);
    const last = finalAssistant(messages);
    assert(last?.info?.finish === "stop", "the final assistant message must finish with stop", { info: last?.info });
    const content = await readFile(writeTarget, "utf8");
    evidence.file_bytes = content.length;
    evidence.file_head = content.slice(0, 160);
    assert(content.includes(writeFileBody), `${writeFileName} must contain ${writeFileBody}`, { head: evidence.file_head });
  });

  await step("case2b/permission-rejected", async (evidence) => {
    if (!expectTools) { evidence.reason = "--expect-tools is off; this engine raises no permission."; return "skip"; }
    evidence.target = rejectTarget;
    const prompt = promptAsync(currentSessionId, `E2E_WRITE_FILE "${rejectTarget}" ${writeFileBody}`);
    const asked = await waitForPermission(currentSessionId, permissionTimeoutMs, prompt.outcome);
    evidence.permission = { ...permissionEvidence(asked.entry), polls: asked.polls, waited_ms: asked.waited_ms };
    assert(asked.entry.permission === "write",
      "the second write must be keyed on the same operation", evidence.permission);
    const rejected = await replyPermission(asked.entry.id, "reject");
    evidence.reply = rejected;
    assert(rejected.status === 200 && rejected.body?.ok === true, "a rejection must be accepted", rejected);
    // A refused tool is not a gateway failure. Whatever the run then reports is recorded as observed;
    // only the two things that must hold either way are asserted: nothing was written, and the session
    // is usable again.
    evidence.further_permissions = [];
    evidence.prompt = await settleAnswering(prompt, currentSessionId, "reject", evidence.further_permissions);
    assert(evidence.prompt.status !== null, "the refused run must settle rather than hang", evidence.prompt);
    const messages = await messagesOf(currentSessionId);
    evidence.messages = summarise(messages);
    evidence.final_finish = finalAssistant(messages)?.info?.finish ?? null;
    evidence.file = await describeFile(rejectTarget);
    assert(evidence.file.exists === false, "a rejected write must not appear on disk", evidence.file);
    assert(evidence.file.error_code === "ENOENT", "the target must be absent, not merely unreadable", evidence.file);
    const status = await call("GET", "/session/status");
    evidence.session_status = status.json?.[currentSessionId] ?? null;
    assert(status.json?.[currentSessionId]?.type === "idle",
      "the session must return to idle after a refused tool", evidence.session_status);
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
    // Every request raised above was answered, and no run is in flight: a leftover entry here would be a
    // request nobody can ever settle.
    evidence.pending = permission.json;
    assert(permission.json.length === 0, "no permission request may be left pending", evidence.pending);
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

// ---------------------------------------------------------------- the evaluator's concurrency
// One case per Agent is a shape the assessment is free to use, so two sessions may hold a prompt at
// the same moment. The gateway serialises them on its single execution slot: both are accepted and
// the second waits, rather than the second failing at the HTTP layer with no trajectory at all.
let queueSessionA = null;
let queueSessionB = null;
await step("concurrency/create-sessions", async (evidence) => {
  const created = [];
  for (const title of ["pnp e2e queue a", "pnp e2e queue b"]) {
    const response = await call("POST", "/session", { body: { directory: workspace, title } });
    assert(response.status === 200 && typeof response.json?.id === "string",
      "POST /session must return 200 with an id", { status: response.status, body: response.json });
    created.push(response.json.id);
  }
  queueSessionA = created[0];
  queueSessionB = created[1];
  evidence.sessions = created;
});
if (queueSessionA !== null && queueSessionB !== null) {
  await step("concurrency/cross-session-queue", async (evidence) => {
    // Both are in flight before either can finish. The first also carries fields the gateway does
    // not define, at the top level and inside `model`: they are ignored, never a 400.
    const unknownFields = { mode: "task", trace_id: "e2e-trace-prompt", model: { ...model, trace_id: "e2e-trace-model" } };
    evidence.unknown_fields_sent = unknownFields;
    const first = promptAsync(queueSessionA, "E2E_HELLO", unknownFields);
    const second = promptAsync(queueSessionB, "E2E_HELLO");
    const busyObservations = [];
    let concurrentlyBusy = null;
    let maxQueued = 0;
    const deadline = Date.now() + promptTimeoutMs;
    while ((first.outcome() === undefined || second.outcome() === undefined) && Date.now() < deadline) {
      const status = await call("GET", "/session/status", { timeoutMs: 15_000 });
      const busy = Object.entries(status.json ?? {})
        .filter(([id, value]) => value?.type === "busy" && (id === queueSessionA || id === queueSessionB))
        .map(([id]) => id);
      if (busy.length > 0) busyObservations.push(busy);
      if (busy.length > 1 && concurrentlyBusy === null) concurrentlyBusy = busy;
      const diagnostics = await call("GET", "/diagnostics", { timeoutMs: 15_000 });
      maxQueued = Math.max(maxQueued, Number(diagnostics.json?.queued?.count ?? 0));
      await sleep(150);
    }
    evidence.first = await first.promise;
    evidence.second = await second.promise;
    evidence.busy_polls = busyObservations.length;
    evidence.busy_observations = busyObservations.slice(0, 40);
    evidence.max_queued_observed = maxQueued;
    assert(evidence.first.status === 204, "the first concurrent prompt_async must return 204", evidence.first);
    assert(evidence.second.status === 204,
      "a prompt on a second session must queue and return 204, not 409", evidence.second);
    // The single execution slot is the contract; a poll that ever saw both busy would disprove it.
    assert(concurrentlyBusy === null, "two sessions must never be busy at the same moment",
      { concurrently_busy: concurrentlyBusy, observations: evidence.busy_observations });
    const statuses = await call("GET", "/session/status");
    evidence.final_status = [queueSessionA, queueSessionB].map((id) => statuses.json?.[id]?.type ?? null);
    assert(evidence.final_status.every((type) => type === "idle"), "both sessions must end idle", evidence.final_status);
    // Both really ran: a queued request that was quietly dropped would leave no trajectory.
    evidence.finishes = [];
    for (const id of [queueSessionA, queueSessionB]) {
      const last = finalAssistant(await messagesOf(id));
      evidence.finishes.push(last?.info?.finish ?? null);
    }
    assert(evidence.finishes.every((finish) => finish === "stop"),
      "both queued turns must end with a committed final assistant message", evidence.finishes);
  });

  await step("concurrency/same-session-busy", async (evidence) => {
    if (expectTools) {
      evidence.reason = "asserted on the mock leg; a real engine turn would cost a full run per burst.";
      return "skip";
    }
    // A second prompt for a session that already has one is refused immediately, and the code says
    // which limit was hit: SESSION_BUSY is per session, GATEWAY_BUSY only ever means a full queue.
    evidence.attempts = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const burst = [];
      for (let i = 0; i < 4; i += 1) burst.push(promptAsync(queueSessionA, "E2E_HELLO"));
      const settled = await Promise.all(burst.map((entry) => entry.promise));
      const record = settled.map((response) => ({ status: response.status, code: response.body?.code ?? null }));
      evidence.attempts.push(record);
      const refused = settled.filter((response) => response.status === 409);
      if (refused.length === 0) continue;
      assert(settled.some((response) => response.status === 204),
        "one of the concurrent same-session prompts must be accepted", record);
      assert(refused.every((response) => response.body?.code === "SESSION_BUSY"),
        "a same-session conflict must answer SESSION_BUSY, never GATEWAY_BUSY", record);
      evidence.winning_attempt = attempt;
      return "pass";
    }
    assert(false, "no same-session conflict was observed in three concurrent bursts", evidence.attempts);
  });
}

await step("event-sequence", async (evidence) => {
  const seen = [...new Set(events.map((event) => event.type))];
  evidence.event_types = seen;
  evidence.event_count = events.length;
  evidence.stream_error = eventStreamError;
  // The permission pair is required exactly where a permission was driven: the mock engine raises none.
  const required = ["server.connected", "session.status", "session.idle", "message.part.updated",
    ...(expectTools ? ["permission.asked", "permission.resolved"] : [])];
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
