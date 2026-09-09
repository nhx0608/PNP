import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectConfiguredCapabilities, assertConfiguredCapabilitiesApplicable } from "../../src/config/capability-readiness.ts";
import { loadPnpSettings } from "../../src/config/settings.ts";
import { loadIntegration } from "../../src/integration/index.ts";
import { ConfiguredIntegration } from "../../src/integration/configured/provider.ts";
import { removeTree } from "../kit/fs.ts";

function document(extra: Record<string, unknown>) {
  return {
    version: 1,
    common: {
      model: {
        default: { providerID: "test", modelID: "test" },
        models: [{ selection: { providerID: "test", modelID: "test" }, endpoint: "http://localhost:9000/v1",
          protocol: "openai-chat", headerEnvironment: {} }],
      },
      permissions: { default: "allow", operations: {} },
      ...extra,
    },
    cores: { third: {} },
  };
}
async function fixture(extra: Record<string, unknown>) {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-capability-preflight-"));
  const settingsPath = path.join(root, "settings.json");
  await writeFile(path.join(root, "entry.md"), "Capability data for a future projector.\n");
  await writeFile(settingsPath, JSON.stringify(document(extra)));
  return {
    root, settingsPath,
    load: () => loadIntegration({ kind: "configured", development: false, engineDevelopmentOnly: false,
      engineId: "third", settingsPath, environment: {} }),
  };
}

test("required new domains parse generically but runtime names every unavailable domain and asset before opening", async () => {
  const f = await fixture({ assets: {
    "knowledge-graph/v9": {
      first: { path: "entry.md", required: true },
      second: { path: "entry.md", required: true },
    },
    "future-domain": { third: { path: "entry.md", required: true } },
  } });
  try {
    const settings = await loadPnpSettings({ settingsPath: f.settingsPath, engineId: "third", environment: {} });
    assert.deepEqual(Object.keys(settings.assets).sort(), ["future-domain", "knowledge-graph/v9"]);
    const report = inspectConfiguredCapabilities(settings, "third");
    assert.equal(report.applicable, false);
    assert.equal(report.required.length, 3);
    await assert.rejects(f.load(), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "ENGINE_ASSET_KIND_UNSUPPORTED");
      for (const label of ["knowledge-graph/v9", "future-domain", "first", "second", "third"]) {
        assert.ok(error.message.includes(label), label);
      }
      return true;
    });
  } finally { await removeTree(f.root); }
});

test("optional unavailable assets are retained in a readable skip report, not falsely returned as applied assets", async () => {
  const f = await fixture({ assets: { "new-domain": { optional: { path: "entry.md", parameters: { note: "not-in-report" } } } } });
  try {
    const provider = await f.load();
    assert.ok(provider instanceof ConfiguredIntegration);
    const report = provider.capabilityReport();
    assert.deepEqual(report?.skipped, [{ kind: "new-domain", id: "optional", reason: "projection-unavailable" }]);
    assert.equal(report?.applicable, true);
    assert.equal(JSON.stringify(report).includes("not-in-report"), false);
    assert.equal(JSON.stringify(report).includes(f.root), false);
    report?.skipped.splice(0);
    assert.equal(provider.capabilityReport()?.skipped.length, 1, "callers cannot erase the provider's report");
    const context = await provider.prepare({
      session: { id: "s", title: "test", directory: f.root, engineId: "third", channelId: "test",
        lifecycle: "active", status: "idle", recovery: "ready", createdAt: "", updatedAt: "" },
      request: { parts: [{ type: "text", text: "test" }], model: { providerID: "test", modelID: "test" } },
      signal: new AbortController().signal,
    });
    assert.deepEqual(context.assets, []);
  } finally { await removeTree(f.root); }
});

test("a required asset targeted at a different engine is skipped without blocking the selected engine", async () => {
  const f = await fixture({ assets: { "new-domain": {
    scoped: { path: "missing.md", required: true, engines: ["another-engine"] },
  } } });
  try {
    const provider = await f.load();
    assert.ok(provider instanceof ConfiguredIntegration);
    assert.deepEqual(provider.capabilityReport()?.skipped, [{ kind: "new-domain", id: "scoped", reason: "not-targeted" }]);
  } finally { await removeTree(f.root); }
});

test("pack selections have an explicit loader gap instead of being accepted as executed", async () => {
  const optional = await fixture({ packs: { "office-next": { enabled: true } } });
  const required = await fixture({ packs: { "office-next": { required: true } } });
  try {
    const provider = await optional.load();
    assert.ok(provider instanceof ConfiguredIntegration);
    assert.deepEqual(provider.capabilityReport()?.skipped, [{ kind: "pack", id: "office-next", reason: "pack-loader-unavailable" }]);
    await assert.rejects(required.load(), { code: "PACK_LOADER_UNAVAILABLE" });
  } finally { await removeTree(optional.root); await removeTree(required.root); }
});

test("opaque native syntax does not silently succeed without a connected native projector", async () => {
  const f = await fixture({ native: { compaction: { reserveTokens: 8192 } } });
  try {
    const settings = await loadPnpSettings({ settingsPath: f.settingsPath, engineId: "third", environment: {} });
    assert.deepEqual(settings.native, { compaction: { reserveTokens: 8192 } });
    assert.throws(() => assertConfiguredCapabilitiesApplicable(inspectConfiguredCapabilities(settings, "third")),
      { code: "NATIVE_OPTIONS_UNSUPPORTED" });
    await assert.rejects(f.load(), { code: "NATIVE_OPTIONS_UNSUPPORTED" });
  } finally { await removeTree(f.root); }
});
