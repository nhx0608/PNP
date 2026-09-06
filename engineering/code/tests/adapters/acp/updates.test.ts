import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_METHODS } from "@agentclientprotocol/sdk";
import type { FakeAgent } from "../../kit/fake-host.ts";
import { openAcpChannel } from "../../../src/drivers/acp/channel.ts";
import { SessionUpdateMapper } from "../../../src/drivers/acp/updates.ts";
import { definition, harness, nativePayload, RecordingServices, runTurn } from "./harness.ts";
import { baseScript, NATIVE_SESSION, promptResponse, update } from "./script.ts";

/** Opens a channel, runs one turn while the engine emits the scripted updates, and returns what was emitted. */
async function turnWith(script: (agent: FakeAgent) => void | Promise<void>, options: {
  stopReason?: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
  usage?: { totalTokens: number; inputTokens: number; outputTokens: number };
} = {}): Promise<{ services: RecordingServices; result: Awaited<ReturnType<typeof runTurn>>; agent: FakeAgent }> {
  const fixture = harness({
    handlers: baseScript({
      prompt: async (_params: unknown, agent: FakeAgent) => {
        await script(agent);
        return promptResponse({
          stopReason: options.stopReason ?? "end_turn",
          ...(options.usage === undefined ? {} : { usage: options.usage }),
        });
      },
    }),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices();
  try {
    const result = await runTurn(channel, { services, integration: fixture.integration });
    return { services, result, agent: fixture.agent };
  } finally {
    await channel.close();
  }
}

test("an assistant message chunk becomes a text delta and joins the final message", async () => {
  const { services, result } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } });
    update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world." } });
  });
  assert.deepEqual(services.ofType("text.delta"), [{ type: "text.delta", text: "Hello " }, { type: "text.delta", text: "world." }]);
  assert.equal(result.finalText, "Hello world.");
});

test("a thought chunk is marked with its native type and stays out of the final message", async () => {
  const { services, result } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "weighing options" } });
    update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer." } });
  });
  const deltas = services.ofType("text.delta");
  assert.deepEqual(deltas[0], { type: "text.delta", text: "weighing options", nativeType: "agent_thought_chunk" });
  assert.equal(deltas[1]?.nativeType, undefined);
  // Reasoning is streamed for the reader but is not the assistant's answer.
  assert.equal(result.finalText, "Answer.");
});

test("non-text assistant content degrades to a native event instead of inventing text", async () => {
  const { services, result } = await turnWith((agent) => {
    update(agent, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    });
    update(agent, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "resource_link", name: "report.pdf", uri: "file:///tmp/report.pdf" },
    });
  });
  assert.equal(services.ofType("text.delta").length, 0);
  assert.equal(result.finalText, "");
  const degraded = services.native("agent_message_chunk.content");
  assert.equal(degraded.length, 2);
  const content = nativePayload(services, "agent_message_chunk.content")["content"];
  assert.ok(content !== null && typeof content === "object" && !Array.isArray(content));
  assert.equal(content["type"], "image");
  assert.equal(content["mimeType"], "image/png");
});

test("a non-text thought chunk degrades under its own update name", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "image", data: "aGk=", mimeType: "image/png" },
    });
  });
  assert.equal(services.native("agent_thought_chunk.content").length, 1);
  assert.equal(services.native("agent_message_chunk.content").length, 0);
});

test("a user message chunk is an echo of client input, never assistant output", async () => {
  const { services, result } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } });
  });
  assert.equal(services.ofType("text.delta").length, 0);
  assert.equal(result.finalText, "");
  assert.equal(services.native("user_message_chunk").length, 1);
});

test("a tool call opens, updates and finishes as one identity", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, {
      sessionUpdate: "tool_call", toolCallId: "call-1", title: "Reading file", name: "read_file",
      status: "pending", rawInput: { path: "README.md" },
    });
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress", title: "Reading README.md" });
    update(agent, {
      sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed",
      content: [{ type: "content", content: { type: "text", text: "# Title" } }], rawOutput: { bytes: 7 },
    });
  });
  assert.deepEqual(services.types, ["tool.started", "tool.updated", "tool.finished"]);
  const started = services.ofType("tool.started")[0];
  assert.equal(started?.callId, "call-1");
  assert.equal(started?.name, "read_file");
  assert.deepEqual(started?.input, { path: "README.md" });
  assert.deepEqual(services.ofType("tool.updated")[0], { type: "tool.updated", callId: "call-1", title: "Reading README.md" });
  const finished = services.ofType("tool.finished")[0];
  assert.equal(finished?.failed, false);
  assert.equal(finished?.name, "read_file");
  const output = finished?.output;
  assert.ok(output !== null && typeof output === "object" && !Array.isArray(output));
  assert.equal(output["status"], "completed");
  assert.deepEqual(output["rawOutput"], { bytes: 7 });
});

