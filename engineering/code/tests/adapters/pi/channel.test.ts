import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fingerprintPiTools, PiSessionChannel, policyInteraction, readEngineVersion } from "../../../src/drivers/pi-rpc/channel.ts";
import { resolveSessionPaths } from "../../../src/drivers/pi-rpc/launch.ts";
import { createFakeHostedProcess } from "./fixtures/fake-process.ts";
import type { DriverEvent, DriverServices, IntegrationContext, InteractionRequest, InteractionResponse, PromptRequest, ResolvedModel, ToolBinding } from "../../../src/contracts/index.ts";

// A real (temp) directory: `run()` writes this session's pi `models.json` under it on every
// model switch (`writePiModelsConfig`), so a placeholder non-existent path would fail those runs.
const sessionRoot = await mkdtemp(path.join(tmpdir(), "pnp-pi-channel-"));
const paths = resolveSessionPaths(sessionRoot);
const request: PromptRequest = { parts: [{ type: "text", text: "hello" }], model: { providerID: "test", modelID: "test" } };
const openedModel: ResolvedModel = { selection: request.model, protocol: "test", headers: {} };
function integration(overrides: Partial<IntegrationContext> = {}): IntegrationContext {
  return { model: openedModel, tools: [], assets: [],
    authorize: async () => ({ effect: "deny", reasonCode: "TEST" }), ...overrides };
}
function services(interactReply: InteractionResponse = { decision: "deny" }): { services: DriverServices; events: DriverEvent[]; interactRequests: InteractionRequest[] } {
  const events: DriverEvent[] = [];
  const interactRequests: InteractionRequest[] = [];
  return { events, interactRequests, services: {
    events: { emit: async (event) => { events.push(event); } },
    interact: async (request) => { interactRequests.push(request); return interactReply; },
  } };
}
function lastCommand(process: ReturnType<typeof createFakeHostedProcess>): { id: string; type: string } {
  return JSON.parse(process.writes.at(-1)!) as { id: string; type: string };
}
function ackLast(process: ReturnType<typeof createFakeHostedProcess>, command: string): void {
  const { id } = lastCommand(process);
  process.push(JSON.stringify({ type: "response", id, command, success: true, data: {} }));
}
/** `run()` now awaits real fs I/O (`writePiModelsConfig`) before sending `set_model`, so a
 * fixed sleep before asserting on the next write is racy under load; poll instead. */
