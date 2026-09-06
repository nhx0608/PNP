import { test } from "node:test";
import assert from "node:assert/strict";
import { loadOpenCodeEngineConfig, parseOpenCodeEngineConfig } from "../../../src/engines/opencode/config.ts";

function validConfig(): Record<string, unknown> {
  return {
    id: "opencode", channel: "acp", implementationEntry: "src/engines/opencode/pack.ts",
    engineVersion: "1.18.27", engineVersionLocked: true, protocolVersion: 1,
    distribution: { kind: "npm-global-native-binary", packageNameCandidates: ["opencode-ai"], windowsNativeSupport: "supported-not-recommended" },
    acp: { subcommandArgs: ["acp"] },
    executable: {
      kindEnvironmentVariable: "PNP_OPENCODE_EXECUTABLE_KIND", defaultKind: "exe",
      exe: { configuredPath: null, environmentVariable: "PNP_OPENCODE_EXE_PATH", wellKnownPaths: [] },
      node: { configuredPath: null, environmentVariable: "PNP_OPENCODE_NODE_PATH", wellKnownPaths: [], fallbackToHostRuntime: true },
      script: { configuredPath: null, environmentVariable: "PNP_OPENCODE_SCRIPT_PATH", wellKnownPaths: [] },
    },
    redirect: { variables: { HOME: "home" } },
    model: { policy: "launch" },
    headerEnvironmentPrefix: "PNP_OPENCODE_HEADER_",
    timeouts: { requestMs: 30000, cancelGraceMs: 2000, cancelAckMs: 1000 },
    capabilityEvidence: "probed",
  };
}

test("parseOpenCodeEngineConfig accepts a well-formed config", () => {
  const parsed = parseOpenCodeEngineConfig(validConfig());
  assert.equal(parsed.id, "opencode");
  assert.equal(parsed.executable.defaultKind, "exe");
  assert.equal(parsed.model.policy, "launch");
  assert.equal(parsed.capabilityEvidence, "probed");
});

test("parseOpenCodeEngineConfig rejects a wrong id with ENGINE_CONFIG_INVALID", () => {
  const raw = validConfig();
  raw["id"] = "hermes";
  assert.throws(() => parseOpenCodeEngineConfig(raw), { code: "ENGINE_CONFIG_INVALID" });
});

test("parseOpenCodeEngineConfig rejects a non-object payload", () => {
  assert.throws(() => parseOpenCodeEngineConfig("not-an-object"), { code: "ENGINE_CONFIG_INVALID" });
  assert.throws(() => parseOpenCodeEngineConfig(null), { code: "ENGINE_CONFIG_INVALID" });
  assert.throws(() => parseOpenCodeEngineConfig([1, 2, 3]), { code: "ENGINE_CONFIG_INVALID" });
});

test("parseOpenCodeEngineConfig rejects a missing required field", () => {
  const raw = validConfig();
  delete raw["engineVersion"];
  assert.throws(() => parseOpenCodeEngineConfig(raw), { code: "ENGINE_CONFIG_INVALID" });
});

test("parseOpenCodeEngineConfig rejects an invalid model.policy", () => {
  const raw = validConfig();
  raw["model"] = { policy: "always-on" };
  assert.throws(() => parseOpenCodeEngineConfig(raw), { code: "ENGINE_CONFIG_INVALID" });
});

test("parseOpenCodeEngineConfig rejects an invalid executable.defaultKind", () => {
  const raw = validConfig();
  (raw["executable"] as Record<string, unknown>)["defaultKind"] = "wsl";
  assert.throws(() => parseOpenCodeEngineConfig(raw), { code: "ENGINE_CONFIG_INVALID" });
});

test("parseOpenCodeEngineConfig rejects a non-positive timeout", () => {
  const raw = validConfig();
  (raw["timeouts"] as Record<string, unknown>)["requestMs"] = 0;
  assert.throws(() => parseOpenCodeEngineConfig(raw), { code: "ENGINE_CONFIG_INVALID" });
});

test("parseOpenCodeEngineConfig rejects an unknown capabilityEvidence value", () => {
  const raw = validConfig();
  raw["capabilityEvidence"] = "trust-me";
  assert.throws(() => parseOpenCodeEngineConfig(raw), { code: "ENGINE_CONFIG_INVALID" });
});

test("nativePermissions is optional, defaults to engine-default, and rejects anything else", () => {
  assert.equal(parseOpenCodeEngineConfig(validConfig()).nativePermissions, "engine-default");
  const explicit = validConfig();
  explicit["nativePermissions"] = "engine-default";
  assert.equal(parseOpenCodeEngineConfig(explicit).nativePermissions, "engine-default");
  const ask = validConfig();
  ask["nativePermissions"] = "ask";
  assert.equal(parseOpenCodeEngineConfig(ask).nativePermissions, "ask");
  for (const bad of ["allow", "deny", true, null, {}]) {
    const raw = validConfig();
    raw["nativePermissions"] = bad;
    assert.throws(() => parseOpenCodeEngineConfig(raw), { code: "ENGINE_CONFIG_INVALID" }, `accepted ${JSON.stringify(bad)}`);
  }
});

test("the shipped config/engines/opencode.json matches the real OpenCode distribution", async () => {
  const config = await loadOpenCodeEngineConfig();
  assert.equal(config.id, "opencode");
  assert.equal(config.channel, "acp");
  assert.deepEqual(config.acp.subcommandArgs, ["acp"], "opencode acp takes no further arguments");
  // The published package ships a Bun-compiled executable and no script entry, so exe is the only default that
  // can launch a stock install.
  assert.equal(config.executable.defaultKind, "exe");
  assert.ok(config.executable.exe.wellKnownPaths.length > 0);
  for (const template of config.executable.exe.wellKnownPaths) {
    assert.match(template, /\.exe$/, "every well-known Windows candidate is a real executable, never an npm .cmd shim");
  }
  // One package name, not a list of guesses: opencode-ai is the confirmed publisher of the CLI.
  assert.deepEqual(config.distribution.packageNameCandidates, ["opencode-ai"]);
  assert.equal(config.engineVersionLocked, true);
  assert.equal(config.engineVersion, "1.18.27");
  assert.equal(config.nativePermissions, "engine-default", "the gateway does not turn on engine-side prompting by default");
  // Nothing here has been observed on the Windows target yet, so nothing claims to be verified.
  assert.notEqual(config.capabilityEvidence, "verified");
});
