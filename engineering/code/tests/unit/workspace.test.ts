import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateStore } from "../../src/storage/store.ts";
import { GatewayCore } from "../../src/core/gateway-core.ts";
import { MockPack } from "../../src/engines/mock/pack.ts";
import { MockIntegration } from "../../src/integration/mock/provider.ts";
import { normalizeWorkspace } from "../../src/security/workspace.ts";
import { removeTree } from "../kit/fs.ts";

async function bed() {
  // On Windows tmpdir() can be an 8.3 short name while the session records the real path.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pnp-workspace-")));
  const dataDirectory = path.join(root, "data");
  await mkdir(dataDirectory, { recursive: true });
  return { root, dataDirectory, options: { dataDirectory } };
}
async function exists(target: string): Promise<boolean> {
  try { return (await stat(target)).isDirectory(); }
  catch { return false; }
}

test("a working directory that does not exist yet is created rather than refused", async () => {
  const b = await bed();
  try {
    const target = path.join(b.root, "workspace", "case-1");
    const normalized = await normalizeWorkspace(target, b.options);
    assert.equal(normalized.created, true);
    assert.equal(await exists(normalized.directory), true);
    // An existing directory is used as it is, and saying so is not the same as having made it.
    const again = await normalizeWorkspace(target, b.options);
    assert.equal(again.created, false);
    assert.equal(again.directory, normalized.directory);
  } finally { await removeTree(b.root); }
});

test("creation stops at the boundaries: root, the data directory, a file and a relative path", async () => {
  const b = await bed();
  try {
    await assert.rejects(normalizeWorkspace(path.parse(b.root).root, b.options),
      { code: "VALIDATION_ERROR", status: 400 });
    // Nothing may be planted inside the gateway's own state, whether or not it exists yet.
    await assert.rejects(normalizeWorkspace(b.dataDirectory, b.options), { code: "VALIDATION_ERROR", status: 400 });
    await assert.rejects(normalizeWorkspace(path.join(b.dataDirectory, "native", "sneak"), b.options),
      { code: "VALIDATION_ERROR", status: 400 });
    assert.equal(await exists(path.join(b.dataDirectory, "native", "sneak")), false);
    const file = path.join(b.root, "a-file.txt");
    await writeFile(file, "not a directory", "utf8");
    await assert.rejects(normalizeWorkspace(file, b.options), { code: "VALIDATION_ERROR", status: 400 });
    await assert.rejects(normalizeWorkspace(path.join(file, "under-a-file"), b.options),
      { code: "VALIDATION_ERROR", status: 400 });
    await assert.rejects(normalizeWorkspace("relative/workspace", b.options), { code: "VALIDATION_ERROR", status: 400 });
  } finally { await removeTree(b.root); }
});

test("a created directory is recorded on the session and survives its deletion", async () => {
  const b = await bed();
  const store = new StateStore(path.join(b.dataDirectory, "pnp.db"));
  const core = new GatewayCore(store, new MockPack(), new MockIntegration(), { dataDirectory: b.dataDirectory });
  try {
    const target = path.join(b.root, "workspace", "created-for-the-case");
    const session = await core.createSession(target);
    assert.equal(session.directoryCreated, true);
    assert.equal(session.directory, target);
    assert.equal(await exists(target), true);
    // The record survives a reload: it is part of the stored session, not a runtime flag.
    assert.equal((await core.getSession(session.id)).directoryCreated, true);
    // A directory the gateway was handed is not marked as created.
    const handed = await core.createSession(path.join(b.root, "workspace"));
    assert.equal(handed.directoryCreated, undefined);

    await core.run(session.id, { parts: [{ type: "text", text: "work here" }], model: { providerID: "test", modelID: "test" } });
    await core.deleteSession(session.id);
    await assert.rejects(core.getSession(session.id), { code: "NOT_FOUND" });
    // Deletion removes what this system owns. The user's working directory is not that.
    assert.equal(await exists(target), true);
  } finally {
    await core.close();
    await store.close();
    await removeTree(b.root);
  }
});