async function waitForWriteCount(process: ReturnType<typeof createFakeHostedProcess>, count: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (process.writes.length < count) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${count} write(s); saw ${process.writes.length}.`);
    await sleep(2);
  }
}
async function waitForCondition(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await sleep(2);
  }
}
function noticeGate(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

test("a prompt ACK is not treated as run completion", async () => {
  const process = createFakeHostedProcess();
  const channel = new PiSessionChannel(process, paths, [], openedModel);
  const { services: svc } = services();
  const outcome = channel.run({ runId: "r1", request, integration: integration(), services: svc, signal: new AbortController().signal });
  await sleep(20);
  ackLast(process, "prompt"); // The `prompt` response arrives; run() must still be pending.
  let settled = false;
  void outcome.then(() => { settled = true; });
  await sleep(20);
  assert.equal(settled, false, "run() resolved on the prompt ACK instead of waiting for agent_settled");
  process.push(JSON.stringify({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "end_turn" }] }));
  process.push(JSON.stringify({ type: "agent_settled" }));
  const result = await outcome;
  assert.equal(result.state, "completed");
  assert.equal(result.finish, "stop");
  assert.equal(result.quiescent, true);
});

test("an abort ACK is not stop evidence; run() waits for the real settle event", async () => {
  const process = createFakeHostedProcess();
  const channel = new PiSessionChannel(process, paths, [], openedModel);
  const { services: svc } = services();
  const controller = new AbortController();
  const outcome = channel.run({ runId: "r1", request, integration: integration(), services: svc, signal: controller.signal });
  await sleep(10);
  ackLast(process, "prompt");
  await channel.cancel("user");
  ackLast(process, "abort"); // Abort is acknowledged...
  let settled = false;
  void outcome.then(() => { settled = true; });
  await sleep(20);
  assert.equal(settled, false, "run() resolved on the abort ACK instead of waiting for the real stop");
  process.push(JSON.stringify({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "cancelled" }] }));
  process.push(JSON.stringify({ type: "agent_settled" }));
  const result = await outcome;
  assert.equal(result.state, "cancelled");
  assert.equal(result.finish, "cancelled");
  assert.equal(result.quiescent, true);
});

test("tool calls collapse to a stable terminal state keyed by callId", async () => {
  const process = createFakeHostedProcess();
  const channel = new PiSessionChannel(process, paths, [], openedModel);
  const { services: svc, events } = services();
  const outcome = channel.run({ runId: "r1", request, integration: integration(), services: svc, signal: new AbortController().signal });
  await sleep(10);
  ackLast(process, "prompt");
  process.push(JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } }));
  process.push(JSON.stringify({ type: "tool_execution_update", toolCallId: "c1", title: "Running" }));
  process.push(JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { code: 0 }, isError: false }));
  process.push(JSON.stringify({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "end_turn" }] }));
  process.push(JSON.stringify({ type: "agent_settled" }));
  await outcome;
  const kinds = events.map((e) => e.type);
  assert.deepEqual(kinds, ["tool.started", "tool.updated", "tool.finished"]);
  assert.equal(events.some((e) => e.type === "tool.started" && e.callId === "c1"), true);
  assert.equal(events.some((e) => e.type === "tool.finished" && e.callId === "c1" && e.failed === false), true);
});

test("an out-of-order tool_execution_end for an unstarted callId fails the run instead of fabricating a result", async () => {
  const process = createFakeHostedProcess();
  const channel = new PiSessionChannel(process, paths, [], openedModel);
  const { services: svc } = services();
  const outcome = channel.run({ runId: "r1", request, integration: integration(), services: svc, signal: new AbortController().signal });
  await sleep(10);
  ackLast(process, "prompt");
  process.push(JSON.stringify({ type: "tool_execution_end", toolCallId: "ghost", toolName: "bash", result: {}, isError: false }));
  await assert.rejects(outcome, { code: "ENGINE_PROTOCOL_ERROR" });
});

test("reopening the same native data directory resumes rather than minting a new native id", () => {
  const a = new PiSessionChannel(createFakeHostedProcess(), paths, [], openedModel);
  const b = new PiSessionChannel(createFakeHostedProcess(), paths, [], openedModel);
  assert.equal(a.native.nativeId, paths.sessionFile);
  assert.equal(a.native.nativeId, b.native.nativeId);
  assert.equal(a.native.channelId, "rpc");
});

test("a different tool set on a later run is rejected explicitly instead of silently reused", async () => {
  const process = createFakeHostedProcess();
  const openedTools: ToolBinding[] = [];
  const channel = new PiSessionChannel(process, paths, openedTools, openedModel);
  const { services: svc } = services();
  const differentTools: ToolBinding[] = [{ id: "t1", transport: "cli", command: "/bin/true", args: [], env: {}, sideEffect: "read" }];
  await assert.rejects(channel.run({ runId: "r1", request, integration: integration({ tools: differentTools }), services: svc, signal: new AbortController().signal }),
    { code: "ENGINE_BINDINGS_CHANGED" });
});

test("unsupported command bindings emit one awaited sanitized notice before the first prompt only", async () => {
  const process = createFakeHostedProcess();
  // The bridge is an MCP client; cli/native command bindings are the transports it cannot carry.
  const tools: ToolBinding[] = [
    { id: "cli", transport: "cli", command: "/secret/cli", args: [], env: { TOKEN: "cli-secret" }, sideEffect: "read" },
    { id: "native", transport: "native", command: "/secret/native", args: [], env: { TOKEN: "native-secret" }, sideEffect: "external" },
  ];
  const channel = new PiSessionChannel(process, paths, tools, openedModel);
  const observed: string[] = [];
  const gate = noticeGate();
  const { services: svc, events } = services();
  svc.events.emit = async (event) => {
    observed.push(event.type === "native" ? event.eventName : event.type);
    events.push(event);
    await gate.promise;
  };

  const first = channel.run({ runId: "r1", request, integration: integration({ tools }), services: svc, signal: new AbortController().signal });
  await waitForCondition(() => observed.length === 1, "the deferred unsupported-transport notice");
  assert.equal(process.writes.length, 0, "prompt was submitted before the notice sink settled");
  await assert.rejects(channel.run({ runId: "concurrent", request, integration: integration({ tools }), services: svc, signal: new AbortController().signal }),
    { code: "SESSION_BUSY" });
  gate.resolve();
  await waitForWriteCount(process, 1);
  assert.deepEqual(observed, ["tools.unsupported-transport"]);
  assert.equal(lastCommand(process).type, "prompt");
  ackLast(process, "prompt");
  process.push(JSON.stringify({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "end_turn" }] }));
  process.push(JSON.stringify({ type: "agent_settled" }));
  await first;

  const second = channel.run({ runId: "r2", request, integration: integration({ tools }), services: svc, signal: new AbortController().signal });
  await waitForWriteCount(process, 2);
  ackLast(process, "prompt");
  process.push(JSON.stringify({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "end_turn" }] }));
  process.push(JSON.stringify({ type: "agent_settled" }));
  await second;
  assert.deepEqual(observed, ["tools.unsupported-transport"]);
  const notice = events[0];
  assert.equal(notice?.type, "native");
  assert.equal(JSON.stringify(notice).includes("secret"), false);
});

test("an unsupported-transport notice failure blocks the prompt", async () => {
  const process = createFakeHostedProcess();
  const tools: ToolBinding[] = [{ id: "cli", transport: "cli", command: "/bin/cli", args: [], env: {}, sideEffect: "read" }];
  const channel = new PiSessionChannel(process, paths, tools, openedModel);
  const gate = noticeGate();
  let noticeStarted = false;
  const { services: svc } = services();
  svc.events.emit = async () => { noticeStarted = true; await gate.promise; };
  const outcome = channel.run({ runId: "r1", request, integration: integration({ tools }), services: svc, signal: new AbortController().signal });
  await waitForCondition(() => noticeStarted, "the deferred failing notice");
  assert.equal(process.writes.length, 0);
  gate.reject(new Error("notice sink unavailable"));
  await assert.rejects(outcome, /notice sink unavailable/);
  assert.equal(process.writes.length, 0);
});

test("cancellation while the unsupported notice is pending returns cancelled without abort or prompt", async () => {
  const process = createFakeHostedProcess();
  const tools: ToolBinding[] = [{ id: "cli", transport: "cli", command: "/bin/cli", args: [], env: {}, sideEffect: "read" }];
  const channel = new PiSessionChannel(process, paths, tools, openedModel);
  const gate = noticeGate();
  let noticeStarted = false;
  const { services: svc } = services();
  svc.events.emit = async () => { noticeStarted = true; await gate.promise; };
  const outcome = channel.run({ runId: "r1", request, integration: integration({ tools }), services: svc, signal: new AbortController().signal });
  await waitForCondition(() => noticeStarted, "the pending notice before cancellation");
  await channel.cancel("user");
  assert.equal(process.writes.length, 0, "cancel during preflight sent an abort command");
  gate.resolve();
  const result = await outcome;
  assert.equal(result.state, "cancelled");
  assert.equal(result.nativeStopReason, "cancelled-before-prompt");
  assert.equal(process.writes.length, 0, "cancelled preflight later submitted a prompt");
});

test("an already-aborted run is cancelled before the notice or the prompt", async () => {
  const process = createFakeHostedProcess();
  const tools: ToolBinding[] = [{ id: "cli", transport: "cli", command: "/bin/cli", args: [], env: {}, sideEffect: "read" }];
  const channel = new PiSessionChannel(process, paths, tools, openedModel);
  let emitted = false;
  const { services: svc } = services();
  svc.events.emit = async () => { emitted = true; };
  const controller = new AbortController();
  controller.abort();
  const result = await channel.run({
    runId: "r1", request, integration: integration({ tools }), services: svc, signal: controller.signal,
  });
  assert.equal(result.state, "cancelled");
  assert.equal(emitted, false);
  assert.equal(process.writes.length, 0);
});

test("tool fingerprints cover every execution and credential field, including dropped transports", () => {
  const command: ToolBinding = {
    id: "tool", transport: "cli", command: "/bin/tool", args: ["one", "two"], env: { A: "alpha", TOKEN: "first" },
    sideEffect: "read", timeoutMs: 1000, inputSchema: { type: "object", properties: { b: { type: "number" }, a: { type: "string" } } },
  };
  const httpTool: ToolBinding = {
    id: "http", transport: "mcp-http", url: "https://one.invalid", headers: { Authorization: "Bearer one", Z: "last" },
    sideEffect: "external", timeoutMs: 2000, inputSchema: { type: "object" },
  };
  const base = fingerprintPiTools([command, httpTool]);
  const variants: ToolBinding[][] = [
    [{ ...command, id: "changed" }, httpTool],
    [{ ...command, transport: "native" }, httpTool],
    [{ ...command, sideEffect: "write" }, httpTool],
    [{ ...command, timeoutMs: 1001 }, httpTool],
    [{ ...command, inputSchema: { type: "array" } }, httpTool],
    [{ ...command, command: "/bin/other" }, httpTool],
    [{ ...command, args: ["two", "one"] }, httpTool],
    [{ ...command, env: { B: "alpha", TOKEN: "first" } }, httpTool],
    [{ ...command, env: { ...command.env, TOKEN: "rotated" } }, httpTool],
    [command, { ...httpTool, url: "https://two.invalid" }],
    [command, { ...httpTool, headers: { Authentication: "Bearer one", Z: "last" } }],
    [command, { ...httpTool, headers: { ...httpTool.headers, Authorization: "Bearer two" } }],
    [command, { ...httpTool, timeoutMs: 2001 }],
  ];
  for (const variant of variants) assert.notEqual(fingerprintPiTools(variant), base);
  const stdio: ToolBinding = { id: "stdio", transport: "mcp-stdio", command: "/bin/mcp", args: [], env: { TOKEN: "one" }, sideEffect: "read" };
  assert.notEqual(fingerprintPiTools([stdio]), fingerprintPiTools([{ ...stdio, env: { TOKEN: "two" } }]));
  assert.match(base, /^[a-f0-9]{64}$/);
});

test("tool fingerprints are stable across recursively reordered object keys and map entries", () => {
  const first: ToolBinding[] = [{
    id: "stable", transport: "cli", command: "/bin/tool", args: ["ordered"], env: { Z: "last", A: "first" },
    sideEffect: "read", inputSchema: { required: ["a"], properties: { b: { z: 1, a: 2 }, a: { type: "string" } }, type: "object" },
  }, {
    id: "http", transport: "mcp-http", url: "https://mcp.invalid", headers: { Z: "last", A: "first" }, sideEffect: "read",
  }];
  const reordered: ToolBinding[] = [{
    sideEffect: "read", inputSchema: { type: "object", properties: { a: { type: "string" }, b: { a: 2, z: 1 } }, required: ["a"] },
    env: { A: "first", Z: "last" }, args: ["ordered"], command: "/bin/tool", transport: "cli", id: "stable",
  }, {
    headers: { A: "first", Z: "last" }, url: "https://mcp.invalid", transport: "mcp-http", id: "http", sideEffect: "read",
  }];
  assert.equal(fingerprintPiTools(first), fingerprintPiTools(reordered));
});

test("a rotated tool credential is rejected before any prompt or config write", async () => {
  const isolatedPaths = resolveSessionPaths(await mkdtemp(path.join(tmpdir(), "pnp-pi-rotation-")));
  const process = createFakeHostedProcess();
  const opened: ToolBinding[] = [{ id: "tool", transport: "mcp-stdio", command: "/bin/tool", args: [], env: { TOKEN: "one" }, sideEffect: "read", timeoutMs: 1000 }];
  const rotated: ToolBinding[] = [{ ...opened[0]!, env: { TOKEN: "two" } }];
  const channel = new PiSessionChannel(process, isolatedPaths, opened, openedModel);
  const { services: svc } = services();
  await assert.rejects(channel.run({ runId: "r1", request, integration: integration({ tools: rotated }), services: svc, signal: new AbortController().signal }),
    { code: "ENGINE_BINDINGS_CHANGED" });
  assert.equal(process.writes.length, 0);
  await assert.rejects(access(isolatedPaths.modelsConfigFile), { code: "ENOENT" });
});

test("a model binding this process's environment was not built for is refused, never served with the old one", async () => {
  // `LaunchSpec.env` holds the values `models.json` refers to by name and is fixed when the
  // process starts, so `set_model` cannot make a new endpoint/credential work; the session is
  // refused instead of quietly answering with the model it was opened for.
  const process = createFakeHostedProcess();
  const channel = new PiSessionChannel(process, paths, [], openedModel);
  const { services: svc } = services();
  const rotated = { selection: request.model, protocol: "test" as const, headers: { Authorization: "Bearer rotated" } };
  await assert.rejects(channel.run({ runId: "r1", request, integration: integration({ model: rotated }), services: svc, signal: new AbortController().signal }),
    { code: "ENGINE_BINDINGS_CHANGED" });
  const switched = { selection: { providerID: "test", modelID: "other" }, protocol: "test" as const, headers: {} };
  await assert.rejects(channel.run({ runId: "r2", request, integration: integration({ model: switched }), services: svc, signal: new AbortController().signal }),
    { code: "ENGINE_BINDINGS_CHANGED" });
  assert.equal(process.writes.length, 0);
});

test("an unexpected process exit fails the run instead of reporting a fabricated success", async () => {
  const process = createFakeHostedProcess();
  const channel = new PiSessionChannel(process, paths, [], openedModel);
  const { services: svc } = services();
  const outcome = channel.run({ runId: "r1", request, integration: integration(), services: svc, signal: new AbortController().signal });
  await sleep(10);
  ackLast(process, "prompt");
  process.exit(1, null);
  await assert.rejects(outcome, { code: "ENGINE_UNAVAILABLE" });
  const evidence = await channel.terminate();
  assert.equal(evidence.quiescent, true); // The process was already gone; termination still returns real evidence.
});

test("model credentials never appear in an emitted native event or a thrown error message", async () => {
  const process = createFakeHostedProcess();
  const secretModel: ResolvedModel = { selection: request.model, protocol: "anthropic-messages", headers: { Authorization: "Bearer sk-live-DO-NOT-LEAK" } };
  const channel = new PiSessionChannel(process, paths, [], secretModel);
  const { services: svc, events } = services();
  const outcome = channel.run({ runId: "r1", request, integration: integration({ model: secretModel }), services: svc, signal: new AbortController().signal });
  await waitForWriteCount(process, 1);
  assert.equal(lastCommand(process).type, "prompt");
  ackLast(process, "prompt");
  process.push(JSON.stringify({ type: "extension_error", extensionPath: "x.ts", event: "tool_call", error: "boom" }));
  process.push(JSON.stringify({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "end_turn" }] }));
  process.push(JSON.stringify({ type: "agent_settled" }));
  await outcome;
  const serialized = JSON.stringify(events) + process.writes.join("\n") + JSON.stringify(channel.native);
  assert.equal(serialized.includes("sk-live-DO-NOT-LEAK"), false);
});

test("agent_end alone never settles a run; only agent_settled or the process exiting does", async () => {
  // Regression for the deleted 2-second fallback (docs/engineering-review-3.md section 16 F): it
  // resolved the run as `completed` whenever `agent_settled` was merely late, and a late
  // `agent_settled` then settled the *next* run early with empty text.
  const process = createFakeHostedProcess();
  const channel = new PiSessionChannel(process, paths, [], openedModel);
  const { services: svc } = services();
  const outcome = channel.run({ runId: "r1", request, integration: integration(), services: svc, signal: new AbortController().signal });
  await waitForWriteCount(process, 1);
  ackLast(process, "prompt");
  process.push(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } }));
  process.push(JSON.stringify({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "end_turn" }] }));
  let settled = false;
  void outcome.then(() => { settled = true; }, () => { settled = true; });
  await sleep(2_500); // Comfortably past the old fallback window.
  assert.equal(settled, false, "run() settled from agent_end instead of waiting for agent_settled");
  process.push(JSON.stringify({ type: "agent_settled" }));
  const result = await outcome;
  assert.equal(result.state, "completed");
  assert.equal(result.finalText, "partial");
});

test("a process that dies during the handshake fails open() instead of returning a usable channel", async () => {
  const process = createFakeHostedProcess();
  const channel = new PiSessionChannel(process, paths, [], openedModel);
  const handshake = channel.handshake();
  await waitForWriteCount(process, 1);
  assert.equal(lastCommand(process).type, "get_state");
  process.exit(9, "SIGKILL");
  await assert.rejects(handshake, (error: unknown) => {
    const failure = error as { code?: string; status?: number; message?: string };
    assert.equal(failure.code, "ENGINE_HANDSHAKE_FAILED");
    assert.equal(failure.status, 502);
    assert.match(failure.message ?? "", /code=9/);
    assert.match(failure.message ?? "", /signal=SIGKILL/);
    return true;
  });
});

test("a get_state a live process cannot answer is tolerated and leaves the version unknown", async () => {
  const process = createFakeHostedProcess();
  const channel = new PiSessionChannel(process, paths, [], openedModel);
  const handshake = channel.handshake();
  await waitForWriteCount(process, 1);
  const { id } = lastCommand(process);
  process.push(JSON.stringify({ type: "response", id, command: "get_state", success: false, error: "unknown command" }));
  await handshake; // Tolerated: a diagnostic, not a precondition.
  assert.equal(channel.native.engineVersion, "unknown");
  assert.match(channel.native.protocolVersion, /0\.85\.1, probed/);
});

test("a get_state answer that carries a version fills in native.engineVersion", async () => {
  const process = createFakeHostedProcess();
  const channel = new PiSessionChannel(process, paths, [], openedModel);
  const handshake = channel.handshake();
  await waitForWriteCount(process, 1);
  const { id } = lastCommand(process);
  process.push(JSON.stringify({ type: "response", id, command: "get_state", success: true, data: { version: "0.85.1", thinkingLevel: "medium" } }));
  await handshake;
  assert.equal(channel.native.engineVersion, "0.85.1");
  // Real 0.85.1 answers `get_state` without any version field at all (probed): unknown stays unknown.
  assert.equal(readEngineVersion({ model: { id: "x" }, messageCount: 0 }), undefined);
  assert.equal(readEngineVersion(null), undefined);
});

test("a pnp: confirm becomes an operation-scoped permission request; other confirms stay generic", async () => {
  assert.deepEqual(policyInteraction("pnp:shell", JSON.stringify({ tool: "bash", operation: "shell", patterns: ["rd /s C:\\data"] })), {
    kind: "permission", operation: "shell", payload: { patterns: ["rd /s C:\\data"], tool: "bash" },
  });
  assert.deepEqual(policyInteraction("pnp:external", "not json"), { kind: "permission", operation: "external", payload: { patterns: [], tool: "" } });
  assert.deepEqual(policyInteraction("Clear session?", "All messages will be lost."), {
    kind: "permission", operation: "pi.extension.confirm", payload: { title: "Clear session?", message: "All messages will be lost." },
  });
  assert.equal(policyInteraction("pnp:", "{}").operation, "pi.extension.confirm");
  assert.equal(policyInteraction(undefined, undefined).operation, "pi.extension.confirm");
});

test("the in-pi policy hook's confirm is authorized by the gateway and answered back over RPC", async () => {
  const process = createFakeHostedProcess();
  const channel = new PiSessionChannel(process, paths, [], openedModel);
  const { services: svc, interactRequests } = services({ decision: "deny", source: "policy" });
  const outcome = channel.run({ runId: "r1", request, integration: integration(), services: svc, signal: new AbortController().signal });
  await waitForWriteCount(process, 1);
  ackLast(process, "prompt");
  process.push(JSON.stringify({
    type: "extension_ui_request", id: "ui-1", method: "confirm", title: "pnp:write",
    message: JSON.stringify({ tool: "write", operation: "write", patterns: ["C:\\out\\report.docx"] }),
  }));
  await waitForWriteCount(process, 2);
  const reply = JSON.parse(process.writes.at(-1)!) as { type: string; id: string; confirmed: boolean };
  assert.equal(reply.type, "extension_ui_response");
  assert.equal(reply.id, "ui-1");
  assert.equal(reply.confirmed, false);
  assert.deepEqual(interactRequests, [{ kind: "permission", operation: "write", payload: { patterns: ["C:\\out\\report.docx"], tool: "write" } }]);
  process.push(JSON.stringify({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "end_turn" }] }));
  process.push(JSON.stringify({ type: "agent_settled" }));
  await outcome;
});
