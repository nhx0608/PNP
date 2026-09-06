import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_METHODS } from "@agentclientprotocol/sdk";
import type { CloseSessionRequest } from "@agentclientprotocol/sdk";
import { openAcpChannel } from "../../../src/drivers/acp/channel.ts";
import type { FakeAgent } from "../../kit/fake-host.ts";
import { FakeHostedProcess, RpcFault } from "../../kit/fake-host.ts";
import { definition, harness, RecordingServices, runTurn } from "./harness.ts";
import { baseScript, initializeResponse, NATIVE_SESSION, promptResponse, update } from "./script.ts";

const CLOSEABLE = initializeResponse({ agentCapabilities: { sessionCapabilities: { close: {} } } });

test("a graceful close asks the engine to close the session before ending the process", async () => {
  const fixture = harness({
    handlers: {
      ...baseScript({ initialize: CLOSEABLE }),
      [AGENT_METHODS.session_close]: (): null => null,
    },
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  const evidence = await channel.close();
  const request = fixture.agent.paramsOf(AGENT_METHODS.session_close) as CloseSessionRequest;
  assert.equal(request.sessionId, NATIVE_SESSION);
  assert.equal(evidence.quiescent, true);
  assert.equal(fixture.process.terminateCalls, 1);
  const capability = channel.capabilities.extensions.find((entry) => entry.id === "acp.session.close");
  assert.equal(capability?.evidence, "verified");
});

test("terminating skips the protocol close and goes straight to the process", async () => {
  const fixture = harness({
    handlers: {
      ...baseScript({ initialize: CLOSEABLE }),
      [AGENT_METHODS.session_close]: (): null => null,
    },
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  const evidence = await channel.terminate();
  // Terminate is the evidence path; asking a wedged engine to be polite first only wastes the budget.
  assert.equal(fixture.agent.countOf(AGENT_METHODS.session_close), 0);
  assert.equal(evidence.quiescent, true);
  assert.equal(fixture.process.terminateCalls, 1);
});

test("an engine that never declared session/close is not asked to perform it", async () => {
  const fixture = harness({ handlers: baseScript() });
  const channel = await openAcpChannel(definition(), fixture.input);
  await channel.close();
  assert.equal(fixture.agent.countOf(AGENT_METHODS.session_close), 0);
  assert.equal(fixture.process.terminateCalls, 1);
});

test("a refused protocol close proves nothing and is recorded as unavailable", async () => {
  const fixture = harness({
    handlers: {
      ...baseScript({ initialize: CLOSEABLE }),
      [AGENT_METHODS.session_close]: (): never => { throw new RpcFault(-32601, "not implemented after all"); },
    },
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  const evidence = await channel.close();
  const capability = channel.capabilities.extensions.find((entry) => entry.id === "acp.session.close");
  assert.equal(capability?.available, false);
  assert.equal(capability?.evidence, "probed");
  // The process still supplies the evidence the refused call could not.
  assert.equal(evidence.quiescent, true);
  assert.equal(fixture.process.terminateCalls, 1);
});

test("a proven stop is not re-proven on every later call", async () => {
  const fixture = harness({ handlers: baseScript() });
  const channel = await openAcpChannel(definition(), fixture.input);
  const first = await channel.close();
  const second = await channel.close();
  const third = await channel.terminate();
  assert.deepEqual(first, second);
  assert.deepEqual(first, third);
  assert.equal(fixture.process.terminateCalls, 1);
});

test("an unproven stop is retried rather than cached as done", async () => {
  const process = new FakeHostedProcess({ evidence: { quiescent: false, method: "process-tree" } });
  const fixture = harness({ process, handlers: baseScript() });
  const channel = await openAcpChannel(definition(), fixture.input);
  const first = await channel.close();
  const second = await channel.close();
  assert.equal(first.quiescent, false);
  assert.equal(second.quiescent, false);
  // Caching an unproven stop would turn one bad attempt into a permanent claim.
  assert.equal(process.terminateCalls, 2);
});

test("an engine that outruns the reader fails the channel instead of buffering without limit", async () => {
  const fixture = harness({
    handlers: baseScript({
      prompt: (_params: unknown, agent: FakeAgent): Promise<ReturnType<typeof promptResponse>> => {
        // One synchronous burst: the reader gets no chance to drain between frames.
        for (let index = 0; index < 8; index += 1) {
          update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `chunk ${String(index)}` } });
        }
        return Promise.resolve(promptResponse());
      },
    }),
  });
  const channel = await openAcpChannel(definition({ maxQueuedMessages: 1 }), fixture.input);
  const services = new RecordingServices();
  try {
    await assert.rejects(runTurn(channel, { services, integration: fixture.integration }),
      { code: "ENGINE_BACKPRESSURE" });
  } finally {
    await channel.close();
  }
});

test("a generous queue limit lets the same burst through", async () => {
  const fixture = harness({
    handlers: baseScript({
      prompt: (_params: unknown, agent: FakeAgent): Promise<ReturnType<typeof promptResponse>> => {
        for (let index = 0; index < 8; index += 1) {
          update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } });
        }
        return Promise.resolve(promptResponse());
      },
    }),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices();
  try {
    const result = await runTurn(channel, { services, integration: fixture.integration });
    assert.equal(result.finalText, "xxxxxxxx");
  } finally {
    await channel.close();
  }
});

test("the launch record identifies the gateway session with a usable owner token", async () => {
  const fixture = harness({ handlers: baseScript() });
  const channel = await openAcpChannel(definition(), fixture.input);
  try {
    const spec = fixture.host.specs[0];
    assert.equal(spec?.sessionId, "session-1");
    assert.notEqual(spec?.sessionId, NATIVE_SESSION);
    assert.ok((spec?.ownerToken.length ?? 0) > 0);
    assert.deepEqual(spec?.args, ["--acp"]);
    assert.deepEqual(spec?.env, { PNP_TEST: "1" });
    assert.equal(spec?.cwd, "/workspace/project");
  } finally {
    await channel.close();
  }
});

test("the driver never spawns; every process comes from the shared host", async () => {
  const fixture = harness({ handlers: baseScript() });
  const channel = await openAcpChannel(definition(), fixture.input);
  try {
    assert.equal(fixture.host.started.length, 1);
    assert.equal(fixture.host.started[0], fixture.process);
    // The host registered the ownership entry, so cancelling the scope reaches this process.
    assert.equal(fixture.resources.closed, false);
    const evidence = await fixture.resources.stop(1_000);
    assert.equal(evidence.quiescent, true);
    assert.equal(fixture.process.terminateCalls, 1);
  } finally {
    await channel.close();
  }
});

test("a host that cannot start the engine fails the open without a channel", async () => {
  const fixture = harness({ handlers: baseScript() });
  fixture.controller.abort("shutdown");
  await assert.rejects(openAcpChannel(definition(), fixture.input),
    { message: "Acquisition was cancelled before the process started." });
  assert.equal(fixture.host.specs.length, 0);
});
