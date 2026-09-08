import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateStore } from "../../src/storage/store.ts";
import { GatewayCore } from "../../src/core/gateway-core.ts";
import { MockPack } from "../../src/engines/mock/pack.ts";
import { MockIntegration } from "../../src/integration/mock/provider.ts";
import { ConfiguredIntegration } from "../../src/integration/configured/provider.ts";
import { loadIntegration } from "../../src/integration/index.ts";
import { buildApp } from "../../src/gateway/app.ts";
import { removeTree } from "../kit/fs.ts";

test("original northbound create/prompt/message/status/delete contract", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-http-"));
  const dir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(dir, { recursive: true });
  const store = new StateStore(path.join(dir, "pnp.db"));
  const core = new GatewayCore(store, new MockPack(), new MockIntegration(), { dataDirectory: dir });
  const app = buildApp(core);
  try {
    assert.equal((await app.inject({ method: "POST", url: "/session", payload: {} })).statusCode, 400);
    const created = await app.inject({ method: "POST", url: "/session", payload: { directory: workspace } });
    assert.equal(created.statusCode, 200); // title is optional.
    const id = (created.json() as { id: string }).id;
    // model is optional: the integration provider resolves its configured default.
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`, payload: { parts: [{ type: "text", text: "hello" }] } })).statusCode, 204);
    // Unknown part types are dropped, but a prompt with nothing recognizable is still rejected.
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`, payload: { parts: [{ type: "image", url: "x" }] } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`, payload: { parts: [{ type: "image", url: "x" }, { type: "text", text: "hello" }] } })).statusCode, 204);
    // The "provider/model" shorthand is accepted alongside the object form.
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`, payload: { parts: [{ type: "text", text: "hi" }], model: "test/test" } })).statusCode, 204);
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`, payload: { parts: [{ type: "text", text: "hi" }], model: "nope" } })).statusCode, 400);
    const response = await app.inject({
      method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", text: "hello" }], model: { providerID: "test", modelID: "test" } },
    });
    assert.equal(response.statusCode, 204);
    const history = await app.inject({ method: "GET", url: `/session/${id}/message` });
    assert.equal(history.json().at(-1).info.finish, "stop");
    const statuses = await app.inject({ method: "GET", url: "/session/status" });
    assert.equal(statuses.json()[id].type, "idle");
    assert.equal((await app.inject({ method: "DELETE", url: `/session/${id}` })).statusCode, 200);
  } finally {
    await app.close(); await store.close(); await removeTree(root);
  }
});

test("HTTP input failures preserve safe 400, 413, and 415 semantics", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-http-errors-"));
  const dir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(dir, { recursive: true });
  const store = new StateStore(path.join(dir, "pnp.db"));
  const core = new GatewayCore(store, new MockPack(), new MockIntegration(), { dataDirectory: dir });
  const app = buildApp(core);
  try {
    const malformed = await app.inject({ method: "POST", url: "/session",
      headers: { "content-type": "application/json" }, payload: "{" });
    assert.equal(malformed.statusCode, 400);
    assert.deepEqual(Object.keys(malformed.json()).sort(), ["code", "message"]);
    const tooLarge = await app.inject({ method: "POST", url: "/session",
      headers: { "content-type": "application/json" }, payload: JSON.stringify({ directory: "x".repeat(1024 * 1024) }) });
    assert.equal(tooLarge.statusCode, 413);
    const unsupported = await app.inject({ method: "POST", url: "/session",
      headers: { "content-type": "application/xml" }, payload: "<session/>" });
    assert.equal(unsupported.statusCode, 415);
    // A path inside the gateway's own data directory is refused, and the refusal never echoes it.
    const insidePath = path.join(dir, "missing-secret-name");
    const inside = await app.inject({ method: "POST", url: "/session", payload: { directory: insidePath } });
    assert.equal(inside.statusCode, 400);
    assert.doesNotMatch(inside.body, /missing-secret-name/);
    const created = await app.inject({ method: "POST", url: "/session", payload: { directory: workspace } });
    const id = (created.json() as { id: string }).id;
    const emptyAbort = await app.inject({ method: "POST", url: `/session/${id}/abort`,
      headers: { "content-type": "application/json" }, payload: "" });
    assert.equal(emptyAbort.statusCode, 200);
  } finally {
    await app.close(); await store.close(); await removeTree(root);
  }
});

test("an unrecognised model runs on the configured default and is published as model.resolved", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-model-"));
  const dir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(dir, { recursive: true });
  const store = new StateStore(path.join(dir, "pnp.db"));
  // A small configured profile, the same shape the shipped one has: one model, no credentials.
  const integration = new ConfiguredIntegration(
    [{ selection: { providerID: "competition", modelID: "default" }, endpoint: "http://127.0.0.1:9/v1",
      protocol: "openai-chat", headerEnvironment: {} }],
    [], () => ({ effect: "allow", reasonCode: "TEST_ALLOW" }), {},
  );
  const core = new GatewayCore(store, new MockPack(), integration, { dataDirectory: dir });
  const app = buildApp(core);
  try {
    const created = await app.inject({ method: "POST", url: "/session", payload: { directory: workspace } });
    const id = (created.json() as { id: string }).id;
    // The specification makes `model` required and the evaluator supplies identifiers this
    // deployment does not control. That is a 204 on the profile's default model, never a 403.
    const response = await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", text: "hello" }], model: { providerID: "evaluator", modelID: "unknown-1" } } });
    assert.equal(response.statusCode, 204);
    const history = await app.inject({ method: "GET", url: `/session/${id}/message` });
    assert.equal(history.json().at(-1).info.finish, "stop");
    const resolved = (await core.eventsSince(0)).filter((event) => event.type === "model.resolved");
    assert.equal(resolved.length, 1);
    const properties = resolved[0]?.properties ?? {};
    assert.deepEqual(properties.requested, { providerID: "evaluator", modelID: "unknown-1" });
    assert.deepEqual(properties.selected, { providerID: "competition", modelID: "default" });
    assert.equal(properties.resolution, "substituted");
    assert.equal(properties.sessionID, id);
    // A named, configured model is recorded as exact.
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", text: "again" }], model: { providerID: "competition", modelID: "default" } } })).statusCode, 204);
    assert.equal((await core.eventsSince(0)).filter((event) => event.type === "model.resolved").at(-1)?.properties.resolution, "exact");
  } finally {
    await app.close(); await store.close(); await removeTree(root);
  }
});

test("evaluator-facing bodies ignore unknown fields but still require the documented ones", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-http-unknown-"));
  const dir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(dir, { recursive: true });
  const store = new StateStore(path.join(dir, "pnp.db"));
  const core = new GatewayCore(store, new MockPack(), new MockIntegration(), { dataDirectory: dir });
  const app = buildApp(core);
  try {
    // An assessment client that carries its own correlation field must not lose the case to a 400.
    const created = await app.inject({ method: "POST", url: "/session",
      payload: { directory: workspace, title: "unknown fields", trace_id: "trace-1", metadata: { run: 7 } } });
    assert.equal(created.statusCode, 200);
    const id = (created.json() as { id: string }).id;
    const prompted = await app.inject({ method: "POST", url: `/session/${id}/prompt_async`, payload: {
      parts: [{ type: "text", text: "hello" }], mode: "task", trace_id: "trace-2",
      model: { providerID: "test", modelID: "test", temperature: 0.2 },
    } });
    assert.equal(prompted.statusCode, 204);
    // Ignoring the unknown is not the same as accepting anything: the documented fields still hold.
    const missingDirectory = await app.inject({ method: "POST", url: "/session", payload: { trace_id: "trace-3" } });
    assert.equal(missingDirectory.statusCode, 400);
    assert.equal(missingDirectory.json().code, "VALIDATION_ERROR");
    const missingParts = await app.inject({ method: "POST", url: `/session/${id}/prompt_async`, payload: { mode: "task" } });
    assert.equal(missingParts.statusCode, 400);
    assert.equal(missingParts.json().code, "VALIDATION_ERROR");
    const missingModelId = await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", text: "hello" }], model: { providerID: "test", trace_id: "trace-4" } } });
    assert.equal(missingModelId.statusCode, 400);
    assert.equal(missingModelId.json().code, "VALIDATION_ERROR");
    // Types are still checked where a value cannot be coerced (Fastify coerces scalars by default).
    const wrongType = await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", text: "hello" }], model: { providerID: "test", modelID: { deep: true } } } });
    assert.equal(wrongType.statusCode, 400);
    assert.equal(wrongType.json().code, "VALIDATION_ERROR");
  } finally {
    await app.close(); await store.close(); await removeTree(root);
  }
});

test("a text part may name its text `content`, the field the message projection uses", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-parts-"));
  const dir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(dir, { recursive: true });
  const store = new StateStore(path.join(dir, "pnp.db"));
  const core = new GatewayCore(store, new MockPack(), new MockIntegration(), { dataDirectory: dir });
  const app = buildApp(core);
  try {
    const created = await app.inject({ method: "POST", url: "/session", payload: { directory: workspace } });
    const id = (created.json() as { id: string }).id;
    // A client that mirrors the field name it read back from GET /session/{id}/message must not
    // lose the case over a field name.
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", content: "from content" }] } })).statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: `/session/${id}/message` })).json()
      .find((message: { role: string }) => message.role === "user").content, "from content");
    // The request body's own field wins when a part carries both.
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", text: "from text", content: "from content" }] } })).statusCode, 204);
    const users = (await app.inject({ method: "GET", url: `/session/${id}/message` })).json()
      .filter((message: { role: string }) => message.role === "user");
    assert.equal(users.at(-1).content, "from text");
    // A text part with neither field is still not a recognised part.
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text" }] } })).statusCode, 400);
  } finally {
    await app.close(); await store.close(); await removeTree(root);
  }
});

test("a prompt stopped by the caller's own abort returns 204 and records a cancelled turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-abort-"));
  const dir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(dir, { recursive: true });
  const store = new StateStore(path.join(dir, "pnp.db"));
  const core = new GatewayCore(store, new MockPack({ delayMs: 500 }), new MockIntegration(),
    { dataDirectory: dir, cancelGraceMs: 100 });
  const app = buildApp(core);
  try {
    const created = await app.inject({ method: "POST", url: "/session", payload: { directory: workspace } });
    const id = (created.json() as { id: string }).id;
    const prompt = app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", text: "hello" }] } });
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await app.inject({ method: "GET", url: "/session/status" })).json()[id]?.type === "busy") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/abort` })).statusCode, 200);
    // contracts.md section 3.3: the stop the caller asked for is a normal ending, not a conflict.
    assert.equal((await prompt).statusCode, 204);
    const history = (await app.inject({ method: "GET", url: `/session/${id}/message` })).json();
    assert.equal(history.at(-1).info.finish, "cancelled");
    assert.equal(JSON.stringify(history.at(-1).parts).includes("step-finish"), false);
    assert.equal((await app.inject({ method: "GET", url: "/session/status" })).json()[id].type, "idle");
  } finally {
    await app.close(); await store.close(); await removeTree(root);
  }
});

