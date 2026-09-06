import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_METHODS } from "@agentclientprotocol/sdk";
import type { EngineResult, StopReason } from "../../../src/contracts/index.ts";
import { openAcpChannel } from "../../../src/drivers/acp/channel.ts";
import type { FakeAgent } from "../../kit/fake-host.ts";
import { NO_REPLY, RpcFault } from "../../kit/fake-host.ts";
import {
  definition, FAST_TIMEOUTS, harness, nativePayload, RecordingServices, runTurn, waitFor,
} from "./harness.ts";
import { baseScript, heldPrompt, promptResponse, update } from "./script.ts";

/**
 * The measured gateway contract (docs/engineering-review-2.md section 4.4): the only ending that keeps the
 * resident channel is `cancel` acknowledging at once and `run` settling as cancelled inside the grace window.
 * Rejecting, settling late and never settling are all equivalent to destroying the channel, and a rejection
 * whose termination cannot prove itself kills the whole evaluation round. Every case below states which of
 * those five rows it is pinning down.
 */

interface Cancelled {
  result: EngineResult;
  services: RecordingServices;
  agent: FakeAgent;
  /** Terminations counted while the channel was still open, before the test's own teardown. */
  terminateCalls: number;
  elapsedMs: number;
}

/** Starts a turn, waits for the prompt to be genuinely in flight, then cancels it locally. */
async function cancelInFlight(options: {
  prompt(params: unknown, agent: FakeAgent): Promise<ReturnType<typeof promptResponse>>;
  reason?: StopReason;
  /** Cancel through the run's AbortSignal instead of the channel's cancel method. */
  viaSignal?: boolean;
  before?(agent: FakeAgent): void;
}): Promise<Cancelled> {
  const fixture = harness({ handlers: baseScript({ prompt: options.prompt }) });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices();
  const signal = new AbortController();
  try {
    const running = runTurn(channel, { services, integration: fixture.integration, signal: signal.signal });
    await waitFor(() => fixture.agent.countOf(AGENT_METHODS.session_prompt) > 0, "session/prompt to be in flight");
    options.before?.(fixture.agent);
    const started = Date.now();
    if (options.viaSignal === true) signal.abort(options.reason ?? "user");
    else await channel.cancel(options.reason ?? "user");
    const acknowledged = Date.now() - started;
    // Cancel is an acknowledgement: it must not wait for the engine to finish the turn.
    assert.ok(acknowledged < FAST_TIMEOUTS.cancelGraceMs, `cancel took ${String(acknowledged)}ms to acknowledge`);
    const result = await running;
    return {
      result, services, agent: fixture.agent,
      terminateCalls: fixture.process.terminateCalls, elapsedMs: Date.now() - started,
    };
  } finally {
    await channel.close();
  }
}

test("an engine that never answers still lets the run settle as cancelled inside the grace window", async () => {
  const outcome = await cancelInFlight({ prompt: (): Promise<never> => new Promise<never>(() => undefined) });
  // Row 1 of the matrix. Rejecting or settling late here would destroy the resident channel.
  assert.equal(outcome.result.state, "cancelled");
  assert.equal(outcome.result.finish, "cancelled");
  assert.equal(outcome.result.nativeStopReason, "cancelled_no_engine_response");
  // The engine proved nothing about this turn's resources, so quiescence is reported as unproven, not as true.
  assert.equal(outcome.result.quiescent, false);
  assert.ok(outcome.elapsedMs < FAST_TIMEOUTS.cancelGraceMs + 400,
    `the run settled ${String(outcome.elapsedMs)}ms after cancel, outside the grace window`);
  const settled = nativePayload(outcome.services, "turn.settled");
  assert.equal(settled["cancelReason"], "user");
  assert.equal(settled["enginePromptSettled"], false);
  assert.equal(settled["cancelAcknowledged"], true);
});

test("an engine that acknowledges the cancellation reports proven quiescence", async () => {
  const held = heldPrompt();
  const outcome = await cancelInFlight({
    prompt: held.handler,
    before: () => { setTimeout(() => { held.release(promptResponse({ stopReason: "cancelled" })); }, 5); },
  });
  assert.equal(outcome.result.state, "cancelled");
  assert.equal(outcome.result.nativeStopReason, "cancelled");
  assert.equal(outcome.result.quiescent, true);
  // The engine answered inside the window, so terminate is never reached.
  assert.equal(outcome.terminateCalls, 0);
});

