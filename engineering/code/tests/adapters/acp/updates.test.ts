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
  assert.deepEqual(services.types, ["tool.observed", "tool.observed", "tool.observed"]);
  const observations = services.ofType("tool.observed");
  assert.deepEqual(observations[0], { type: "tool.observed", source: "engine", callId: "call-1", phase: "created",
    status: "pending", name: "read_file", nameSource: "name", title: "Reading file",
    input: { path: "README.md" }, nativeStatus: "pending" });
  assert.equal(observations[1]?.status, "running");
  assert.equal(observations[1]?.title, "Reading README.md");
  assert.equal(observations[2]?.status, "completed");
  assert.deepEqual(observations[2]?.output, { bytes: 7 });
  assert.equal(observations[2]?.content?.length, 1);
});

test("a failed terminal status is reported as a failed call, not a successful one", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Write", name: "write" });
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "failed" });
  });
  const terminal = services.ofType("tool.observed").at(-1);
  assert.equal(terminal?.status, "failed");
  assert.equal(Object.hasOwn(terminal ?? {}, "output"), false);
});

test("a tool call that arrives already terminal opens and closes in one step", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, {
      sessionUpdate: "tool_call", toolCallId: "call-1", title: "Lookup", name: "lookup", status: "completed",
      rawOutput: { hit: true },
    });
  });
  assert.deepEqual(services.types, ["tool.observed"]);
  assert.equal(services.ofType("tool.observed")[0]?.status, "completed");
  assert.deepEqual(services.ofType("tool.observed")[0]?.output, { hit: true });
});

test("a title-only tool call is named by the title it was announced under, with that provenance", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Search the web" });
  });
  const observed = services.ofType("tool.observed")[0];
  // The engine announced the call under this label; taking it is an observation, not an invention.
  assert.equal(observed?.name, "Search the web");
  assert.equal(observed?.nameSource, "announced-title");
  assert.equal(observed?.title, "Search the web");
});

test("a call announced with neither a name nor a title stays unnamed", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "", kind: "edit", rawInput: {} });
  });
  const observed = services.ofType("tool.observed")[0];
  // A kind is a category, not the identity of a call, so nothing here can name it.
  assert.equal(observed?.name, undefined);
  assert.equal(observed?.nameSource, undefined);
});

