import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import type { NewSessionRequest, SetSessionConfigOptionRequest } from "@agentclientprotocol/sdk";
import type { Json } from "../../../src/contracts/index.ts";
import { mcpServersFor, openAcpChannel } from "../../../src/drivers/acp/channel.ts";
import { RpcFault } from "../../kit/fake-host.ts";
import {
  asset, definition, harness, httpTool, makeIntegration, mcpTool, MODEL, nativePayload, promptRequest,
  RecordingServices, runTurn,
} from "./harness.ts";
import { baseScript, initializeResponse, modelOption, NATIVE_SESSION, promptResponse } from "./script.ts";

test("stdio tool bindings project onto the session's MCP servers", () => {
  const projection = mcpServersFor([
    mcpTool({ id: "search", command: "mcp-search", args: ["--stdio", "--quiet"], env: { A: "1", B: "2" } }),
    mcpTool({ id: "docs", command: "mcp-docs", args: [], env: {} }),
  ]);
  assert.deepEqual(projection.servers, [
    { name: "search", command: "mcp-search", args: ["--stdio", "--quiet"], env: [{ name: "A", value: "1" }, { name: "B", value: "2" }] },
    { name: "docs", command: "mcp-docs", args: [], env: [] },
  ]);
  assert.deepEqual(projection.dropped, []);
});

test("a transport ACP cannot carry is dropped from the projection, never smuggled through", () => {
  const projection = mcpServersFor([
    mcpTool({ id: "search" }),
    mcpTool({ id: "legacy", transport: "cli", command: "legacy.exe" }),
    mcpTool({ id: "builtin", transport: "native", command: "builtin" }),
  ]);
  assert.deepEqual(projection.servers.map((server) => "name" in server ? server.name : ""), ["search"]);
  assert.deepEqual(projection.dropped.map((entry) => entry.id), ["legacy", "builtin"]);
});

test("an HTTP MCP server is projected as an ACP http server when the engine declares the capability", () => {
  const projection = mcpServersFor([
    mcpTool({ id: "search" }),
    httpTool({ id: "knowledge", url: "https://knowledge.example/mcp", headers: { Authorization: "Bearer test-only" } }),
  ], { http: true });
  assert.deepEqual(projection.servers[1], {
    type: "http", name: "knowledge", url: "https://knowledge.example/mcp",
    headers: [{ name: "Authorization", value: "Bearer test-only" }],
  });
  assert.deepEqual(projection.dropped, []);
});

test("an HTTP MCP server the engine never declared is dropped with the missing capability named", () => {
  const projection = mcpServersFor([httpTool({ id: "knowledge" })]);
  // Sending it anyway would leave the caller believing in a tool the engine quietly ignores.
  assert.deepEqual(projection.servers, []);
  assert.deepEqual(projection.dropped, [{
    id: "knowledge", transport: "mcp-http", reason: "agentCapabilities.mcpCapabilities.http was not declared",
  }]);
});