test("a local stop outranks the completion the engine reports for the interrupted turn", async () => {
  const held = heldPrompt();
  const outcome = await cancelInFlight({
    prompt: held.handler,
    before: () => { setTimeout(() => { held.release(promptResponse({ stopReason: "end_turn" })); }, 5); },
  });
  // An interrupted engine reports drifting completion fields; a run the gateway stopped is cancelled.
  assert.equal(outcome.result.state, "cancelled");
  assert.equal(outcome.result.finish, "cancelled");
  assert.equal(outcome.result.nativeStopReason, "end_turn");
  assert.equal(outcome.result.quiescent, true);
});

test("a refusal reported after a local stop is still a cancellation", async () => {
  const held = heldPrompt();
  const outcome = await cancelInFlight({
    prompt: held.handler,
    before: () => { setTimeout(() => { held.release(promptResponse({ stopReason: "refusal" })); }, 5); },
  });
  assert.equal(outcome.result.state, "cancelled");
  assert.equal(outcome.result.finish, "cancelled");
  assert.equal(outcome.result.nativeStopReason, "refusal");
});

test("an engine error after a local stop resolves as cancelled while the channel is still usable", async () => {
  const held = heldPrompt();
  const outcome = await cancelInFlight({
    prompt: held.handler,
    before: () => { setTimeout(() => { held.fail(new RpcFault(-32603, "interrupted")); }, 5); },
  });
  // The channel is intact; rejecting would discard the driver's own stop reason for nothing.
  assert.equal(outcome.result.state, "cancelled");
  assert.equal(outcome.result.finish, "cancelled");
  assert.equal(outcome.result.nativeStopReason, "jsonrpc_error_-32603");
  assert.equal(outcome.result.quiescent, true);
});

test("streamed output produced before the stop is kept, not discarded", async () => {
  const held = heldPrompt();
  const outcome = await cancelInFlight({
    prompt: async (_params: unknown, agent: FakeAgent) => {
      update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial answer" } });
      return held.handler(_params, agent);
    },
    before: () => { setTimeout(() => { held.release(promptResponse({ stopReason: "cancelled" })); }, 5); },
  });
  assert.equal(outcome.result.finalText, "partial answer");
  assert.equal(outcome.services.ofType("text.delta").length, 1);
});

test("a tool call left open by the interrupted engine is still closed as failed", async () => {
  const outcome = await cancelInFlight({
    prompt: (_params: unknown, agent: FakeAgent): Promise<never> => {
      update(agent, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Long job", name: "run" });
      return new Promise<never>(() => undefined);
    },
  });
  const finished = outcome.services.ofType("tool.finished");
  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.failed, true);
  assert.equal(nativePayload(outcome.services, "turn.settled")["unresolvedToolCalls"], 1);
});

test("cancelling through the run signal carries the caller's reason", async () => {
  for (const reason of ["user", "deadline", "shutdown"] as const) {
    const outcome = await cancelInFlight({
      prompt: (): Promise<never> => new Promise<never>(() => undefined),
      viaSignal: true,
      reason,
    });
    assert.equal(outcome.result.state, "cancelled", reason);
    assert.equal(nativePayload(outcome.services, "turn.settled")["cancelReason"], reason);
  }
});

test("an unrecognised abort reason degrades to a user stop rather than an invalid one", async () => {
  const fixture = harness({
    handlers: baseScript({ prompt: (): Promise<never> => new Promise<never>(() => undefined) }),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices();
  const signal = new AbortController();
  try {
    const running = runTurn(channel, { services, integration: fixture.integration, signal: signal.signal });
    await waitFor(() => fixture.agent.countOf(AGENT_METHODS.session_prompt) > 0, "session/prompt to be in flight");
    signal.abort(new Error("something else entirely"));
    const result = await running;
    assert.equal(result.state, "cancelled");
    assert.equal(nativePayload(services, "turn.settled")["cancelReason"], "user");
  } finally {
    await channel.close();
  }
});

test("an already aborted signal never reaches the engine with a prompt", async () => {
  const fixture = harness({ handlers: baseScript() });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices();
  const signal = new AbortController();
  signal.abort("shutdown");
  try {
    const result = await runTurn(channel, { services, integration: fixture.integration, signal: signal.signal });
    assert.equal(result.state, "cancelled");
    assert.equal(result.nativeStopReason, "cancelled_before_prompt");
    assert.equal(result.quiescent, true);
    // A side effect must not be started for a run that was already stopped.
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_prompt), 0);
  } finally {
    await channel.close();
  }
});