test("a failed terminal status is reported as a failed call, not a successful one", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Write", name: "write" });
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "failed" });
  });
  assert.equal(services.ofType("tool.finished")[0]?.failed, true);
});

test("a tool call that arrives already terminal opens and closes in one step", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, {
      sessionUpdate: "tool_call", toolCallId: "call-1", title: "Lookup", name: "lookup", status: "completed",
      rawOutput: { hit: true },
    });
  });
  assert.deepEqual(services.types, ["tool.started", "tool.finished"]);
  assert.equal(services.ofType("tool.finished")[0]?.failed, false);
});

test("a title-only tool call falls back to the title as the tool name", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Search the web" });
  });
  assert.equal(services.ofType("tool.started")[0]?.name, "Search the web");
});

/**
 * The literal update sequence one `write` call produced on opencode 1.18.29: the call is announced with an
 * empty `rawInput`, the real arguments arrive with the next update, and the title is then replaced by the
 * written path. The core records a call's arguments once, from `tool.started`, and accepts only a title
 * afterwards, so starting on the announcement would leave `{}` in the transcript for good.
 */
function writeCall(agent: FakeAgent): void {
  update(agent, {
    sessionUpdate: "tool_call", toolCallId: "call_1", title: "write", kind: "edit",
    status: "pending", locations: [], rawInput: {},
  });
  update(agent, {
    sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "in_progress", kind: "edit", title: "write",
    locations: [{ path: "/abs/path/probe-output.txt" }],
    rawInput: { filePath: "/abs/path/probe-output.txt", content: "hello-from-probe" },
  });
  update(agent, {
    sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed",
    title: "tmp/probe/probe-output.txt",
    content: [{ type: "content", content: { type: "text", text: "Wrote file successfully." } }],
    rawOutput: { output: "Wrote file successfully.", metadata: { filePath: "/abs/path/probe-output.txt" } },
  });
  update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Wrote the file." } });
}

test("a call starts with the arguments the engine bound after announcing it, not with the empty ones", async () => {
  const { services } = await turnWith(writeCall);
  const started = services.ofType("tool.started");
  // One start only: the arguments reach the transcript through it, and it is written exactly once.
  assert.equal(started.length, 1);
  assert.equal(started[0]?.callId, "call_1");
  assert.deepEqual(started[0]?.input, { filePath: "/abs/path/probe-output.txt", content: "hello-from-probe" });
});

test("a call keeps the name it was announced with when the engine renames the title", async () => {
  const { services } = await turnWith(writeCall);
  // The engine replaces the title with the written path on completion; the tool is still `write`.
  assert.equal(services.ofType("tool.started")[0]?.name, "write");
  assert.equal(services.ofType("tool.finished")[0]?.name, "write");
});

test("a held call reports its progress and its result in order once it has started", async () => {
  const { services, result } = await turnWith(writeCall);
  assert.deepEqual(services.types, ["tool.started", "tool.updated", "tool.finished", "text.delta"]);
  assert.equal(services.ofType("tool.updated")[0]?.title, "write");
  const finished = services.ofType("tool.finished")[0];
  assert.equal(finished?.failed, false);
  const output = finished?.output;
  assert.ok(output !== null && typeof output === "object" && !Array.isArray(output));
  const rawOutput = output["rawOutput"];
  assert.ok(rawOutput !== null && typeof rawOutput === "object" && !Array.isArray(rawOutput));
  assert.equal(rawOutput["output"], "Wrote file successfully.");
  // Holding a call is not an unresolved call: the engine closed this one itself.
  assert.equal(services.native("turn.settled").length, 0);
  assert.equal(result.finalText, "Wrote the file.");
});

test("a held call starts where its arguments arrive, after whatever the engine streamed while it waited", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, {
      sessionUpdate: "tool_call", toolCallId: "call_1", title: "write", kind: "edit", status: "pending", rawInput: {},
    });
    update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "writing the file" } });
    update(agent, {
      sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "in_progress",
      rawInput: { filePath: "/abs/path/probe-output.txt", content: "hello-from-probe" },
    });
  });
  // Announcing the call emits nothing at all, so the text the engine streamed in between comes first.
  assert.deepEqual(services.types.filter((type) => type !== "native"), ["text.delta", "tool.started", "tool.updated", "tool.finished"]);
  assert.deepEqual(services.ofType("tool.started")[0]?.input,
    { filePath: "/abs/path/probe-output.txt", content: "hello-from-probe" });
});

