import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS, loadPnpSettings } from "../../src/config/settings.ts";
import { loadIntegration } from "../../src/integration/index.ts";
import type { Session } from "../../src/contracts/index.ts";
import { removeTree } from "../kit/fs.ts";

const session: Session = {
  id: "test", title: "", directory: tmpdir(), engineId: "opencode", channelId: "acp",
  lifecycle: "active", status: "idle", recovery: "ready", createdAt: "", updatedAt: "",
};

async function writeSettings(dir: string, value: unknown): Promise<string> {
  const file = path.join(dir, "settings.json");
  await writeFile(file, JSON.stringify(value));
  return file;
}

const commonModels = [
  {
    selection: { providerID: "shared", modelID: "m1" },
    endpoint: "http://127.0.0.1:9001/v1",
    protocol: "openai-chat",
    headerEnvironment: {},
  },
  {
    selection: { providerID: "shared", modelID: "m2" },
    endpoint: "http://127.0.0.1:9002/v1",
    protocol: "openai-chat",
    headerEnvironment: {},
  },
];

test("shipped settings are the single default runtime settings source", async () => {
  assert.match(DEFAULT_SETTINGS, /settings\.json$/);
  const effective = await loadPnpSettings({ engineId: "opencode" });
  assert.deepEqual(effective.model.default, { providerID: "competition", modelID: "default" });
  assert.ok(effective.model.models.some((entry) => entry.selection.providerID === "his" && entry.selection.modelID === "GLM-V5.1-DX"));
  assert.ok(effective.model.models.some((entry) => entry.selection.providerID === "his" && entry.selection.modelID === "Qwen-V3.6-27B-DX"));
  assert.deepEqual(effective.permissions, { default: "allow", operations: {} });
});

test("Core settings inherit common values and override only declared model and permission fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-settings-"));
  try {
    const file = await writeSettings(dir, {
      version: 1,
      common: {
        model: { default: { providerID: "shared", modelID: "m1" }, models: commonModels },
        permissions: { default: "allow", operations: { read: "allow", write: "ask" } },
      },
      cores: {
        opencode: {
          model: {
            default: { providerID: "shared", modelID: "m2" },
            models: [{
              selection: { providerID: "shared", modelID: "m2" },
              endpoint: "http://127.0.0.1:9102/v1",
              protocol: "openai-chat",
              headerEnvironment: {},
            }],
          },
          permissions: { operations: { write: "deny", bash: "ask" } },
        },
        pi: {},
      },
    });
    const opencode = await loadPnpSettings({ engineId: "opencode", settingsPath: file });
    assert.deepEqual(opencode.model.default, { providerID: "shared", modelID: "m2" });
    assert.equal(opencode.model.models.find((entry) => entry.selection.modelID === "m2")?.endpoint, "http://127.0.0.1:9102/v1");
    assert.deepEqual(opencode.permissions, {
      default: "allow",
      operations: { read: "allow", write: "deny", bash: "ask" },
    });

    const pi = await loadPnpSettings({ engineId: "pi", settingsPath: file });
    assert.deepEqual(pi.model.default, { providerID: "shared", modelID: "m1" });
    assert.equal(pi.model.models.find((entry) => entry.selection.modelID === "m2")?.endpoint, "http://127.0.0.1:9002/v1");
    assert.deepEqual(pi.permissions, { default: "allow", operations: { read: "allow", write: "ask" } });
  } finally { await removeTree(dir); }
});

test("configured integration uses the selected Core effective model and permission policy", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-settings-integration-"));
  try {
    const file = await writeSettings(dir, {
      version: 1,
      common: {
        model: { default: { providerID: "shared", modelID: "m1" }, models: commonModels },
        permissions: { default: "allow", operations: { read: "allow" } },
      },
      cores: {
        opencode: {
          model: { default: { providerID: "shared", modelID: "m2" } },
          permissions: { operations: { write: "ask", bash: "deny" } },
        },
      },
    });
    const provider = await loadIntegration({
      kind: "configured",
      development: false,
      engineDevelopmentOnly: false,
      engineId: "opencode",
      settingsPath: file,
      environment: {},
    });
    const context = await provider.prepare({
      session,
      request: { parts: [{ type: "text", text: "test" }], model: { providerID: "", modelID: "" } },
      signal: new AbortController().signal,
    });
    assert.deepEqual(context.model.selection, { providerID: "shared", modelID: "m2" });
    assert.equal((await context.authorize({ kind: "permission", operation: "read", payload: {} })).effect, "allow");
    assert.equal((await context.authorize({ kind: "permission", operation: "write", payload: {} })).effect, "ask");
    assert.equal((await context.authorize({ kind: "permission", operation: "bash", payload: {} })).effect, "deny");
    assert.equal((await context.authorize({ kind: "permission", operation: "other", payload: {} })).effect, "allow");
  } finally { await removeTree(dir); }
});

test("an explicit unified settings file overrides legacy profile model and policy while retaining its tools", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-settings-legacy-"));
  try {
    const settings = await writeSettings(dir, {
      version: 1,
      common: {
        model: { default: { providerID: "shared", modelID: "m1" }, models: [commonModels[0]] },
        permissions: { default: "allow", operations: { write: "ask" } },
      },
      cores: {},
    });
    const profile = path.join(dir, "profile.json");
    await writeFile(profile, JSON.stringify({
      models: [{
        selection: { providerID: "legacy", modelID: "legacy" }, endpoint: "http://127.0.0.1:9999/v1",
        protocol: "openai-chat", headerEnvironment: {},
      }],
      tools: [],
      policy: { default: "deny", operations: {} },
    }));
    const provider = await loadIntegration({
      kind: "configured", development: false, engineDevelopmentOnly: false, engineId: "opencode",
      configuredProfile: profile, settingsPath: settings, environment: {},
    });
    const context = await provider.prepare({
      session,
      request: { parts: [{ type: "text", text: "test" }], model: { providerID: "", modelID: "" } },
      signal: new AbortController().signal,
    });
    assert.deepEqual(context.model.selection, { providerID: "shared", modelID: "m1" });
    assert.equal((await context.authorize({ kind: "permission", operation: "write", payload: {} })).effect, "ask");
    assert.equal((await context.authorize({ kind: "permission", operation: "other", payload: {} })).effect, "allow");
  } finally { await removeTree(dir); }
});

test("settings reject relative explicit paths and Core defaults missing from the effective catalog", async () => {
  await assert.rejects(loadPnpSettings({ engineId: "opencode", settingsPath: "relative/settings.json" }), { code: "SETTINGS_INVALID" });
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-settings-invalid-"));
  try {
    const file = await writeSettings(dir, {
      version: 1,
      common: {
        model: { default: { providerID: "shared", modelID: "m1" }, models: [commonModels[0]] },
        permissions: { default: "allow", operations: {} },
      },
      cores: { opencode: { model: { default: { providerID: "shared", modelID: "missing" } } } },
    });
    await assert.rejects(loadPnpSettings({ engineId: "opencode", settingsPath: file }), { code: "SETTINGS_INVALID" });
  } finally { await removeTree(dir); }
});