test("the resident channel survives a cancelled turn and runs the next one", async () => {
  const held = heldPrompt();
  const fixture = harness({ handlers: baseScript({ prompt: held.handler }) });
  const channel = await openAcpChannel(definition(), fixture.input);
  try {
    const first = new RecordingServices();
    const running = runTurn(channel, { services: first, integration: fixture.integration });
    await waitFor(() => fixture.agent.countOf(AGENT_METHODS.session_prompt) > 0, "the first prompt");
    await channel.cancel("user");
    held.release(promptResponse({ stopReason: "cancelled" }));
    assert.equal((await running).state, "cancelled");
    // Row 1 of the matrix: the channel is hot, so the next turn reuses it instead of opening a new one.
    assert.equal(fixture.process.terminateCalls, 0);

    fixture.agent.on(AGENT_METHODS.session_prompt, () => promptResponse({ stopReason: "end_turn" }));
    const second = new RecordingServices();
    const result = await runTurn(channel, { services: second, integration: fixture.integration, runId: "run-2" });
    assert.equal(result.state, "completed");
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_prompt), 2);
  } finally {
    await channel.close();
  }
});

test("session/cancel is sent once however many times the caller asks", async () => {
  const held = heldPrompt();
  const fixture = harness({ handlers: baseScript({ prompt: held.handler }) });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices();
  try {
    const running = runTurn(channel, { services, integration: fixture.integration });
    await waitFor(() => fixture.agent.countOf(AGENT_METHODS.session_prompt) > 0, "the prompt");
    await channel.cancel("user");
    await channel.cancel("deadline");
    await channel.cancel("shutdown");
    held.release(promptResponse({ stopReason: "cancelled" }));
    await running;
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_cancel), 1);
    // The first reason is the one that stopped the run; later ones must not overwrite it.
    assert.equal(nativePayload(services, "turn.settled")["cancelReason"], "user");
  } finally {
    await channel.close();
  }
});

test("cancelling with no turn in flight is a no-op, not an error", async () => {
  const fixture = harness({ handlers: baseScript() });
  const channel = await openAcpChannel(definition(), fixture.input);
  try {
    await channel.cancel("user");
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_cancel), 0);
    const services = new RecordingServices();
    const result = await runTurn(channel, { services, integration: fixture.integration });
    assert.equal(result.state, "completed");
  } finally {
    await channel.close();
  }
});

test("a cancel the driver knows it cannot deliver is reported as undelivered", async () => {
  const held = heldPrompt();
  const fixture = harness({ handlers: baseScript({ prompt: held.handler }) });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices();
  try {
    const running = runTurn(channel, { services, integration: fixture.integration });
    await waitFor(() => fixture.agent.countOf(AGENT_METHODS.session_prompt) > 0, "the prompt");
    // The transport fails synchronously on exit, so the cancel path sees a channel that is already gone.
    fixture.process.exit(1, null);
    await channel.cancel("user");
    const result = await running;
    assert.equal(result.state, "cancelled");
    assert.equal(result.quiescent, false);
    const settled = nativePayload(services, "turn.settled");
    assert.equal(settled["cancelAcknowledged"], false);
    assert.equal(settled["cancelNotifyFailure"], "channel is not available");
  } finally {
    await channel.close();
  }
});

