import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadLocalEnvironment } from "../../src/config/local-env.ts";
import { loadIntegration, probeIntegration } from "../../src/integration/index.ts";
import { loadPnpSettings } from "../../src/config/settings.ts";
import { summarizeMcp, safeDiagnostic } from "../../scripts/doctor-config.mjs";
import { codeRoot } from "../../scripts/lib.mjs";
import { removeTree } from "../kit/fs.ts";

test("doctor configuration uses the shipped settings and isolated local.env", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-doctor-config-"));
  try {
    const envFile = path.join(dir, "local.env");
    await writeFile(envFile, "PNP_MODEL_ENDPOINT=http://127.0.0.1:9000/v1\nPNP_MODEL_ID=test-model\nPNP_MODEL_API_KEY=simulated-key\n", "utf8");
    const environment: NodeJS.ProcessEnv = { PNP_LOCAL_ENV_FILE: envFile };
    const loaded = await loadLocalEnvironment({ environment });
    assert.deepEqual(loaded.names, ["PNP_MODEL_ENDPOINT", "PNP_MODEL_ID", "PNP_MODEL_API_KEY"]);
    const provider = await loadIntegration({ kind: undefined, development: false, engineDevelopmentOnly: false,
      engineId: "opencode", environment });
    await probeIntegration(provider);
    const settings = await loadPnpSettings({ engineId: "opencode", environment });
    const office = summarizeMcp(settings, environment).find((entry) => entry.id === "office");
    assert.ok(office?.status === "structurally_ready_unprobed" || office?.status === "missing_file");
    assert.equal(office?.commandKind, "file");
    assert.equal(JSON.stringify({ loaded, office }).includes("simulated-key"), false);
  } finally { await removeTree(dir); }
});

test("MCP doctor summary checks a real runtime entry but does not guess generic or -e arguments", () => {
  const missing = summarizeMcp({ mcp: { servers: [{ id: "missing", transport: "stdio", command: process.execPath,
    args: [path.join(tmpdir(), "missing-entry.mjs")], env: {}, enabled: true, sideEffect: "read" }] } }, {});
  assert.equal(missing[0]?.status, "missing_file");
  const evalServer = summarizeMcp({ mcp: { servers: [{ id: "eval", transport: "stdio", command: process.execPath,
    args: ["-e", "process.exit(0)"], env: {}, enabled: true, sideEffect: "read" }] } }, {});
  assert.equal(evalServer[0]?.status, "structurally_ready_unprobed");
  assert.equal("entryPresent" in evalServer[0]!, false);
  const generic = summarizeMcp({ mcp: { servers: [{ id: "generic", transport: "stdio", command: "custom-mcp",
    args: ["relative-entry.mjs"], env: {}, enabled: true, sideEffect: "external" }] } }, {});
  assert.equal(generic[0]?.status, "structurally_ready_unprobed");
  assert.equal(generic[0]?.commandKind, "generic-executable");
  assert.equal("entryPresent" in generic[0]!, false);
});

test("doctor subprocess reports missing settings nonzero without exposing simulated values", () => {
  const result = spawnSync(process.execPath, [path.join(codeRoot, "scripts", "doctor.mjs"), "--engine", "opencode"], {
    cwd: codeRoot,
    env: { ...process.env, AGENT_ENGINE: undefined, PNP_INTEGRATION: undefined, PNP_CONFIGURED_PROFILE: undefined,
      PNP_MODEL_SETTINGS: undefined, PNP_MODEL_ENDPOINT: undefined, PNP_MODEL_ID: undefined, PNP_MODEL_API_KEY: "simulated-key",
      PNP_LOCAL_ENV_FILE: path.join(tmpdir(), "doctor-no-such-local.env"), PNP_SETTINGS: path.join(tmpdir(), "doctor-no-such-settings.json") },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /configuration_invalid/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /simulated-key/);
});

test("legacy configured profile does not require unified settings", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-doctor-legacy-"));
  try {
    const profile = path.join(dir, "profile.json");
    await writeFile(profile, JSON.stringify({ models: [{ selection: { providerID: "test", modelID: "model" },
      endpoint: "http://127.0.0.1:9000/v1", protocol: "openai-chat", headerEnvironment: {} }], tools: [],
      policy: { default: "allow", operations: {} } }), "utf8");
    const provider = await loadIntegration({ kind: "configured", configuredProfile: profile, engineId: "opencode",
      development: false, engineDevelopmentOnly: false, environment: {} });
    await probeIntegration(provider);
    assert.equal(provider.id, "configured");
  } finally { await removeTree(dir); }
});

test("configured probe reports missing endpoint variable by name, while mock and internal keep their semantics", async () => {
  const environment: NodeJS.ProcessEnv = { PNP_LOCAL_ENV_FILE: path.join(tmpdir(), "doctor-no-such-local.env") };
  const configured = await loadIntegration({ kind: undefined, development: false, engineDevelopmentOnly: false,
    engineId: "opencode", environment });
  await assert.rejects(probeIntegration(configured), (error: unknown) => {
    assert.equal((error as { code: string }).code, "MODEL_ENVIRONMENT_MISSING");
    const message = (error as { message: string }).message;
    assert.match(message, /PNP_MODEL_ENDPOINT/);
    assert.doesNotMatch(message, /simulated-key|simulated-header/);
    return true;
  });
  const mock = await loadIntegration({ kind: "mock", development: true, engineDevelopmentOnly: true, environment });
  assert.equal(mock.id, "mock");
  const internal = await loadIntegration({ kind: "internal", development: false, engineDevelopmentOnly: false, environment });
  await assert.rejects(probeIntegration(internal), { code: "INTEGRATION_UNAVAILABLE" });
});

test("diagnostic errors retain only safe variable names", () => {
  const output = safeDiagnostic({ code: "MODEL_ENVIRONMENT_MISSING", message: "PNP_MODEL_ENDPOINT missing; secret-value=simulated-key" });
  assert.equal(output, "MODEL_ENVIRONMENT_MISSING; missing or invalid variables: PNP_MODEL_ENDPOINT");
});
