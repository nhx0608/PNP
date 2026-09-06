import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildNativeConfigPayload, buildRedirectPlan, mapHeadersToEnv, resolveProviderPackage, writeNativeConfig,
} from "../../../src/engines/opencode/native-config.ts";
import { parseOpenCodeEngineConfig, type OpenCodeEngineConfig } from "../../../src/engines/opencode/config.ts";
import type { ResolvedModel } from "../../../src/contracts/index.ts";

function config(): OpenCodeEngineConfig {
  return parseOpenCodeEngineConfig({
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
    redirect: {
      variables: {
        XDG_CONFIG_HOME: "xdg-config", XDG_DATA_HOME: "xdg-data", XDG_CACHE_HOME: "xdg-cache",
        HOME: "home", USERPROFILE: "home", APPDATA: "appdata", LOCALAPPDATA: "localappdata",
      },
    },
    model: { policy: "launch" },
    headerEnvironmentPrefix: "PNP_OPENCODE_HEADER_",
    timeouts: { requestMs: 30000, cancelGraceMs: 2000, cancelAckMs: 1000 },
    capabilityEvidence: "unverified",
  });
}
function model(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    selection: { providerID: "acme-internal", modelID: "acme-large-v3" },
    protocol: "openai-chat",
    endpoint: "https://model.internal.example.invalid/v1",
    headers: { Authorization: "Bearer super-secret-token-value", "X-App-Id": "billing-9001" },
    ...overrides,
  };
}

test("resolveProviderPackage maps confirmed protocols and fails closed on anything else", () => {
  assert.equal(resolveProviderPackage("openai-chat"), "@ai-sdk/openai-compatible");
  assert.equal(resolveProviderPackage("anthropic-messages"), "@ai-sdk/anthropic");
  assert.throws(() => resolveProviderPackage("custom"), { code: "ENGINE_MODEL_PROTOCOL_UNSUPPORTED" });
  assert.throws(() => resolveProviderPackage("test"), { code: "ENGINE_MODEL_PROTOCOL_UNSUPPORTED" });
});

test("mapHeadersToEnv reuses the Authorization header's env var for apiKey and sanitizes odd names", () => {
  const mapping = mapHeadersToEnv({ Authorization: "Bearer x", "X-App-Id!!": "v", "X-App-Id?": "v2" }, "PNP_OPENCODE_HEADER_");
  assert.equal(mapping.apiKeyEnvName, "PNP_OPENCODE_HEADER_AUTHORIZATION");
  assert.equal(mapping.secretEnv["PNP_OPENCODE_HEADER_AUTHORIZATION"], "Bearer x");
  assert.equal(mapping.configTokens["Authorization"], "$PNP_OPENCODE_HEADER_AUTHORIZATION");
  // Two header names sanitize to the same env suffix; the mapping must not silently collide.
  const first = mapping.configTokens["X-App-Id!!"]!;
  const second = mapping.configTokens["X-App-Id?"]!;
  assert.notEqual(first, second);
  assert.equal(mapping.secretEnv[first.slice(1)], "v");
  assert.equal(mapping.secretEnv[second.slice(1)], "v2");
});

test("mapHeadersToEnv synthesizes a non-secret placeholder apiKey when there is no Authorization header", () => {
  const mapping = mapHeadersToEnv({ "X-Api-Key": "abc" }, "PNP_OPENCODE_HEADER_");
  assert.equal(mapping.apiKeyEnvName, "PNP_OPENCODE_HEADER_APIKEY_UNUSED");
  assert.equal(mapping.secretEnv["PNP_OPENCODE_HEADER_APIKEY_UNUSED"], "unused");
});

test("buildNativeConfigPayload never places a header value or bearer token in the generated JSON", () => {
  const payload = buildNativeConfigPayload(model(), [], "PNP_OPENCODE_HEADER_");
  const serialized = JSON.stringify(payload.json);
  assert.doesNotMatch(serialized, /super-secret-token-value/);
  assert.doesNotMatch(serialized, /billing-9001/);
  assert.match(serialized, /\$PNP_OPENCODE_HEADER_AUTHORIZATION/);
  assert.match(serialized, /\$PNP_OPENCODE_HEADER_X_APP_ID/);
  const provider = (payload.json as Record<string, unknown>)["provider"] as Record<string, unknown>;
  const entry = provider["acme-internal"] as Record<string, unknown>;
  assert.equal(entry["npm"], "@ai-sdk/openai-compatible");
  assert.equal((payload.json as Record<string, unknown>)["model"], "acme-internal/acme-large-v3");
  assert.equal((payload.json as Record<string, unknown>)["share"], "disabled");
  assert.equal(payload.secretEnv["PNP_OPENCODE_HEADER_AUTHORIZATION"], "Bearer super-secret-token-value");
});

test("buildNativeConfigPayload fails closed on a missing endpoint and an unsupported protocol", () => {
  assert.throws(() => buildNativeConfigPayload(model({ endpoint: undefined }), [], "PNP_OPENCODE_HEADER_"), { code: "ENGINE_MODEL_ENDPOINT_MISSING" });
  assert.throws(() => buildNativeConfigPayload(model({ protocol: "custom" }), [], "PNP_OPENCODE_HEADER_"), { code: "ENGINE_MODEL_PROTOCOL_UNSUPPORTED" });
});

test("buildRedirectPlan roots every redirect variable under nativeDataDirectory/opencode and de-duplicates config roots", () => {
  const plan = buildRedirectPlan("/private/session-42", config());
  for (const value of Object.values(plan.env)) assert.ok(value.startsWith(`${path.join("/private/session-42", "opencode")}${path.sep}`));
  assert.equal(plan.env["HOME"], path.join("/private/session-42", "opencode", "home"));
  assert.equal(plan.env["XDG_CONFIG_HOME"], path.join("/private/session-42", "opencode", "xdg-config"));
  assert.equal(new Set(plan.configRoots).size, plan.configRoots.length);
  assert.equal(plan.configRoots.length, 2);
});

test("writeNativeConfig writes the private config to every candidate root, never under the workspace, with no plaintext secret on disk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-opencode-native-config-"));
  try {
    const nativeDataDirectory = path.join(root, "native");
    const written = await writeNativeConfig(nativeDataDirectory, config(), model(), []);
    assert.equal(written.configPaths.length, 2);
    for (const file of written.configPaths) {
      assert.ok(file.startsWith(nativeDataDirectory + path.sep), `${file} must live under the private native directory`);
      const text = await readFile(file, "utf8");
      assert.doesNotMatch(text, /super-secret-token-value/);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      assert.equal(parsed["model"], "acme-internal/acme-large-v3");
    }
    assert.equal(written.secretEnv["PNP_OPENCODE_HEADER_AUTHORIZATION"], "Bearer super-secret-token-value");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeNativeConfig lists projected instruction paths in every mirrored config file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-opencode-native-config-"));
  try {
    const nativeDataDirectory = path.join(root, "native");
    const instructionPath = path.join(nativeDataDirectory, "opencode", "assets", "instructions", "inst-1", "AGENTS.md");
    const written = await writeNativeConfig(nativeDataDirectory, config(), model(), [instructionPath]);
    for (const file of written.configPaths) {
      const parsed = JSON.parse(await readFile(file, "utf8")) as { instructions?: string[] };
      assert.deepEqual(parsed.instructions, [instructionPath]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