test("a call announced with its arguments starts on the announcement, not on a later update", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, {
      sessionUpdate: "tool_call", toolCallId: "call-1", title: "read", kind: "read",
      status: "pending", rawInput: { filePath: "README.md" },
    });
    update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reading" } });
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: { bytes: 7 } });
  });
  // The text delta between the two tool updates pins the start to the announcement.
  assert.deepEqual(services.types, ["tool.started", "text.delta", "tool.finished"]);
  assert.deepEqual(services.ofType("tool.started")[0]?.input, { filePath: "README.md" });
});

test("a held call reports no progress before it starts, and keeps the title it was given while held", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, {
      sessionUpdate: "tool_call", toolCallId: "call_1", title: "write", kind: "edit", status: "pending", rawInput: {},
    });
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "in_progress", title: "still writing" });
    update(agent, {
      sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "in_progress",
      rawInput: { filePath: "/abs/path/probe-output.txt" },
    });
  });
  // A tool.updated for a call the core has not seen start is rejected as UNMATCHED_TOOL_UPDATE.
  assert.deepEqual(services.types.filter((type) => type !== "native"), ["tool.started", "tool.updated", "tool.finished"]);
  assert.deepEqual(services.ofType("tool.started")[0]?.input, { filePath: "/abs/path/probe-output.txt" });
  assert.equal(services.ofType("tool.updated")[0]?.title, "still writing");
});

test("a held call whose only update is terminal still reports the engine's own result", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, {
      sessionUpdate: "tool_call", toolCallId: "call_1", title: "write", kind: "edit", status: "pending", rawInput: {},
    });
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed", rawOutput: { output: "done" } });
  });
  // Waiting for arguments must never swallow a terminal state; the call is started so it can be closed.
  assert.deepEqual(services.types, ["tool.started", "tool.finished"]);
  assert.deepEqual(services.ofType("tool.started")[0]?.input, {});
  const finished = services.ofType("tool.finished")[0];
  assert.equal(finished?.failed, false);
  const output = finished?.output;
  assert.ok(output !== null && typeof output === "object" && !Array.isArray(output));
  assert.equal(output["status"], "completed");
  assert.equal(services.native("turn.settled").length, 0);
});

test("a call held for arguments that never arrive is still started and closed as failed", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, {
      sessionUpdate: "tool_call", toolCallId: "call_1", title: "write", kind: "edit", status: "pending", rawInput: {},
    });
    update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "giving up" } });
  });
  // The engine declared the call, so the transcript shows it; holding it is never a reason to drop it.
  assert.deepEqual(services.types.filter((type) => type.startsWith("tool.")), ["tool.started", "tool.finished"]);
  const started = services.ofType("tool.started")[0];
  assert.equal(started?.name, "write");
  assert.deepEqual(started?.input, {});
  const finished = services.ofType("tool.finished")[0];
  assert.equal(finished?.failed, true);
  const output = finished?.output;
  assert.ok(output !== null && typeof output === "object" && !Array.isArray(output));
  assert.equal(output["errorCode"], "ACP_TOOL_RESULT_MISSING");
  assert.equal(output["source"], "driver-observation");
  // One unresolved call, not one per emitted event.
  assert.equal(nativePayload(services, "turn.settled")["unresolvedToolCalls"], 1);
});

test("a call re-announced with arguments while it is held starts once, under its first name", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call_1", title: "write", kind: "edit", rawInput: {} });
    update(agent, {
      sessionUpdate: "tool_call", toolCallId: "call_1", title: "tmp/probe-output.txt", kind: "edit",
      rawInput: { filePath: "/abs/path/probe-output.txt" },
    });
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" });
  });
  const started = services.ofType("tool.started");
  assert.equal(started.length, 1);
  assert.equal(started[0]?.name, "write");
  assert.deepEqual(started[0]?.input, { filePath: "/abs/path/probe-output.txt" });
});

test("an update for an unknown tool identity is observed, never turned into a call", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "never-opened", status: "completed" });
  });
  // The core rejects an unmatched tool update, so the driver must not manufacture one.
  assert.equal(services.ofType("tool.started").length, 0);
  assert.equal(services.ofType("tool.finished").length, 0);
  assert.equal(services.native("tool_call_update.unknown").length, 1);
});

test("a repeated tool identity is treated as progress, never as a second call", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "First", name: "run", rawInput: { step: 1 } });
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Second", name: "run" });
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" });
  });
  assert.deepEqual(services.types, ["tool.started", "tool.updated", "tool.finished"]);
  assert.equal(services.ofType("tool.started").length, 1);
  assert.equal(services.ofType("tool.updated")[0]?.title, "Second");
});

