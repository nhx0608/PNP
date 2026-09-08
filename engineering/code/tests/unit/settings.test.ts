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
  // One model, named entirely by environment variable, so the delivery carries no deployment
  // address and an operator configures the run without editing this file.
  assert.deepEqual(effective.model.default, { providerID: "competition", modelID: "default" });
  assert.deepEqual(effective.model.models.map((entry) => entry.selection),
    [{ providerID: "competition", modelID: "default" }]);
  assert.deepEqual(effective.permissions, { default: "allow", operations: {} });
  // The shipped MCP server is addressed through the package-root placeholder, so it resolves
  // wherever the delivery was unpacked, and the Node executable running the gateway starts it.
  const office = effective.mcp.servers.find((server) => server.id === "office");
  assert.equal(office?.transport, "stdio");
  assert.equal(office?.transport === "stdio" && office.command, process.execPath);
  assert.ok(office?.transport === "stdio" && path.isAbsolute(office.args[0]!));
  assert.equal(office?.sideEffect, "write");
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

test("an explicit unified settings file overrides legacy profile model and policy", async () => {
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

test("a deployment override reaches both the decision and the policy published on the context", async () => {
  const provider = await loadIntegration({
    kind: "configured",
    development: false,
    engineDevelopmentOnly: false,
    engineId: "opencode",
    environment: {
      PNP_CONFIGURED_POLICY_OVERRIDES: JSON.stringify({ write: "ask" }),
      PNP_MODEL_ENDPOINT: "http://127.0.0.1:9001/v1",
      PNP_MODEL_ID: "endpoint-model",
    },
  });
  const context = await provider.prepare({
    session,
    request: { parts: [{ type: "text", text: "test" }], model: { providerID: "", modelID: "" } },
    signal: new AbortController().signal,
  });
  // The shipped settings allow everything, so this operation reaches an approval loop only if the override is
  // part of the very structure an Engine Pack projects, not just of the gateway's own decision.
  assert.equal(context.permissions?.default, "allow");
  assert.equal(context.permissions?.operations.write, "ask");
  const decision = await context.authorize({ kind: "permission", operation: "write", payload: {} });
  assert.deepEqual(decision, { effect: "ask", reasonCode: "CONFIGURED_OVERRIDE" });
  assert.equal((await context.authorize({ kind: "permission", operation: "read", payload: {} })).reasonCode, "SETTINGS_DEFAULT");
});

test("a relative settings path resolves against the package root, not the working directory", async () => {
  // A deployment writes `config/settings.json` because it cannot know where the delivery was
  // unpacked; the launcher's working directory must not decide which file that is.
  const fromRoot = await loadPnpSettings({ engineId: "opencode", settingsPath: "config/settings.json" });
  assert.deepEqual(fromRoot.model.default, { providerID: "competition", modelID: "default" });
  await assert.rejects(loadPnpSettings({ engineId: "opencode", settingsPath: "config/absent.json" }), { code: "SETTINGS_INVALID" });
});
test("settings reject Core defaults missing from the effective catalog", async () => {
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