test("the session is created with the projected servers and the drop is reported to the reader", async () => {
  const fixture = harness({
    integration: makeIntegration({
      tools: [mcpTool({ id: "search" }), mcpTool({ id: "legacy", transport: "cli", command: "legacy.exe" })],
    }),
    handlers: baseScript(),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices();
  try {
    const request = fixture.agent.paramsOf(AGENT_METHODS.session_new) as NewSessionRequest;
    assert.deepEqual(request.mcpServers?.map((server) => "name" in server ? server.name : ""), ["search"]);
    await runTurn(channel, { services, integration: fixture.integration });
    const dropped = services.native("tools.unsupported-transport")[0];
    assert.deepEqual(dropped?.payload, [{
      id: "legacy", transport: "cli", reason: "acp session/new carries mcp servers only",
    }]);
  } finally {
    await channel.close();
  }
});

test("an engine that declares mcpCapabilities.http receives the HTTP server on session/new", async () => {
  const fixture = harness({
    integration: makeIntegration({
      tools: [httpTool({ id: "knowledge", url: "https://knowledge.example/mcp", headers: { Authorization: "Bearer test-only" } })],
    }),
    handlers: baseScript({ initialize: initializeResponse({ agentCapabilities: { mcpCapabilities: { http: true } } }) }),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices();
  try {
    const request = fixture.agent.paramsOf(AGENT_METHODS.session_new) as NewSessionRequest;
    assert.deepEqual(request.mcpServers, [{
      type: "http", name: "knowledge", url: "https://knowledge.example/mcp",
      headers: [{ name: "Authorization", value: "Bearer test-only" }],
    }]);
    await runTurn(channel, { services, integration: fixture.integration });
    assert.equal(services.native("tools.unsupported-transport").length, 0);
    const capability = channel.capabilities.extensions.find((entry) => entry.id === "acp.mcp.http");
    assert.equal(capability?.available, true);
  } finally {
    await channel.close();
  }
});

test("an engine that declares no HTTP MCP capability gets no HTTP server and the reason is reported", async () => {
  const fixture = harness({
    integration: makeIntegration({ tools: [mcpTool({ id: "search" }), httpTool({ id: "knowledge" })] }),
    handlers: baseScript(),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices();
  try {
    const request = fixture.agent.paramsOf(AGENT_METHODS.session_new) as NewSessionRequest;
    // The session must not carry a server the engine never said it could reach.
    assert.deepEqual(request.mcpServers?.map((server) => "name" in server ? server.name : ""), ["search"]);
    await runTurn(channel, { services, integration: fixture.integration });
    const dropped = services.native("tools.unsupported-transport")[0];
    assert.deepEqual(dropped?.payload, [{
      id: "knowledge", transport: "mcp-http", reason: "agentCapabilities.mcpCapabilities.http was not declared",
    }]);
  } finally {
    await channel.close();
  }
});

test("a required asset with no native projection fails before any process is started", async () => {
  const fixture = harness({
    integration: makeIntegration({ assets: [asset({ id: "playbook", required: true })] }),
    handlers: baseScript(),
  });
  await assert.rejects(openAcpChannel(definition(), fixture.input),
    { code: "ENGINE_ASSET_PROJECTION_UNSUPPORTED" });
  // Failing before launch is the point: nothing was spawned, so there is nothing to reconcile or clean up.
  assert.equal(fixture.host.specs.length, 0);
  assert.equal(fixture.agent.countOf(AGENT_METHODS.initialize), 0);
});

test("an optional asset with no native projection is skipped and reported, not silently dropped", async () => {
  const fixture = harness({
    integration: makeIntegration({ assets: [asset({ id: "house-style", required: false })] }),
    handlers: baseScript(),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices();
  try {
    await runTurn(channel, { services, integration: fixture.integration });
    const skipped = services.native("assets.skipped")[0];
    assert.deepEqual(skipped?.payload, ["house-style"]);
  } finally {
    await channel.close();
  }
});

test("a projection failure fails the open rather than starting a turn without the asset", async () => {
  const fixture = harness({
    integration: makeIntegration({ assets: [asset({ id: "playbook", required: true })] }),
    handlers: baseScript(),
  });
  await assert.rejects(
    openAcpChannel(definition({
      projectAssets: (): Promise<Json> => Promise.reject(new Error("the pack directory is not writable")),
    }), fixture.input),
    { message: "the pack directory is not writable" },
  );
  assert.equal(fixture.host.specs.length, 0);
});

test("a successful projection is reported with what the engine actually received", async () => {
  const fixture = harness({
    integration: makeIntegration({ assets: [asset({ id: "playbook", required: true })] }),
    handlers: baseScript(),
  });
  const channel = await openAcpChannel(definition({
    projectAssets: (input): Promise<Json> => Promise.resolve({
      written: input.assets.map((entry) => entry.id), directory: input.nativeDataDirectory,
    }),
  }), fixture.input);
  const services = new RecordingServices();
  try {
    await runTurn(channel, { services, integration: fixture.integration });
    const payload = nativePayload(services, "assets.projected");
    assert.deepEqual(payload["written"], ["playbook"]);
    assert.equal(payload["directory"], "/data/acp/session-1");
  } finally {
    await channel.close();
  }
});

test("open notices are delivered once, on the first turn that can carry them", async () => {
  const fixture = harness({
    integration: makeIntegration({ assets: [asset({ required: false })] }),
    handlers: baseScript(),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  try {
    const first = new RecordingServices();
    await runTurn(channel, { services: first, integration: fixture.integration });
    assert.equal(first.native("assets.skipped").length, 1);
    const second = new RecordingServices();
    await runTurn(channel, { services: second, integration: fixture.integration, runId: "run-2" });
    assert.equal(second.native("assets.skipped").length, 0);
  } finally {
    await channel.close();
  }
});

test("rebinding tools mid-session is refused before the prompt instead of silently ignored", async () => {
  const fixture = harness({
    integration: makeIntegration({ tools: [mcpTool({ id: "search" })] }),
    handlers: baseScript(),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices();
  try {
    await runTurn(channel, { services, integration: fixture.integration });
    const rebound = makeIntegration({ tools: [mcpTool({ id: "search" }), mcpTool({ id: "shell", command: "mcp-shell" })] });
    await assert.rejects(runTurn(channel, { services, integration: rebound, runId: "run-2" }),
      { code: "ENGINE_BINDINGS_CHANGED" });
    // ACP binds servers at session creation; a second prompt under the new bindings would be a lie.
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_prompt), 1);
  } finally {
    await channel.close();
  }
});

test("a fresh IntegrationContext with identical bindings is accepted", async () => {
  const tools = [mcpTool({ id: "search" })];
  const fixture = harness({ integration: makeIntegration({ tools }), handlers: baseScript() });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices();
  try {
    await runTurn(channel, { services, integration: fixture.integration });
    // Every turn gets a new context object; only a change of binding may be refused.
    await runTurn(channel, { services, integration: makeIntegration({ tools }), runId: "run-2" });
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_prompt), 2);
  } finally {
    await channel.close();
  }
});

test("an engine that pins its model at launch refuses a different one before the prompt", async () => {
  const fixture = harness({ handlers: baseScript() });
  const channel = await openAcpChannel(definition({ model: { kind: "launch", modelID: "pinned-model" } }), fixture.input);
  const services = new RecordingServices();
  try {
    await assert.rejects(
      runTurn(channel, { services, integration: fixture.integration, request: promptRequest("hi") }),
      { code: "ENGINE_MODEL_SWITCH_UNSUPPORTED" });
    // Silently running the prompt on the pinned model would be an undetectable substitution.
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_prompt), 0);
  } finally {
    await channel.close();
  }
});

test("a launch-pinned model matches the qualified provider form as well as the bare id", async () => {
  const fixture = harness({ handlers: baseScript() });
  const channel = await openAcpChannel(
    definition({ model: { kind: "launch", modelID: `${MODEL.providerID}/${MODEL.modelID}` } }), fixture.input);
  const services = new RecordingServices();
  try {
    const result = await runTurn(channel, { services, integration: fixture.integration });
    assert.equal(result.state, "completed");
  } finally {
    await channel.close();
  }
});

test("an engine with no model selector refuses the switch before the prompt", async () => {
  const fixture = harness({ handlers: baseScript() });
  const channel = await openAcpChannel(definition({ model: { kind: "session-config" } }), fixture.input);
  const services = new RecordingServices();
  try {
    await assert.rejects(runTurn(channel, { services, integration: fixture.integration }),
      { code: "ENGINE_MODEL_SWITCH_UNSUPPORTED" });
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_prompt), 0);
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_set_config_option), 0);
  } finally {
    await channel.close();
  }
});

test("a selector that does not offer the model refuses before the prompt", async () => {
  const fixture = harness({
    handlers: baseScript({ configOptions: [modelOption({ values: ["base-model", "other-model"] })] }),
  });
  const channel = await openAcpChannel(definition({ model: { kind: "session-config" } }), fixture.input);
  const services = new RecordingServices();
  try {
    await assert.rejects(runTurn(channel, { services, integration: fixture.integration }),
      { code: "ENGINE_MODEL_UNAVAILABLE" });
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_prompt), 0);
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_set_config_option), 0);
  } finally {
    await channel.close();
  }
});