test("an update after the call closed is observed as late instead of reopening it", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Run", name: "run", status: "completed" });
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" });
  });
  assert.equal(services.ofType("tool.finished").length, 1);
  assert.equal(services.native("tool_call_update.late").length, 1);
});

test("an unresolved tool call is closed as failed with an explicit driver-observed source", async () => {
  const { services, result } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Run", name: "run", status: "in_progress" });
    update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
  });
  // A completed run with an open call is a protocol error to the core; the leftover must be closed here.
  const finished = services.ofType("tool.finished");
  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.callId, "call-1");
  assert.equal(finished[0]?.failed, true);
  const output = finished[0]?.output;
  assert.ok(output !== null && typeof output === "object" && !Array.isArray(output));
  assert.equal(output["errorCode"], "ACP_TOOL_RESULT_MISSING");
  assert.equal(output["observed"], "no-terminal-tool-state");
  assert.equal(output["source"], "driver-observation");
  // The fabricated close is never presented as a business result.
  assert.equal(result.state, "completed");
  assert.equal(result.taskOutcome, "unknown");
  const settled = nativePayload(services, "turn.settled");
  assert.equal(settled["unresolvedToolCalls"], 1);
});

test("every open tool call is closed, and the closes land before the turn settles", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "A", name: "a" });
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-2", title: "B", name: "b" });
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "call-2", status: "completed" });
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-3", title: "C", name: "c" });
  });
  const closedIds = services.ofType("tool.finished").map((event) => event.callId);
  assert.deepEqual(closedIds, ["call-2", "call-1", "call-3"]);
  const finishedIndexes = services.emitted
    .map((event, index) => event.type === "tool.finished" ? index : -1).filter((index) => index >= 0);
  const lastFinished = finishedIndexes[finishedIndexes.length - 1] ?? -1;
  const settledIndex = services.emitted.findIndex((event) => event.type === "native" && event.eventName === "turn.settled");
  assert.ok(lastFinished < settledIndex, "the turn diagnostic must come after the leftovers are closed");
});

test("no diagnostic is emitted for a turn that closed everything itself", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "A", name: "a", status: "completed" });
  });
  assert.equal(services.native("turn.settled").length, 0);
});

test("cumulative context usage is reported as this turn's increment", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "usage_update", used: 100, size: 200_000 });
    update(agent, { sessionUpdate: "usage_update", used: 250, size: 200_000 });
    // A stale or replayed total must not become a negative or duplicated charge.
    update(agent, { sessionUpdate: "usage_update", used: 250, size: 200_000 });
    update(agent, { sessionUpdate: "usage_update", used: 40, size: 200_000 });
  });
  assert.deepEqual(services.ofType("usage").map((event) => event.inputTokens), [100, 150, 0, 0]);
  for (const event of services.ofType("usage")) assert.equal(event.source, "engine");
});

