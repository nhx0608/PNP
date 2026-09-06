import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateStore } from "../../src/storage/store.ts";
import { GatewayCore } from "../../src/core/gateway-core.ts";
import { MockPack } from "../../src/engines/mock/pack.ts";
import { MockIntegration } from "../../src/integration/mock/provider.ts";
import { ConfiguredIntegration } from "../../src/integration/configured/provider.ts";
import { buildApp } from "../../src/gateway/app.ts";

test("original northbound create/prompt/message/status/delete contract", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-http-"));
  const store = new StateStore(path.join(dir, "pnp.db"));
  const core = new GatewayCore(store, new MockPack(), new MockIntegration(), { dataDirectory: dir });
  const app = buildApp(core);
  try {
    assert.equal((await app.inject({ method: "POST", url: "/session", payload: {} })).statusCode, 400);
    const created = await app.inject({ method: "POST", url: "/session", payload: { directory: dir } });
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
    await app.close(); await store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP input failures preserve safe 400, 413, and 415 semantics", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-http-errors-"));
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
    const missingPath = path.join(dir, "missing-secret-name");
    const missing = await app.inject({ method: "POST", url: "/session", payload: { directory: missingPath } });
    assert.equal(missing.statusCode, 400);
    assert.doesNotMatch(missing.body, /missing-secret-name/);
    const created = await app.inject({ method: "POST", url: "/session", payload: { directory: dir } });
    const id = (created.json() as { id: string }).id;
    const emptyAbort = await app.inject({ method: "POST", url: `/session/${id}/abort`,
      headers: { "content-type": "application/json" }, payload: "" });
    assert.equal(emptyAbort.statusCode, 200);
  } finally {
    await app.close(); await store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("an unrecognised model runs on the configured default and is published as model.resolved", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-model-"));
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
    const created = await app.inject({ method: "POST", url: "/session", payload: { directory: dir } });
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
    await app.close(); await store.close(); await rm(dir, { recursive: true, force: true });
  }
});