/**
 * The literal update sequence one `write` call produced on opencode 1.18.29: the call is announced with an
 * empty `rawInput`, the real arguments arrive with the next update, and the title is then replaced by the
 * written path. `tool.observed` retains both facts in order, so Core can update the canonical arguments when
 * the later binding arrives instead of freezing the announcement's empty object.
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

test("a call preserves both the announced and later bound arguments", async () => {
  const { services } = await turnWith(writeCall);
  const observed = services.ofType("tool.observed");
  assert.deepEqual(observed[0]?.input, {});
  assert.deepEqual(observed[1]?.input, { filePath: "/abs/path/probe-output.txt", content: "hello-from-probe" });
});

test("a later title never renames the call the engine announced", async () => {
  const { services } = await turnWith(writeCall);
  const observed = services.ofType("tool.observed");
  // opencode announces `title: "write"` with no `name`, then rewrites the title to the written path.
  assert.equal(observed.every((event) => event.name === "write"), true);
  assert.equal(observed.every((event) => event.nameSource === "announced-title"), true);
  assert.equal(observed.at(-1)?.title, "tmp/probe/probe-output.txt");
});

test("a call reports its partial facts and result in order", async () => {
  const { services, result } = await turnWith(writeCall);
  assert.deepEqual(services.types, ["tool.observed", "tool.observed", "tool.observed", "text.delta"]);
  const terminal = services.ofType("tool.observed").at(-1);
  assert.equal(terminal?.status, "completed");
  assert.deepEqual(terminal?.output, { output: "Wrote file successfully.", metadata: { filePath: "/abs/path/probe-output.txt" } });
  // Holding a call is not an unresolved call: the engine closed this one itself.
  assert.equal(services.native("turn.settled").length, 0);
  assert.equal(result.finalText, "Wrote the file.");
});

test("an announced observation remains ordered around streamed text and later arguments", async () => {
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
  assert.deepEqual(services.types.filter((type) => type !== "native"), ["tool.observed", "text.delta", "tool.observed"]);
  assert.deepEqual(services.ofType("tool.observed")[1]?.input,
    { filePath: "/abs/path/probe-output.txt", content: "hello-from-probe" });
});

test("a call announced with arguments records them on the created observation", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, {
      sessionUpdate: "tool_call", toolCallId: "call-1", title: "read", kind: "read",
      status: "pending", rawInput: { filePath: "README.md" },
    });
    update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reading" } });
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: { bytes: 7 } });
  });
  assert.deepEqual(services.types, ["tool.observed", "text.delta", "tool.observed"]);
  assert.deepEqual(services.ofType("tool.observed")[0]?.input, { filePath: "README.md" });
});

test("partial progress is retained without waiting for canonical arguments", async () => {
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
  assert.deepEqual(services.types.filter((type) => type !== "native"), ["tool.observed", "tool.observed", "tool.observed"]);
  const observed = services.ofType("tool.observed");
  assert.equal(observed[1]?.title, "still writing");
  assert.deepEqual(observed[2]?.input, { filePath: "/abs/path/probe-output.txt" });
});

test("a call whose only later update is terminal still reports the engine's own result", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, {
      sessionUpdate: "tool_call", toolCallId: "call_1", title: "write", kind: "edit", status: "pending", rawInput: {},
    });
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed", rawOutput: { output: "done" } });
  });
  // Waiting for arguments must never swallow a terminal state; the call is started so it can be closed.
  assert.deepEqual(services.types, ["tool.observed", "tool.observed"]);
  const terminal = services.ofType("tool.observed")[1];
  assert.equal(terminal?.status, "completed");
  assert.deepEqual(terminal?.output, { output: "done" });
  assert.equal(services.native("turn.settled").length, 0);
});

test("a call with no terminal engine fact is not fabricated as a failed tool result", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, {
      sessionUpdate: "tool_call", toolCallId: "call_1", title: "write", kind: "edit", status: "pending", rawInput: {},
    });
    update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "giving up" } });
  });
  assert.deepEqual(services.types.filter((type) => type.startsWith("tool.")), ["tool.observed"]);
  assert.equal(services.ofType("tool.observed")[0]?.status, "pending");
  // One unresolved call, not one per emitted event.
  assert.equal(nativePayload(services, "turn.settled")["unresolvedToolCalls"], 1);
});

test("a re-announced call remains one observed identity and gains its later input", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call_1", title: "write", kind: "edit", rawInput: {} });
    update(agent, {
      sessionUpdate: "tool_call", toolCallId: "call_1", title: "tmp/probe-output.txt", kind: "edit",
      rawInput: { filePath: "/abs/path/probe-output.txt" },
    });
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" });
  });
  const observed = services.ofType("tool.observed");
  assert.equal(observed.length, 3);
  assert.deepEqual(observed[1]?.input, { filePath: "/abs/path/probe-output.txt" });
});

test("an update for an unknown tool identity is observed, never turned into a call", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "never-opened", status: "completed" });
  });
  const observed = services.ofType("tool.observed");
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.callId, "never-opened");
  assert.equal(observed[0]?.status, "completed");
});

test("a repeated tool identity is treated as progress, never as a second call", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "First", name: "run", rawInput: { step: 1 } });
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Second", name: "run" });
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" });
  });
  assert.deepEqual(services.types, ["tool.observed", "tool.observed", "tool.observed"]);
  assert.equal(services.ofType("tool.observed")[1]?.title, "Second");
});

test("an update after the call closed is observed as late instead of reopening it", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Run", name: "run", status: "completed" });
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" });
  });
  assert.equal(services.ofType("tool.observed").filter((event) => event.status === "completed").length, 1);
  assert.equal(services.native("tool_call_update.late").length, 1);
});

test("an unresolved tool call is reported in the diagnostic and does not fail the engine's turn", async () => {
  const { services, result } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Run", name: "run", status: "in_progress" });
    update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
  });
  assert.equal(services.ofType("tool.finished").length, 0);
  assert.equal(services.ofType("tool.observed").length, 1);
  // The engine ended the turn itself, so its stop reason is the turn's state. Core records the call it
  // never closed as an observation, keeping the answer without fabricating any result.
  assert.equal(result.state, "completed");
  assert.equal(result.finish, "stop");
  assert.equal(result.nativeStopReason, "end_turn");
  assert.equal(result.taskOutcome, "unknown");
  const settled = nativePayload(services, "turn.settled");
  assert.equal(settled["unresolvedToolCalls"], 1);
});

test("every open tool call remains nonterminal and the turn diagnostic reports them", async () => {
  const { services } = await turnWith((agent) => {
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "A", name: "a" });
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-2", title: "B", name: "b" });
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "call-2", status: "completed" });
    update(agent, { sessionUpdate: "tool_call", toolCallId: "call-3", title: "C", name: "c" });
  });
  assert.equal(services.ofType("tool.finished").length, 0);
  const settledIndex = services.emitted.findIndex((event) => event.type === "native" && event.eventName === "turn.settled");
  assert.ok(settledIndex > 0);
  assert.equal(nativePayload(services, "turn.settled")["unresolvedToolCalls"], 2);
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

test("nameOf uses the first label the engine showed for a call it never announced", () => {
  const mapper = new SessionUpdateMapper();
  assert.equal(mapper.nameOf("call-unknown"), undefined);
  // An unmatched update is still this call's first appearance, so its label announces it.
  mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "call-unknown", status: "in_progress", title: "late" });
  assert.equal(mapper.nameOf("call-unknown"), "late");
});

test("nameOf falls back to what the announcement did carry", () => {
  const mapper = new SessionUpdateMapper();
  mapper.map({ sessionUpdate: "tool_call", toolCallId: "call-2", title: "Edit out.txt", kind: "edit" });
  // Same resolution the recorded tool call uses: an engine that announces no name is taken at its word.
  assert.equal(mapper.nameOf("call-2"), "Edit out.txt");
});

test("policy and the transcript resolve one identity, never two different names for one call", () => {
  const mapper = new SessionUpdateMapper();
  const announced = mapper.map({
    sessionUpdate: "tool_call", toolCallId: "call-3", title: "write", kind: "edit", status: "pending", rawInput: {},
  });
  const observation = announced.events[0];
  assert.equal(observation?.type, "tool.observed");
  if (observation?.type !== "tool.observed") return;
  assert.equal(observation.name, mapper.nameOf("call-3"));
  assert.equal(observation.nameSource, "announced-title");
});
