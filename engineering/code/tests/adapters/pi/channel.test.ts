import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { PiSessionChannel } from "../../../src/drivers/pi-rpc/channel.ts";
import type { PiSessionPaths } from "../../../src/drivers/pi-rpc/launch.ts";
import { createFakeHostedProcess } from "./fixtures/fake-process.ts";
import type { DriverEvent, DriverServices, IntegrationContext, InteractionRequest, InteractionResponse, PromptRequest, ToolBinding } from "../../../src/contracts/index.ts";

const paths: PiSessionPaths = { sessionDir: "/tmp/pnp-pi-test", sessionFile: "/tmp/pnp-pi-test/session.jsonl",
  toolsFile: "/tmp/pnp-pi-test/pnp-tools.json", extensionFile: "/tmp/pnp-pi-test/pnp-tool-bridge.mjs" };
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
  process.push(JSON.stringify({ type: "agent_end", willRetry: false, stopReason: "end_turn" }));
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
  process.push(JSON.stringify({ type: "agent_end", willRetry: false, stopReason: "cancelled" }));
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
  process.push(JSON.stringify({ type: "agent_end", willRetry: false, stopReason: "end_turn" }));
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
  await sleep(10);
  const setModel = lastCommand(process);
  assert.equal(setModel.type, "set_model");
  ackLast(process, "set_model");
  await sleep(5);
  ackLast(process, "prompt");
  process.push(JSON.stringify({ type: "extension_error", extensionPath: "x.ts", event: "tool_call", error: "boom" }));
  process.push(JSON.stringify({ type: "agent_end", willRetry: false, stopReason: "end_turn" }));
  process.push(JSON.stringify({ type: "agent_settled" }));
  await outcome;
  const serialized = JSON.stringify(events) + process.writes.join("\n");
  assert.equal(serialized.includes("sk-live-DO-NOT-LEAK"), false);
});
