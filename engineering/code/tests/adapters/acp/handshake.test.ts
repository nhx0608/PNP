import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_METHODS, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { InitializeRequest, LoadSessionRequest, NewSessionRequest } from "@agentclientprotocol/sdk";
import { openAcpChannel } from "../../../src/drivers/acp/channel.ts";
import { NO_REPLY, RpcFault } from "../../kit/fake-host.ts";
import { definition, harness, makeSession, nativePayload, RecordingServices, runTurn } from "./harness.ts";
import { baseScript, initializeResponse, NATIVE_SESSION } from "./script.ts";

test("initialize negotiates the protocol version and records the agent's own identity", async () => {
  const fixture = harness({
    handlers: baseScript({
      initialize: initializeResponse({ agentInfo: { name: "test-agent", version: "9.9.9" } }),
    }),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  try {
    const request = fixture.agent.paramsOf(AGENT_METHODS.initialize) as InitializeRequest;
    assert.equal(request.protocolVersion, PROTOCOL_VERSION);
    assert.equal(request.clientCapabilities?.terminal, false);
    assert.equal(channel.native.protocolVersion, String(PROTOCOL_VERSION));
    assert.equal(channel.native.nativeId, NATIVE_SESSION);
    assert.equal(channel.native.channelId, "acp");
    // The engine's own version outranks the version the Pack locked in.
    assert.equal(channel.native.engineVersion, "9.9.9");
  } finally {
    await channel.close();
  }
});

test("the locked Pack version stands in when the engine reports no identity", async () => {
  const fixture = harness({ handlers: baseScript() });
  const channel = await openAcpChannel(definition({ engineVersion: "1.2.3-locked" }), fixture.input);
  try {
    assert.equal(channel.native.engineVersion, "1.2.3-locked");
  } finally {
    await channel.close();
  }
});

test("a protocol version this driver does not implement fails the open and terminates the process", async () => {
  const fixture = harness({
    handlers: baseScript({ initialize: initializeResponse({ protocolVersion: PROTOCOL_VERSION + 1 }) }),
  });
  await assert.rejects(openAcpChannel(definition(), fixture.input), { code: "ENGINE_PROTOCOL_VERSION" });
  assert.equal(fixture.process.terminateCalls, 1);
  assert.equal(fixture.agent.countOf(AGENT_METHODS.session_new), 0);
});

test("a non-integer protocol version is refused rather than coerced", async () => {
  const fixture = harness({
    handlers: baseScript({ initialize: initializeResponse({ protocolVersion: 1.5 }) }),
  });
  await assert.rejects(openAcpChannel(definition(), fixture.input), { code: "ENGINE_PROTOCOL_VERSION" });
});

test("declared capabilities are recorded as declared, never as proven", async () => {
  const fixture = harness({
    handlers: baseScript({
      initialize: initializeResponse({
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false },
          mcpCapabilities: { http: true },
          sessionCapabilities: { close: {}, delete: {} },
        },
      }),
    }),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  try {
    const snapshot = channel.capabilities;
    assert.equal(snapshot.sessionResume, true);
    assert.equal(snapshot.nativeDelete, true);
    assert.equal(snapshot.streaming, true);
    assert.equal(snapshot.cancellation, true);
    const byId = new Map(snapshot.extensions.map((entry) => [entry.id, entry]));
    assert.equal(byId.get("acp.prompt.image")?.available, true);
    assert.equal(byId.get("acp.prompt.audio")?.available, false);
    assert.equal(byId.get("acp.mcp.http")?.available, true);
    assert.equal(byId.get("acp.mcp.sse")?.available, false);
    assert.equal(byId.get("acp.session.close")?.available, true);
    assert.equal(byId.get("acp.session.fork")?.available, false);
    // A declaration in initialize is an advertisement, not evidence.
    for (const entry of snapshot.extensions) assert.equal(entry.evidence, "declared", entry.id);
  } finally {
    await channel.close();
  }
});

test("an engine that declares nothing gets no capability invented for it", async () => {
  const fixture = harness({ handlers: baseScript() });
  const channel = await openAcpChannel(definition(), fixture.input);
  try {
    const snapshot = channel.capabilities;
    assert.equal(snapshot.sessionResume, false);
    assert.equal(snapshot.nativeDelete, false);
    assert.equal(channel.native.resumeToken, undefined);
    const byId = new Map(snapshot.extensions.map((entry) => [entry.id, entry]));
    assert.equal(byId.get("acp.prompt.image")?.available, false);
    assert.equal(byId.get("acp.session.config_option")?.available, false);
    // stdio MCP is the ACP baseline and is the only transport this driver claims without a declaration.
    assert.equal(byId.get("acp.mcp.stdio")?.available, true);
  } finally {
    await channel.close();
  }
});

test("the process exiting during initialize rejects the open instead of hanging", async () => {
  const fixture = harness({
    handlers: {
      [AGENT_METHODS.initialize]: (_params: unknown): unknown => {
        fixture.process.exit(3, null);
        return NO_REPLY;
      },
    },
  });
  await assert.rejects(openAcpChannel(definition(), fixture.input), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /exited before the channel closed \(code=3, signal=null\)/);
    return true;
  });
});

test("the process exiting during session/new rejects the open instead of hanging", async () => {
  const fixture = harness({
    handlers: {
      ...baseScript(),
      [AGENT_METHODS.session_new]: (_params: unknown): unknown => {
        fixture.process.exit(null, "SIGKILL");
        return NO_REPLY;
      },
    },
  });
  await assert.rejects(openAcpChannel(definition(), fixture.input), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /signal=SIGKILL/);
    return true;
  });
});

