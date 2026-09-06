import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveAsset } from "../../src/assets/resolver.ts";
import { selectEngine, loadEngine } from "../../src/registry/index.ts";
import { ConfiguredIntegration } from "../../src/integration/configured/provider.ts";
import { loadIntegration, probeIntegration } from "../../src/integration/index.ts";
import type { Session } from "../../src/contracts/index.ts";

test("engine selection requires explicit input and rejects conflicting selectors", async () => {
  assert.equal(selectEngine(undefined, "pi"), "pi");
  assert.equal(selectEngine("pi", "pi"), "pi");
  assert.throws(() => selectEngine("pi", "opencode"));
  assert.throws(() => selectEngine(undefined, undefined));
  await assert.rejects(loadEngine("mock", false));
  await assert.rejects(loadEngine("unknown", true));
  assert.equal((await loadEngine("mock", true)).descriptor.developmentOnly, true);
});

test("assets are content-addressed and cannot leave an approved root", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-assets-"));
  try {
    const base = path.join(dir, "approved"); await mkdir(base);
    await writeFile(path.join(base, "guide.md"), "approved instructions");
    await writeFile(path.join(dir, "outside.md"), "not approved");
    const asset = await resolveAsset(base, { id: "guide", kind: "instruction", path: "guide.md", required: true });
    assert.equal(asset.sha256.length, 64);
    await assert.rejects(resolveAsset(base, { ...asset, sha256: "invalid" }));
    await assert.rejects(resolveAsset(base, { ...asset, path: "../outside.md", sha256: undefined }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("model profiles reject unapproved models, credentials in URL, and insecure remote transport", async () => {
  const selection = { providerID: "test", modelID: "test" };
  const session: Session = { id: "test", title: "", directory: tmpdir(), engineId: "mock", channelId: "test",
    lifecycle: "active", status: "idle", recovery: "ready", createdAt: "", updatedAt: "" };
  const input = { session, request: { model: selection, parts: [{ type: "text" as const, text: "test" }] }, signal: new AbortController().signal };
  const create = (endpoint: string) => new ConfiguredIntegration([{ selection, endpoint, protocol: "openai-chat", headerEnvironment: {} }]);
  await assert.rejects(new ConfiguredIntegration([]).prepare(input));
  await assert.rejects(create("http://example.test/v1").prepare(input));
  await assert.rejects(create("file://localhost/v1").prepare(input));
  await assert.rejects(create("https://user:secret@example.test/v1").prepare(input));
  const ctx = await create("http://127.0.0.1:9000/v1").prepare(input);
  // Competition default is allow (see docs/engineering-review-2.md §3); an explicit deny still
  // wins whenever config supplies one, which the "no fallback" test below covers.
  assert.equal((await ctx.authorize({ kind: "permission", operation: "file.write", payload: {} })).effect, "allow");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(create("https://example.test/v1").prepare({ ...input, signal: controller.signal }));
});

test("configured integration is explicit and strict, and mock never substitutes for a real engine", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-configured-"));
  const profile = path.join(dir, "configured.json");
  try {
    await writeFile(profile, JSON.stringify({
      models: [{ selection: { providerID: "approved", modelID: "model" }, endpoint: "https://example.test/v1",
        protocol: "openai-chat", headerEnvironment: { Authorization: "TEST_AUTH" } }],
      tools: [], policy: { default: "deny", operations: { "file.read": "allow" } },
    }));
    // configured is usable outside development: it is the only implemented model path for a real engine.
    const production = await loadIntegration({ kind: "configured", development: false, engineDevelopmentOnly: false,
      configuredProfile: profile, environment: { TEST_AUTH: "secret" } });
    assert.equal(production.id, "configured");
    await assert.rejects(loadIntegration({ kind: "configured", development: true, engineDevelopmentOnly: false }),
      { code: "INTEGRATION_CONFIG_INVALID" });
    // A real engine must never fall back to mock, in development or otherwise.
    await assert.rejects(loadIntegration({ kind: "mock", development: true, engineDevelopmentOnly: false }),
      { code: "MOCK_FORBIDDEN" });
    await assert.rejects(loadIntegration({ kind: "mock", development: false, engineDevelopmentOnly: true }),
      { code: "MOCK_FORBIDDEN" });
    assert.equal((await loadIntegration({ kind: "mock", development: true, engineDevelopmentOnly: true })).id, "mock");
    // The default choice follows the engine, and the unimplemented internal provider fails at boot, not at first prompt.
    assert.equal((await loadIntegration({ kind: undefined, development: true, engineDevelopmentOnly: true })).id, "mock");
    const fallback = await loadIntegration({ kind: undefined, development: false, engineDevelopmentOnly: false });
    assert.equal(fallback.id, "internal");
    await assert.rejects(probeIntegration(fallback), { code: "INTEGRATION_UNAVAILABLE" });
    const configured = await loadIntegration({ kind: "configured", development: true, engineDevelopmentOnly: false,
      configuredProfile: profile, environment: { TEST_AUTH: "secret" } });
    assert.equal(configured.id, "configured");
    const selected = await configured.prepare({ session: { id: "test", title: "", directory: dir, engineId: "opencode", channelId: "acp",
      lifecycle: "active", status: "idle", recovery: "ready", createdAt: "", updatedAt: "" },
      request: { parts: [{ type: "text", text: "test" }], model: { providerID: "approved", modelID: "model" } },
      signal: new AbortController().signal });
    assert.equal(selected.model.headers.Authorization, "secret");
    assert.equal((await selected.authorize({ kind: "permission", operation: "file.read", payload: {} })).effect, "allow");
    assert.equal((await selected.authorize({ kind: "permission", operation: "file.write", payload: {} })).effect, "deny");
    await assert.rejects(loadIntegration({ kind: "unknown", development: true, engineDevelopmentOnly: false }),
      { code: "INTEGRATION_NOT_FOUND" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
