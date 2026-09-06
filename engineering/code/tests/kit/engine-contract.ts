import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { GatewayCore } from "../../src/core/gateway-core.ts";
import { StateStore } from "../../src/storage/store.ts";
import type { EnginePack, IntegrationProvider, PromptRequest } from "../../src/contracts/index.ts";
import { removeTree } from "./fs.ts";
export function engineContract(name: string, factory: () => Promise<{ pack: EnginePack; integration: IntegrationProvider; request: PromptRequest }>): void {
  test(`${name}: public engine contract`, { timeout: 120_000 }, async () => {
    const { pack, integration, request } = await factory();
    const root = await mkdtemp(path.join(tmpdir(), "pnp-engine-contract-"));
    const data = path.join(root, "data");
    await mkdir(data, { recursive: true });
    const store = new StateStore(path.join(data, "pnp.db"));
    const core = new GatewayCore(store, pack, integration, { dataDirectory: data, runTimeoutMs: 90_000 });
    try {
      const s = await core.createSession(path.join(root, "workspace"));
      const seen: string[] = [];
      core.journal.subscribe((e) => seen.push(e.type));
      await core.run(s.id, request);
      assert.equal((await core.getSession(s.id)).status, "idle");
      assert.equal((await core.messages(s.id)).at(-1)?.info?.finish, "stop");
      assert.equal(seen.at(-1), "session.idle");
      assert.ok((await core.getSession(s.id)).native?.nativeId);
      await core.run(s.id, request);
      assert.equal((await core.messages(s.id)).filter((m) => m.role === "user").length, 2);
      await core.deleteSession(s.id);
      await assert.rejects(core.getSession(s.id), { code: "NOT_FOUND" });
    } finally { await core.close(); await store.close(); await removeTree(root); }
  });
}