test("the model is set through the session selector and reported once applied", async () => {
  const fixture = harness({
    handlers: {
      ...baseScript({ configOptions: [modelOption({ currentValue: "base-model" })] }),
      [AGENT_METHODS.session_set_config_option]: (params: unknown): { configOptions: unknown[] } => {
        const request = params as SetSessionConfigOptionRequest;
        return { configOptions: [modelOption({ currentValue: String(request.value) })] };
      },
    },
  });
  const channel = await openAcpChannel(definition({ model: { kind: "session-config" } }), fixture.input);
  const services = new RecordingServices();
  try {
    const result = await runTurn(channel, { services, integration: fixture.integration });
    assert.equal(result.state, "completed");
    const request = fixture.agent.paramsOf(AGENT_METHODS.session_set_config_option) as SetSessionConfigOptionRequest;
    assert.equal(request.sessionId, NATIVE_SESSION);
    assert.equal(request.configId, "model");
    assert.equal(request.value, "test-model");
    const applied = nativePayload(services, "model.applied");
    assert.deepEqual(applied, { configId: "model", value: "test-model" });
    const capability = channel.capabilities.extensions.find((entry) => entry.id === "acp.session.config_option");
    assert.equal(capability?.available, true);
    assert.equal(capability?.evidence, "verified");
  } finally {
    await channel.close();
  }
});