test("a cancel lost to a broken pipe still ends the run without claiming the engine stopped", async () => {
  const held = heldPrompt();
  const fixture = harness({ handlers: baseScript({ prompt: held.handler }) });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices();
  try {
    const running = runTurn(channel, { services, integration: fixture.integration });
    await waitFor(() => fixture.agent.countOf(AGENT_METHODS.session_prompt) > 0, "the prompt");
    fixture.process.failWrites(new Error("the pipe is gone"));
    await channel.cancel("user");
    const result = await running;
    assert.equal(result.state, "cancelled");
    // Nothing about the engine's own state was proven, so quiescence stays false and Core takes over.
    assert.equal(result.quiescent, false);
    assert.equal(result.nativeStopReason, "cancelled_connection_lost");
    // The notification never left the gateway; the engine was never told anything.
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_cancel), 0);
    // A queued notification is not an acknowledgement: the diagnostic must not claim one happened.
    const settled = nativePayload(services, "turn.settled");
    assert.equal(settled["cancelAcknowledged"], false);
    assert.notEqual(settled["cancelNotifyFailure"], null);
  } finally {
    await channel.close();
  }
});

test("the process dying under a cancelled turn resolves as cancelled with unproven quiescence", async () => {
  const held = heldPrompt();
  const fixture = harness({ handlers: baseScript({ prompt: held.handler }) });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices();
  try {
    const running = runTurn(channel, { services, integration: fixture.integration });
    await waitFor(() => fixture.agent.countOf(AGENT_METHODS.session_prompt) > 0, "the prompt");
    await channel.cancel("user");
    fixture.process.exit(137, "SIGKILL");
    const result = await running;
    // The turn is terminal for the gateway even though the channel died; Core then takes process evidence.
    assert.equal(result.state, "cancelled");
    assert.equal(result.nativeStopReason, "cancelled_connection_lost");
    assert.equal(result.quiescent, false);
  } finally {
    await channel.close();
  }
});

test("a channel that is genuinely gone rejects rather than reporting a stop it cannot back", async () => {
  const fixture = harness({
    handlers: baseScript({
      prompt: (_params: unknown, agent: FakeAgent): typeof NO_REPLY => {
        agent.deliverRaw("{\"jsonrpc\": broken");
        return NO_REPLY;
      },
    }),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices();
  try {
    // Row 5 of the matrix is the only justification for rejecting: without a channel there is nothing to keep.
    await assert.rejects(runTurn(channel, { services, integration: fixture.integration }),
      { code: "ENGINE_PROTOCOL_ERROR" });
  } finally {
    await channel.close();
  }
});

test("an engine failure with no local stop is a failed run, not a thrown one", async () => {
  const fixture = harness({
    handlers: baseScript({
      prompt: (): never => { throw new RpcFault(-32000, "the model provider refused"); },
    }),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices();
  try {
    const result = await runTurn(channel, { services, integration: fixture.integration });
    assert.equal(result.state, "failed");
    assert.equal(result.finish, "error");
    assert.equal(result.nativeStopReason, "jsonrpc_error_-32000");
    assert.equal(result.quiescent, true);
    assert.equal(result.taskOutcome, "unknown");
  } finally {
    await channel.close();
  }
});

test("a second turn on a busy channel is refused instead of interleaved", async () => {
  const held = heldPrompt();
  const fixture = harness({ handlers: baseScript({ prompt: held.handler }) });
  const channel = await openAcpChannel(definition(), fixture.input);
  const first = new RecordingServices();
  try {
    const running = runTurn(channel, { services: first, integration: fixture.integration });
    await waitFor(() => fixture.agent.countOf(AGENT_METHODS.session_prompt) > 0, "the first prompt");
    const second = new RecordingServices();
    await assert.rejects(runTurn(channel, { services: second, integration: fixture.integration, runId: "run-2" }),
      { code: "ENGINE_TURN_ACTIVE" });
    held.release(promptResponse());
    await running;
  } finally {
    await channel.close();
  }
});

test("closing a channel whose termination cannot prove itself reports uncertainty, never a clean stop", async () => {
  const fixture = harness({ handlers: baseScript() });
  const failing = fixture.process;
  const channel = await openAcpChannel(definition(), fixture.input);
  // Replace the evidence path: the shared host cannot prove the tree is gone.
  Object.defineProperty(failing, "terminate", {
    value: (): Promise<never> => Promise.reject(new Error("the job object could not be inspected")),
  });
  const evidence = await channel.close();
  assert.equal(evidence.quiescent, false);
  assert.equal(evidence.method, "process-tree");
});
