import { test } from "node:test";
import assert from "node:assert/strict";
import { loadOpenCodeEngineConfig, parseOpenCodeEngineConfig } from "../../../src/engines/opencode/config.ts";

function validConfig(): Record<string, unknown> {
  return {
    id: "opencode", channel: "acp", implementationEntry: "src/engines/opencode/pack.ts",
    engineVersion: "1.18.27", engineVersionLocked: true, protocolVersion: 1,
    distribution: { kind: "npm-global", packageNameCandidates: ["opencode-ai"], windowsNativeSupport: "official-discouraged" },
    acp: { subcommandArgs: ["acp"] },
    executable: {
      kindEnvironmentVariable: "PNP_OPENCODE_EXECUTABLE_KIND", defaultKind: "node-script",
      exe: { configuredPath: null, environmentVariable: "PNP_OPENCODE_EXE_PATH", wellKnownPaths: [] },
      node: { configuredPath: null, environmentVariable: "PNP_OPENCODE_NODE_PATH", wellKnownPaths: [], fallbackToHostRuntime: true },
      script: { configuredPath: null, environmentVariable: "PNP_OPENCODE_SCRIPT_PATH", wellKnownPaths: [] },
    },
    redirect: { variables: { HOME: "home" } },
    model: { policy: "launch" },
    headerEnvironmentPrefix: "PNP_OPENCODE_HEADER_",
    timeouts: { requestMs: 30000, cancelGraceMs: 2000, cancelAckMs: 1000 },
    capabilityEvidence: "unverified",
  };
}

test("parseOpenCodeEngineConfig accepts a well-formed config", () => {
  const parsed = parseOpenCodeEngineConfig(validConfig());
  assert.equal(parsed.id, "opencode");
  assert.equal(parsed.executable.defaultKind, "node-script");
  assert.equal(parsed.model.policy, "launch");
  assert.equal(parsed.capabilityEvidence, "unverified");
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

test("the shipped config/engines/opencode.json loads and validates, and is honestly unverified", async () => {
  const config = await loadOpenCodeEngineConfig();
  assert.equal(config.id, "opencode");
  assert.equal(config.channel, "acp");
  assert.deepEqual(config.acp.subcommandArgs, ["acp"]);
  assert.equal(config.capabilityEvidence, "unverified");
});