test("a selector already on the requested model is left alone", async () => {
  const fixture = harness({
    handlers: baseScript({ configOptions: [modelOption({ currentValue: "test-model" })] }),
  });
  const channel = await openAcpChannel(definition({ model: { kind: "session-config" } }), fixture.input);
  const services = new RecordingServices();
  try {
    await runTurn(channel, { services, integration: fixture.integration });
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_set_config_option), 0);
    assert.equal(services.native("model.applied").length, 0);
  } finally {
    await channel.close();
  }
});

test("the model is set once and reused across turns", async () => {
  const fixture = harness({
    handlers: {
      ...baseScript({ configOptions: [modelOption({ currentValue: "base-model" })] }),
      [AGENT_METHODS.session_set_config_option]: (params: unknown): { configOptions: unknown[] } => ({
        configOptions: [modelOption({ currentValue: String((params as SetSessionConfigOptionRequest).value) })],
      }),
    },
  });
  const channel = await openAcpChannel(definition({ model: { kind: "session-config" } }), fixture.input);
  const services = new RecordingServices();
  try {
    await runTurn(channel, { services, integration: fixture.integration });
    await runTurn(channel, { services, integration: fixture.integration, runId: "run-2" });
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_set_config_option), 1);
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_prompt), 2);
  } finally {
    await channel.close();
  }
});

test("an engine that moves the selector on its own is made to set it again", async () => {
  const fixture = harness({
    handlers: {
      ...baseScript({ configOptions: [modelOption({ currentValue: "base-model" })] }),
      [AGENT_METHODS.session_set_config_option]: (params: unknown): { configOptions: unknown[] } => ({
        configOptions: [modelOption({ currentValue: String((params as SetSessionConfigOptionRequest).value) })],
      }),
      [AGENT_METHODS.session_prompt]: (_params: unknown, agent): ReturnType<typeof promptResponse> => {
        // The engine drifts back to its own default between turns.
        agent.notify(CLIENT_METHODS.session_update, {
          sessionId: NATIVE_SESSION,
          update: { sessionUpdate: "config_option_update", configOptions: [modelOption({ currentValue: "base-model" })] },
        });
        return promptResponse();
      },
    },
  });
  const channel = await openAcpChannel(definition({ model: { kind: "session-config" } }), fixture.input);
  const services = new RecordingServices();
  try {
    await runTurn(channel, { services, integration: fixture.integration });
    await runTurn(channel, { services, integration: fixture.integration, runId: "run-2" });
    // Assuming the selector stayed put would silently run the second turn on the wrong model.
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_set_config_option), 2);
  } finally {
    await channel.close();
  }
});

test("an engine that refuses the model change fails the turn instead of running on another model", async () => {
  const fixture = harness({
    handlers: {
      ...baseScript({ configOptions: [modelOption({ currentValue: "base-model" })] }),
      [AGENT_METHODS.session_set_config_option]: (): never => {
        throw new RpcFault(-32602, "that model needs authentication");
      },
    },
  });
  const channel = await openAcpChannel(definition({ model: { kind: "session-config" } }), fixture.input);
  const services = new RecordingServices();
  try {
    await assert.rejects(runTurn(channel, { services, integration: fixture.integration }),
      { code: "ENGINE_MODEL_REJECTED" });
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_prompt), 0);
  } finally {
    await channel.close();
  }
});

test("an engine that accepts the change but does not apply it fails the turn", async () => {
  const fixture = harness({
    handlers: {
      ...baseScript({ configOptions: [modelOption({ currentValue: "base-model" })] }),
      // The call succeeds, and the selector has not moved: an accepted request is not an applied change.
      [AGENT_METHODS.session_set_config_option]: (): { configOptions: unknown[] } => ({
        configOptions: [modelOption({ currentValue: "base-model" })],
      }),
    },
  });
  const channel = await openAcpChannel(definition({ model: { kind: "session-config" } }), fixture.input);
  const services = new RecordingServices();
  try {
    await assert.rejects(runTurn(channel, { services, integration: fixture.integration }),
      { code: "ENGINE_MODEL_REJECTED" });
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_prompt), 0);
  } finally {
    await channel.close();
  }
});

test("a selector that is not the model selector is never used to switch models", async () => {
  const fixture = harness({
    handlers: baseScript({
      configOptions: [modelOption({ id: "mode", category: "mode", values: ["base-model", "test-model"] })],
    }),
  });
  const channel = await openAcpChannel(definition({ model: { kind: "session-config" } }), fixture.input);
  const services = new RecordingServices();
  try {
    await assert.rejects(runTurn(channel, { services, integration: fixture.integration }),
      { code: "ENGINE_MODEL_SWITCH_UNSUPPORTED" });
    assert.equal(fixture.agent.countOf(AGENT_METHODS.session_set_config_option), 0);
  } finally {
    await channel.close();
  }
});
