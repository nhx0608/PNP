import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateStore } from "../../src/storage/store.ts";
import { GatewayCore } from "../../src/core/gateway-core.ts";
import { MockPack } from "../../src/engines/mock/pack.ts";
import { MockIntegration } from "../../src/integration/mock/provider.ts";
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
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`, payload: { parts: [{ type: "text", text: "hello" }] } })).statusCode, 400);
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
