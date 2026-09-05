import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveAsset } from "../../src/assets/resolver.ts";
import { selectEngine, loadEngine } from "../../src/registry/index.ts";
import { ConfiguredIntegration } from "../../src/integration/configured/provider.ts";
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
  assert.equal((await ctx.authorize({ kind: "permission", operation: "file.write", payload: {} })).effect, "deny");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(create("https://example.test/v1").prepare({ ...input, signal: controller.signal }));
});