test("the model identifier the environment supplies is the one model.resolved publishes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-model-id-"));
  const dir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(dir, { recursive: true });
  const settings = path.join(root, "settings.json");
  await writeFile(settings, JSON.stringify({
    version: 1,
    common: {
      model: {
        default: { providerID: "competition" },
        models: [{
          selection: { providerID: "competition", modelID: "default" },
          modelIDEnvironment: "PNP_MODEL_ID",
          endpointEnvironment: "PNP_MODEL_ENDPOINT",
          protocol: "openai-chat",
        }],
      },
      permissions: { default: "allow", operations: {} },
    },
    cores: { mock: {} },
  }));
  const store = new StateStore(path.join(dir, "pnp.db"));
  const integration = await loadIntegration({
    kind: "configured", development: false, engineDevelopmentOnly: false, engineId: "mock",
    settingsPath: settings,
    environment: { PNP_MODEL_ENDPOINT: "https://model.test.invalid/v1", PNP_MODEL_ID: "endpoint-model" },
  });
  const core = new GatewayCore(store, new MockPack(), integration, { dataDirectory: dir });
  const app = buildApp(core);
  try {
    const created = await app.inject({ method: "POST", url: "/session", payload: { directory: workspace } });
    const id = (created.json() as { id: string }).id;
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", text: "hello" }], model: { providerID: "evaluator", modelID: "unknown-1" } } })).statusCode, 204);
    const resolved = (await core.eventsSince(0)).filter((event) => event.type === "model.resolved").at(-1);
    // The trace shows what the endpoint was actually asked for, not the placeholder in the file.
    assert.deepEqual(resolved?.properties.selected, { providerID: "competition", modelID: "endpoint-model" });
    assert.deepEqual(resolved?.properties.requested, { providerID: "evaluator", modelID: "unknown-1" });
  } finally {
    await app.close(); await store.close(); await removeTree(root);
  }
});