test("prompt-response usage totals are charged once per turn across a session", async () => {
  const fixture = harness({
    handlers: baseScript({
      prompt: (): Promise<ReturnType<typeof promptResponse>> => Promise.resolve(promptResponse({
        usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
      })),
    }),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  try {
    const totals = [
      { totalTokens: 150, inputTokens: 100, outputTokens: 50 },
      { totalTokens: 400, inputTokens: 260, outputTokens: 140 },
      { totalTokens: 400, inputTokens: 260, outputTokens: 140 },
    ];
    const seen: { inputTokens?: number; outputTokens?: number }[] = [];
    for (const usage of totals) {
      fixture.agent.on(AGENT_METHODS.session_prompt, () => promptResponse({ usage }));
      const services = new RecordingServices();
      await runTurn(channel, { services, integration: fixture.integration, runId: `run-${String(seen.length)}` });
      const event = services.ofType("usage")[0];
      seen.push({ inputTokens: event?.inputTokens, outputTokens: event?.outputTokens });
    }
    // ACP reports session totals; the public event must carry the delta, so a two-turn session is not double charged.
    assert.deepEqual(seen, [
      { inputTokens: 100, outputTokens: 50 },
      { inputTokens: 160, outputTokens: 90 },
      { inputTokens: 0, outputTokens: 0 },
    ]);
  } finally {
    await channel.close();
  }
});

test("every stop reason maps to a finish and keeps the engine's raw value", async () => {
  const expected: { stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
    finish: string; state: string }[] = [
    { stopReason: "end_turn", finish: "stop", state: "completed" },
    { stopReason: "max_tokens", finish: "length", state: "completed" },
    { stopReason: "max_turn_requests", finish: "unknown", state: "completed" },
    { stopReason: "refusal", finish: "content-filter", state: "completed" },
    { stopReason: "cancelled", finish: "cancelled", state: "cancelled" },
  ];
  for (const expectation of expected) {
    const { result } = await turnWith(() => undefined, { stopReason: expectation.stopReason });
    assert.equal(result.finish, expectation.finish, expectation.stopReason);
    assert.equal(result.state, expectation.state, expectation.stopReason);
    // The mapping is lossy on purpose; the original is always preserved beside it.
    assert.equal(result.nativeStopReason, expectation.stopReason);
    assert.equal(result.quiescent, true);
    assert.equal(result.taskOutcome, "unknown");
  }
});

test("an unknown update kind is counted as a schema loss instead of disappearing", async () => {
  const fixture = harness({
    handlers: baseScript({
      prompt: (_params: unknown, agent: FakeAgent): Promise<ReturnType<typeof promptResponse>> => {
        agent.notify("session/update", {
          sessionId: NATIVE_SESSION,
          update: { sessionUpdate: "telepathy_update", payload: { thought: "unmodelled" } },
        });
        return Promise.resolve(promptResponse());
      },
    }),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  try {
    const first = new RecordingServices();
    await runTurn(channel, { services: first, integration: fixture.integration });
    const second = new RecordingServices();
    await runTurn(channel, { services: second, integration: fixture.integration, runId: "run-2" });
    // The loss is reported on the next turn, because it happened between this driver and the SDK schema.
    const payload = nativePayload(second, "updates.unattributed");
    assert.deepEqual(payload["schemaRejectedKinds"], ["telepathy_update"]);
  } finally {
    await channel.close();
  }
});

test("an update for a different native session is never attributed to this one", async () => {
  const fixture = harness({
    handlers: baseScript({
      prompt: (_params: unknown, agent: FakeAgent): Promise<ReturnType<typeof promptResponse>> => {
        update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "not mine" } }, "someone-else");
        update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "mine" } });
        return Promise.resolve(promptResponse());
      },
    }),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  try {
    const first = new RecordingServices();
    const result = await runTurn(channel, { services: first, integration: fixture.integration });
    assert.equal(result.finalText, "mine");
    const second = new RecordingServices();
    await runTurn(channel, { services: second, integration: fixture.integration, runId: "run-2" });
    assert.equal(nativePayload(second, "updates.unattributed")["foreignSession"], 1);
  } finally {
    await channel.close();
  }
});

test("a sink failure fails the turn rather than being swallowed", async () => {
  const fixture = harness({
    handlers: baseScript({
      prompt: (_params: unknown, agent: FakeAgent): Promise<ReturnType<typeof promptResponse>> => {
        update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
        return Promise.resolve(promptResponse());
      },
    }),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices({
    emitFailure: (event) => event.type === "text.delta" ? new Error("the journal is unavailable") : undefined,
  });
  try {
    await assert.rejects(runTurn(channel, { services, integration: fixture.integration }),
      { message: "the journal is unavailable" });
  } finally {
    await channel.close();
  }
});

// --- the tool name a later request can be keyed on ------------------------------------------------------------

test("nameOf reports the name locked when the call was announced, not what a later update renamed it to", () => {
  const mapper = new SessionUpdateMapper();
  mapper.map({
    sessionUpdate: "tool_call", toolCallId: "call-1", title: "Write a file", name: "write",
    kind: "edit", status: "pending", rawInput: {},
  });
  mapper.map({
    sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress",
    title: "C:\\workspace\\out.txt", rawInput: { filePath: "C:\\workspace\\out.txt", content: "hi" },
  });
  // This is what a permission request arriving after the rename has to be authorised as.
  assert.equal(mapper.nameOf("call-1"), "write");
});

test("nameOf knows nothing about a call the engine never announced", () => {
  const mapper = new SessionUpdateMapper();
  assert.equal(mapper.nameOf("call-unknown"), undefined);
  // An unmatched update becomes an observation and must not invent a call the core never saw begin.
  mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "call-unknown", status: "in_progress", title: "late" });
  assert.equal(mapper.nameOf("call-unknown"), undefined);
});

test("nameOf falls back to what the announcement did carry", () => {
  const mapper = new SessionUpdateMapper();
  mapper.map({ sessionUpdate: "tool_call", toolCallId: "call-2", title: "Edit out.txt", kind: "edit" });
  // Same resolution order the recorded tool call uses: an engine that announces no name is taken at its word.
  assert.equal(mapper.nameOf("call-2"), "Edit out.txt");
});
