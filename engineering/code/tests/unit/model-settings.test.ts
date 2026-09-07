import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_MODEL_SETTINGS, loadIntegration, probeIntegration } from "../../src/integration/index.ts";
import type { Session } from "../../src/contracts/index.ts";
import { removeTree } from "../kit/fs.ts";

const session: Session = {
  id: "test", title: "", directory: tmpdir(), engineId: "opencode", channelId: "acp",
  lifecycle: "active", status: "idle", recovery: "ready", createdAt: "", updatedAt: "",
};

test("default real-engine integration reads the shared model-settings file", async () => {
  assert.match(DEFAULT_MODEL_SETTINGS, /model-settings\.json$/);
  const environment = {
    PNP_MODEL_ENDPOINT: "http://127.0.0.1:9000/v1",
    PNP_MODEL_AUTHORIZATION: "Bearer test-only",
    PNP_HIS_MODEL_ENDPOINT: "http://127.0.0.1:9000/v1",
    PNP_HIS_AUTHORIZATION: "Bearer his-test-only",
  };
  const provider = await loadIntegration({ kind: undefined, development: false, engineDevelopmentOnly: false, environment });
  await probeIntegration(provider);
  const defaultContext = await provider.prepare({
    session,
    request: { parts: [{ type: "text", text: "test" }], model: { providerID: "", modelID: "" } },
    signal: new AbortController().signal,
  });
  assert.deepEqual(defaultContext.model.selection, { providerID: "competition", modelID: "default" });
  const hisContext = await provider.prepare({
    session,
    request: { parts: [{ type: "text", text: "test" }], model: { providerID: "his", modelID: "GLM-V5.1-DX" } },
    signal: new AbortController().signal,
  });
  assert.deepEqual(hisContext.model.selection, { providerID: "his", modelID: "GLM-V5.1-DX" });
  assert.equal(hisContext.model.headers.Authorization, "Bearer his-test-only");
});

test("PNP_MODEL_SETTINGS-style explicit file overrides model settings for every real engine", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-model-settings-"));
  try {
    const settings = path.join(dir, "settings.json");
    await writeFile(settings, JSON.stringify({
      default: { providerID: "custom", modelID: "m2" },
      models: [
        { selection: { providerID: "custom", modelID: "m1" }, endpoint: "http://127.0.0.1:9001/v1", protocol: "openai-chat", headerEnvironment: {} },
        { selection: { providerID: "custom", modelID: "m2" }, endpoint: "http://127.0.0.1:9002/v1", protocol: "openai-chat", headerEnvironment: {} }
      ]
    }));
    const provider = await loadIntegration({ kind: "configured", development: false, engineDevelopmentOnly: false, modelSettings: settings, environment: {} });
    const context = await provider.prepare({
      session,
      request: { parts: [{ type: "text", text: "test" }], model: { providerID: "", modelID: "" } },
      signal: new AbortController().signal,
    });
    assert.deepEqual(context.model.selection, { providerID: "custom", modelID: "m2" });
  } finally { await removeTree(dir); }
});

test("shared model settings reject a default that is not configured", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-model-settings-invalid-"));
  try {
    const settings = path.join(dir, "settings.json");
    await writeFile(settings, JSON.stringify({
      default: { providerID: "custom", modelID: "missing" },
      models: [{ selection: { providerID: "custom", modelID: "m1" }, endpoint: "http://127.0.0.1:9001/v1", protocol: "openai-chat", headerEnvironment: {} }]
    }));
    await assert.rejects(loadIntegration({ kind: "configured", development: false, engineDevelopmentOnly: false, modelSettings: settings, environment: {} }), { code: "INTEGRATION_CONFIG_INVALID" });
  } finally { await removeTree(dir); }
});
