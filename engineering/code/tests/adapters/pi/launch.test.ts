import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSessionPaths, writePiModelsConfig } from "../../../src/drivers/pi-rpc/launch.ts";
import type { ResolvedModel } from "../../../src/contracts/index.ts";

/**
 * Covers `writePiModelsConfig`, the mechanism that replaced an earlier (unverified, and now
 * known-incorrect) `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` environment-variable approach. A real
 * installed pi 0.85.1 process ignored `OPENAI_BASE_URL` entirely and called the real
 * `api.openai.com` instead of a local mock server; only a custom provider declared in
 * `~/.pi/agent/models.json` (redirected per-session via `PI_CODING_AGENT_DIR`) actually worked.
 * `docs/engines/pi.md` records the manual reproduction this test's expectations are drawn from.
 */
async function newPaths(): Promise<ReturnType<typeof resolveSessionPaths>> {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-pi-launch-"));
  return resolveSessionPaths(root);
}
function model(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return { selection: { providerID: "approved-test", modelID: "approved-model" }, protocol: "openai-chat", headers: {}, ...overrides };
}

test("writes an openai-chat model as a pi openai-completions provider with the bearer credential", async () => {
  const paths = await newPaths();
  await writePiModelsConfig(paths, model({ endpoint: "https://model.example.invalid/v1", headers: { authorization: "Bearer sk-live-secret" } }));
  const config = JSON.parse(await readFile(paths.modelsConfigFile, "utf8"));
  assert.deepEqual(config, {
    providers: {
      "approved-test": { api: "openai-completions", apiKey: "sk-live-secret", baseUrl: "https://model.example.invalid/v1", models: [{ id: "approved-model" }] },
    },
  });
});

test("maps anthropic-messages to pi's anthropic-messages api and uses a placeholder key when no bearer is present", async () => {
  const paths = await newPaths();
  await writePiModelsConfig(paths, model({ protocol: "anthropic-messages", selection: { providerID: "acme-anthropic", modelID: "claude-x" } }));
  const config = JSON.parse(await readFile(paths.modelsConfigFile, "utf8"));
  assert.deepEqual(config.providers["acme-anthropic"], { api: "anthropic-messages", apiKey: "pnp-unused", models: [{ id: "claude-x" }] });
});

test("writes no provider entry for protocols pi has no compatible wire format for", async () => {
  const paths = await newPaths();
  await writePiModelsConfig(paths, model({ protocol: "test" }));
  await writePiModelsConfig(paths, model({ protocol: "custom" }));
  await assert.rejects(readFile(paths.modelsConfigFile, "utf8"), { code: "ENOENT" });
});

test("a later model switch merges into the file instead of dropping the earlier provider", async () => {
  const paths = await newPaths();
  await writePiModelsConfig(paths, model({ selection: { providerID: "first", modelID: "m1" } }));
  await writePiModelsConfig(paths, model({ selection: { providerID: "second", modelID: "m2" }, protocol: "anthropic-messages" }));
  const config = JSON.parse(await readFile(paths.modelsConfigFile, "utf8"));
  assert.deepEqual(Object.keys(config.providers).sort(), ["first", "second"]);
});