test("the process exiting mid-prompt settles the run instead of leaving it pending", async () => {
  const fixture = harness({
    handlers: baseScript({
      prompt: (): Promise<never> => {
        fixture.process.exit(9, null);
        return new Promise<never>(() => undefined);
      },
    }),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices();
  await assert.rejects(runTurn(channel, { services, integration: fixture.integration }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /exited before the channel closed/);
    return true;
  });
});

test("an unparseable frame fails the channel rather than being ignored", async () => {
  const fixture = harness({
    handlers: {
      [AGENT_METHODS.initialize]: (_params: unknown): unknown => {
        fixture.agent.deliverRaw("this is not json");
        return NO_REPLY;
      },
    },
  });
  await assert.rejects(openAcpChannel(definition(), fixture.input), { code: "ENGINE_PROTOCOL_ERROR" });
});

test("session/new carries the gateway workspace and the projected MCP servers", async () => {
  const fixture = harness({ handlers: baseScript() });
  const channel = await openAcpChannel(definition(), fixture.input);
  try {
    const request = fixture.agent.paramsOf(AGENT_METHODS.session_new) as NewSessionRequest;
    assert.equal(request.cwd, "/workspace/project");
    assert.deepEqual(request.mcpServers, []);
    // The ownership record keys on the gateway Session, never on the native ACP session.
    assert.equal(fixture.host.specs[0]?.sessionId, "session-1");
    assert.notEqual(fixture.host.specs[0]?.ownerToken, "");
    assert.equal(fixture.host.specs[0]?.executable, "acp-engine");
  } finally {
    await channel.close();
  }
});

test("a prior native reference is restored when the engine declares session/load", async () => {
  const fixture = harness({
    session: makeSession({
      native: { nativeId: "previous-session", channelId: "acp", engineVersion: "0.0.0-test" },
    }),
    handlers: {
      ...baseScript({ initialize: initializeResponse({ agentCapabilities: { loadSession: true } }) }),
      [AGENT_METHODS.session_load]: (): { configOptions: [] } => ({ configOptions: [] }),
    },
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  try {
    const request = fixture.agent.paramsOf(AGENT_METHODS.session_load) as LoadSessionRequest;
    assert.equal(request.sessionId, "previous-session");
    assert.equal(request.cwd, "/workspace/project");
    assert.equal(channel.native.nativeId, "previous-session");
    assert.equal(channel.native.resumeToken, "previous-session");
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_new), 0);
    const loaded = channel.capabilities.extensions.find((entry) => entry.id === "acp.session.load");
    // The load actually happened, so the ledger may move past "declared".
    assert.equal(loaded?.evidence, "verified");

    const services = new RecordingServices();
    await runTurn(channel, { services, integration: fixture.integration });
    assert.equal(services.native("session.context-lost").length, 0);
    assert.equal(nativePayload(services, "session.restored")["nativeId"], "previous-session");
  } finally {
    await channel.close();
  }
});

test("an engine that never declared session/load starts fresh and reports the lost context", async () => {
  const fixture = harness({
    session: makeSession({
      native: { nativeId: "previous-session", channelId: "acp", engineVersion: "0.0.0-test" },
    }),
    handlers: baseScript(),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  try {
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_load), 0);
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_new), 1);
    // A brand new native session must not be passed off as the old one.
    assert.equal(channel.native.nativeId, NATIVE_SESSION);
    assert.equal(channel.native.resumeToken, undefined);

    const services = new RecordingServices();
    await runTurn(channel, { services, integration: fixture.integration });
    assert.equal(services.native("session.context-lost").length, 1);
    const payload = nativePayload(services, "session.context-lost");
    assert.equal(payload["requested"], "previous-session");
    assert.equal(payload["reason"], "load-session-not-declared");
    assert.equal(services.native("session.restored").length, 0);
  } finally {
    await channel.close();
  }
});

test("a refused session/load falls back to a new session and reports the loss with the engine's reason", async () => {
  const fixture = harness({
    session: makeSession({
      native: { nativeId: "previous-session", channelId: "acp", engineVersion: "0.0.0-test" },
    }),
    handlers: {
      ...baseScript({ initialize: initializeResponse({ agentCapabilities: { loadSession: true } }) }),
      [AGENT_METHODS.session_load]: (): never => { throw new RpcFault(-32002, "That session is gone."); },
    },
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  try {
    assert.equal(channel.native.nativeId, NATIVE_SESSION);
    const loaded = channel.capabilities.extensions.find((entry) => entry.id === "acp.session.load");
    // The call was exercised and failed: probed, not verified, and still declared available.
    assert.equal(loaded?.evidence, "probed");

    const services = new RecordingServices();
    await runTurn(channel, { services, integration: fixture.integration });
    const payload = nativePayload(services, "session.context-lost");
    assert.equal(payload["requested"], "previous-session");
    assert.match(String(payload["reason"]), /That session is gone/);
  } finally {
    await channel.close();
  }
});

test("an unanswered initialize fails the open on the request deadline", async () => {
  const fixture = harness({
    handlers: { [AGENT_METHODS.initialize]: (): unknown => NO_REPLY },
  });
  await assert.rejects(openAcpChannel(definition({ timeouts: { requestMs: 60 } }), fixture.input),
    { code: "DEADLINE_EXCEEDED" });
  assert.equal(fixture.process.terminateCalls, 1);
});

test("a closed channel refuses further turns", async () => {
  const fixture = harness({ handlers: baseScript() });
  const channel = await openAcpChannel(definition(), fixture.input);
  const evidence = await channel.close();
  assert.equal(evidence.quiescent, true);
  const services = new RecordingServices();
  await assert.rejects(runTurn(channel, { services, integration: fixture.integration }),
    { code: "ENGINE_CHANNEL_CLOSED" });
});
