import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fingerprintPiTools, PiSessionChannel } from "../../../src/drivers/pi-rpc/channel.ts";
import { resolveSessionPaths } from "../../../src/drivers/pi-rpc/launch.ts";
import { createFakeHostedProcess } from "./fixtures/fake-process.ts";
import type { DriverEvent, DriverServices, IntegrationContext, InteractionRequest, InteractionResponse, PromptRequest, ToolBinding } from "../../../src/contracts/index.ts";

// A real (temp) directory: `run()` writes this session's pi `models.json` under it on every
// model switch (`writePiModelsConfig`), so a placeholder non-existent path would fail those runs.
const sessionRoot = await mkdtemp(path.join(tmpdir(), "pnp-pi-channel-"));
const paths = resolveSessionPaths(sessionRoot);
const request: PromptRequest = { parts: [{ type: "text", text: "hello" }], model: { providerID: "test", modelID: "test" } };
function integration(overrides: Partial<IntegrationContext> = {}): IntegrationContext {
  return { model: { selection: request.model, protocol: "test", headers: {} }, tools: [], assets: [],
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
  const channel = new PiSessionChannel(process, paths, [], "test::test");
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
  const channel = new PiSessionChannel(process, paths, [], "test::test");
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
  const channel = new PiSessionChannel(process, paths, [], "test::test");
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
  const channel = new PiSessionChannel(process, paths, [], "test::test");
  const { services: svc } = services();
  const outcome = channel.run({ runId: "r1", request, integration: integration(), services: svc, signal: new AbortController().signal });
  await sleep(10);
  ackLast(process, "prompt");
  process.push(JSON.stringify({ type: "tool_execution_end", toolCallId: "ghost", toolName: "bash", result: {}, isError: false }));
  await assert.rejects(outcome, { code: "ENGINE_PROTOCOL_ERROR" });
});

test("reopening the same native data directory resumes rather than minting a new native id", () => {
  const a = new PiSessionChannel(createFakeHostedProcess(), paths, [], "test::test");
  const b = new PiSessionChannel(createFakeHostedProcess(), paths, [], "test::test");
  assert.equal(a.native.nativeId, paths.sessionFile);
  assert.equal(a.native.nativeId, b.native.nativeId);
  assert.equal(a.native.channelId, "rpc");
});

test("a different tool set on a later run is rejected explicitly instead of silently reused", async () => {
  const process = createFakeHostedProcess();
  const openedTools: ToolBinding[] = [];
  const channel = new PiSessionChannel(process, paths, openedTools, "test::test");
  const { services: svc } = services();
  const differentTools: ToolBinding[] = [{ id: "t1", transport: "cli", command: "/bin/true", args: [], env: {}, sideEffect: "read" }];
  await assert.rejects(channel.run({ runId: "r1", request, integration: integration({ tools: differentTools }), services: svc, signal: new AbortController().signal }),
    { code: "ENGINE_TOOLS_IMMUTABLE" });
});

test("unsupported MCP bindings emit one awaited sanitized notice before the first prompt only", async () => {
  const process = createFakeHostedProcess();
  const tools: ToolBinding[] = [
    { id: "stdio", transport: "mcp-stdio", command: "/secret/mcp", args: [], env: { TOKEN: "stdio-secret" }, sideEffect: "read" },
    { id: "http", transport: "mcp-http", url: "https://mcp.invalid", headers: { Authorization: "http-secret" }, sideEffect: "external" },
  ];
  const channel = new PiSessionChannel(process, paths, tools, "test::test");
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
  const tools: ToolBinding[] = [{ id: "http", transport: "mcp-http", url: "https://mcp.invalid", headers: {}, sideEffect: "read" }];
  const channel = new PiSessionChannel(process, paths, tools, "test::test");
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
  const tools: ToolBinding[] = [{ id: "http", transport: "mcp-http", url: "https://mcp.invalid", headers: {}, sideEffect: "read" }];
  const channel = new PiSessionChannel(process, paths, tools, "test::test");
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

test("an already-aborted run is cancelled before notice, model mutation, or prompt", async () => {
  const process = createFakeHostedProcess();
  const tools: ToolBinding[] = [{ id: "http", transport: "mcp-http", url: "https://mcp.invalid", headers: {}, sideEffect: "read" }];
  const channel = new PiSessionChannel(process, paths, tools, "test::old");
  let emitted = false;
  const { services: svc } = services();
  svc.events.emit = async () => { emitted = true; };
  const controller = new AbortController();
  controller.abort();
  const result = await channel.run({
    runId: "r1", request,
    integration: integration({ tools, model: { selection: { providerID: "test", modelID: "new" }, protocol: "openai-chat", headers: {} } }),
    services: svc, signal: controller.signal,
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

test("tool rotation is rejected before model mutation, config write, or prompt", async () => {
  const isolatedPaths = resolveSessionPaths(await mkdtemp(path.join(tmpdir(), "pnp-pi-rotation-")));
  const process = createFakeHostedProcess();
  const opened: ToolBinding[] = [{ id: "tool", transport: "cli", command: "/bin/tool", args: [], env: { TOKEN: "one" }, sideEffect: "read", timeoutMs: 1000 }];
  const rotated: ToolBinding[] = [{ ...opened[0]!, env: { TOKEN: "two" } }];
  const channel = new PiSessionChannel(process, isolatedPaths, opened, "test::old");
  const { services: svc } = services();
  const changedModel = integration({ tools: rotated, model: { selection: { providerID: "test", modelID: "new" }, protocol: "openai-chat", headers: {} } });
  await assert.rejects(channel.run({ runId: "r1", request, integration: changedModel, services: svc, signal: new AbortController().signal }),
    { code: "ENGINE_TOOLS_IMMUTABLE" });
  assert.equal(process.writes.length, 0);
  await assert.rejects(access(isolatedPaths.modelsConfigFile), { code: "ENOENT" });
});

test("an unexpected process exit fails the run instead of reporting a fabricated success", async () => {
  const process = createFakeHostedProcess();
  const channel = new PiSessionChannel(process, paths, [], "test::test");
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
  const channel = new PiSessionChannel(process, paths, [], "test::initial-model");
  const { services: svc, events } = services();
  const secretIntegration = integration({ model: { selection: { providerID: "test", modelID: "secret-model" }, protocol: "anthropic-messages", headers: { authorization: "Bearer sk-live-DO-NOT-LEAK" } } });
  const outcome = channel.run({ runId: "r1", request, integration: secretIntegration, services: svc, signal: new AbortController().signal });
  await waitForWriteCount(process, 1);
  const setModel = lastCommand(process);
  assert.equal(setModel.type, "set_model");
  ackLast(process, "set_model");
  await sleep(5);
  ackLast(process, "prompt");
  process.push(JSON.stringify({ type: "extension_error", extensionPath: "x.ts", event: "tool_call", error: "boom" }));
  process.push(JSON.stringify({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "end_turn" }] }));
  process.push(JSON.stringify({ type: "agent_settled" }));
  await outcome;
  const serialized = JSON.stringify(events) + process.writes.join("\n");
  assert.equal(serialized.includes("sk-live-DO-NOT-LEAK"), false);
});
