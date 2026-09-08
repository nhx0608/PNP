import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OPENCODE_CONFIG_DIRECTORY_ENVIRONMENT_VARIABLE, OPENCODE_CONFIG_ENVIRONMENT_VARIABLE, buildNativeConfigPayload,
  buildRedirectPlan, environmentToken, mapHeadersToEnv, resolveNativeShell, resolveProviderPackage,
  writeNativeConfig, type NativeShellProbe,
} from "../../../src/engines/opencode/native-config.ts";
import {
  parseOpenCodeEngineConfig, type OpenCodeEngineConfig, type OpenCodeNativePermissions,
} from "../../../src/engines/opencode/config.ts";
import type { Json, ResolvedModel } from "../../../src/contracts/index.ts";
import { removeTree } from "../../kit/fs.ts";

const PREFIX = "PNP_OPENCODE_HEADER_";
const BEARER_TOKEN = "super-secret-token-value";
const APP_ID = "billing-9001";

function config(nativePermissions?: OpenCodeNativePermissions): OpenCodeEngineConfig {
  return parseOpenCodeEngineConfig({
    id: "opencode", channel: "acp", implementationEntry: "src/engines/opencode/pack.ts",
    engineVersion: "1.18.29", engineVersionLocked: true, protocolVersion: 1,
    distribution: { kind: "npm-global-native-binary", packageNameCandidates: ["opencode-ai"], windowsNativeSupport: "supported-not-recommended" },
    acp: { subcommandArgs: ["acp"] },
    executable: {
      kindEnvironmentVariable: "PNP_OPENCODE_EXECUTABLE_KIND", defaultKind: "exe",
      exe: { configuredPath: null, environmentVariable: "PNP_OPENCODE_EXE_PATH", wellKnownPaths: [] },
      node: { configuredPath: null, environmentVariable: "PNP_OPENCODE_NODE_PATH", wellKnownPaths: [], fallbackToHostRuntime: true },
      script: { configuredPath: null, environmentVariable: "PNP_OPENCODE_SCRIPT_PATH", wellKnownPaths: [] },
    },
    ...(nativePermissions === undefined ? {} : { nativePermissions }),
    // Mirrors the shipped config/engines/opencode.json: the private XDG roots only. HOME, USERPROFILE, APPDATA
    // and LOCALAPPDATA are deliberately absent so the child sees the operator's real profile.
    redirect: {
      variables: {
        XDG_CONFIG_HOME: "xdg-config", XDG_DATA_HOME: "xdg-data", XDG_CACHE_HOME: "xdg-cache",
        XDG_STATE_HOME: "xdg-state",
      },
    },
    model: { policy: "launch" },
    headerEnvironmentPrefix: PREFIX,
    timeouts: { requestMs: 30000, cancelGraceMs: 2000, cancelAckMs: 1000 },
    capabilityEvidence: "probed",
  });
}
function model(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    selection: { providerID: "acme-internal", modelID: "acme-large-v3" },
    protocol: "openai-chat",
    endpoint: "https://model.internal.example.invalid/v1",
    headers: { Authorization: `Bearer ${BEARER_TOKEN}`, "X-App-Id": APP_ID },
    ...overrides,
  };
}
function providerEntry(json: Json): Record<string, unknown> {
  const provider = (json as Record<string, unknown>)["provider"] as Record<string, unknown>;
  return provider["acme-internal"] as Record<string, unknown>;
}

test("resolveProviderPackage maps confirmed protocols and fails closed on anything else", () => {
  assert.equal(resolveProviderPackage("openai-chat"), "@ai-sdk/openai-compatible");
  assert.equal(resolveProviderPackage("anthropic-messages"), "@ai-sdk/anthropic");
  assert.throws(() => resolveProviderPackage("custom"), { code: "ENGINE_MODEL_PROTOCOL_UNSUPPORTED" });
  assert.throws(() => resolveProviderPackage("test"), { code: "ENGINE_MODEL_PROTOCOL_UNSUPPORTED" });
});

// --- C. substitution syntax: {env:VAR}, never $VAR --------------------------------------------------------------

test("every generated token uses the {env:VAR} syntax OpenCode actually expands, never $VAR", () => {
  assert.equal(environmentToken("SOME_VAR"), "{env:SOME_VAR}");
  const mapping = mapHeadersToEnv({ "X-App-Id": APP_ID }, PREFIX);
  assert.equal(mapping.configTokens["X-App-Id"], `{env:${PREFIX}X_APP_ID}`);
  const serialized = JSON.stringify(buildNativeConfigPayload(model(), [], PREFIX).json);
  // No config *value* may start with "$" (the "$schema" key is not a value, hence the leading colon).
  assert.doesNotMatch(serialized, /:\s*"\$[A-Za-z_]/, "a literal $VAR would be sent to the model endpoint verbatim");
  assert.match(serialized, /\{env:PNP_OPENCODE_HEADER_/);
});

// --- C. Authorization: the bearer token backs apiKey, and is not duplicated as a header --------------------------

test("a Bearer Authorization header is stripped to the bare token and backs apiKey only", () => {
  const mapping = mapHeadersToEnv({ Authorization: `Bearer ${BEARER_TOKEN}`, "X-App-Id": APP_ID }, PREFIX);
  assert.equal(mapping.apiKeySource, "bearer-token");
  assert.equal(mapping.apiKeyEnvName, `${PREFIX}API_KEY`);
  // The bare token, not "Bearer <token>": the openai-compatible provider adds the scheme itself, and a real
  // opencode run with the full value on the wire produced "Authorization: Bearer Bearer <token>".
  assert.equal(mapping.secretEnv[`${PREFIX}API_KEY`], BEARER_TOKEN);
  assert.equal(mapping.configTokens["Authorization"], undefined, "the provider writes Authorization; a second one would fight it");
  assert.equal(mapping.configTokens["X-App-Id"], `{env:${PREFIX}X_APP_ID}`);
  assert.equal(mapping.secretEnv[`${PREFIX}X_APP_ID`], APP_ID);
});

test("the bearer prefix match is case-insensitive and consumes the separating whitespace", () => {
  for (const value of [`bearer ${BEARER_TOKEN}`, `BEARER ${BEARER_TOKEN}`, `Bearer   ${BEARER_TOKEN}`]) {
    const mapping = mapHeadersToEnv({ Authorization: value }, PREFIX);
    assert.equal(mapping.secretEnv[`${PREFIX}API_KEY`], BEARER_TOKEN, `failed for ${JSON.stringify(value)}`);
  }
});

test("a non-Bearer Authorization scheme keeps the placeholder apiKey and travels as an ordinary header", () => {
  const mapping = mapHeadersToEnv({ Authorization: "Basic dXNlcjpwYXNz" }, PREFIX);
  assert.equal(mapping.apiKeySource, "placeholder");
  assert.equal(mapping.apiKeyEnvName, `${PREFIX}APIKEY_UNUSED`);
  assert.equal(mapping.secretEnv[`${PREFIX}APIKEY_UNUSED`], "unused");
  assert.equal(mapping.configTokens["Authorization"], `{env:${PREFIX}AUTHORIZATION}`);
  assert.equal(mapping.secretEnv[`${PREFIX}AUTHORIZATION`], "Basic dXNlcjpwYXNz");
});

test("mapHeadersToEnv synthesizes a non-secret placeholder apiKey when there is no Authorization header", () => {
  const mapping = mapHeadersToEnv({ "X-Api-Key": "abc" }, PREFIX);
  assert.equal(mapping.apiKeySource, "placeholder");
  assert.equal(mapping.secretEnv[`${PREFIX}APIKEY_UNUSED`], "unused");
  assert.equal(mapping.configTokens["X-Api-Key"], `{env:${PREFIX}X_API_KEY}`);
});

test("header names that sanitize to the same env suffix are never allowed to collide", () => {
  const mapping = mapHeadersToEnv({ "X-App-Id!!": "v", "X-App-Id?": "v2" }, PREFIX);
  const first = mapping.configTokens["X-App-Id!!"]!;
  const second = mapping.configTokens["X-App-Id?"]!;
  assert.notEqual(first, second);
  const nameOf = (token: string): string => token.slice("{env:".length, -1);
  assert.equal(mapping.secretEnv[nameOf(first)], "v");
  assert.equal(mapping.secretEnv[nameOf(second)], "v2");
});

// --- C. provider block shape ------------------------------------------------------------------------------------

test("the provider block carries every field a custom openai-compatible provider requires, including display names", () => {
  const payload = buildNativeConfigPayload(model(), [], PREFIX);
  const entry = providerEntry(payload.json);
  assert.equal(entry["npm"], "@ai-sdk/openai-compatible");
  assert.equal(entry["name"], "PNP acme-internal", "provider.<id>.name is required and must be a display name");
  const options = entry["options"] as Record<string, unknown>;
  assert.equal(options["baseURL"], "https://model.internal.example.invalid/v1");
  assert.equal(options["apiKey"], `{env:${PREFIX}API_KEY}`);
  assert.deepEqual(options["headers"], { "X-App-Id": `{env:${PREFIX}X_APP_ID}` });
  const models = entry["models"] as Record<string, Record<string, unknown>>;
  assert.equal(models["acme-large-v3"]!["name"], "acme-large-v3", "models.<id>.name is required");
  assert.equal((payload.json as Record<string, unknown>)["model"], "acme-internal/acme-large-v3");
  assert.equal((payload.json as Record<string, unknown>)["share"], "disabled");
});

test("options.headers is omitted entirely when the bearer token is the only credential", () => {
  const payload = buildNativeConfigPayload(model({ headers: { Authorization: `Bearer ${BEARER_TOKEN}` } }), [], PREFIX);
  const options = providerEntry(payload.json)["options"] as Record<string, unknown>;
  assert.equal("headers" in options, false);
  assert.equal(options["apiKey"], `{env:${PREFIX}API_KEY}`);
});

test("buildNativeConfigPayload never places a header value or bearer token in the generated JSON", () => {
  const payload = buildNativeConfigPayload(model(), [], PREFIX);
  const serialized = JSON.stringify(payload.json);
  assert.doesNotMatch(serialized, new RegExp(BEARER_TOKEN));
  assert.doesNotMatch(serialized, new RegExp(APP_ID));
  assert.equal(payload.secretEnv[`${PREFIX}API_KEY`], BEARER_TOKEN);
  assert.equal(payload.secretEnv[`${PREFIX}X_APP_ID`], APP_ID);
});

test("buildNativeConfigPayload fails closed on a missing endpoint and an unsupported protocol", () => {
  assert.throws(() => buildNativeConfigPayload(model({ endpoint: undefined }), [], PREFIX), { code: "ENGINE_MODEL_ENDPOINT_MISSING" });
  assert.throws(() => buildNativeConfigPayload(model({ protocol: "custom" }), [], PREFIX), { code: "ENGINE_MODEL_PROTOCOL_UNSUPPORTED" });
});

// --- C. nativePermissions -----------------------------------------------------------------------------------------

test("nativePermissions engine-default asks for nothing beyond the explicit external_directory allow", () => {
  const payload = buildNativeConfigPayload(model(), [], PREFIX, "engine-default");
  assert.deepEqual((payload.json as Record<string, unknown>)["permission"], { external_directory: "allow" });
  // The default argument must behave the same as passing it explicitly.
  assert.deepEqual((buildNativeConfigPayload(model(), [], PREFIX).json as Record<string, unknown>)["permission"],
    { external_directory: "allow" });
});

test("nativePermissions ask writes edit/bash ask, which is what makes session/request_permission fire", () => {
  const payload = buildNativeConfigPayload(model(), [], PREFIX, "ask");
  assert.deepEqual((payload.json as Record<string, unknown>)["permission"],
    { external_directory: "allow", edit: "ask", bash: "ask" });
});

// --- C. tools: the question tool must not exist for an unattended run --------------------------------------------

test("the question tool is disabled in every generated config", () => {
  // `tools` is a map of tool name -> boolean (opencode.ai/docs/config/ #Tools). The gateway runs unattended, so
  // a question would block the run until the interaction deadline and then be answered as a refusal.
  for (const payload of [
    buildNativeConfigPayload(model(), [], PREFIX),
    buildNativeConfigPayload(model(), [], PREFIX, "ask", { default: "ask", operations: {} }),
    buildNativeConfigPayload(model({ headers: {} }), ["/tmp/instructions.md"], PREFIX),
  ]) {
    assert.deepEqual((payload.json as Record<string, unknown>)["tools"], { question: false });
  }
});

// --- C. shell: Windows without Git Bash falls back to Windows PowerShell -----------------------------------------

function shellProbe(overrides: Partial<NativeShellProbe> = {}): NativeShellProbe {
  return {
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32;C:\\tools" },
    fileExists: () => false,
    ...overrides,
  };
}

test("on win32 with no bash.exe anywhere the shell is pinned to the absolute Windows PowerShell path", () => {
  assert.equal(resolveNativeShell(shellProbe()),
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  // A missing SystemRoot must still produce an absolute path, not a bare name the engine would have to find.
  assert.equal(resolveNativeShell(shellProbe({ environment: { PATH: "C:\\tools" } })),
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  const payload = buildNativeConfigPayload(model(), [], PREFIX, "engine-default", undefined,
    resolveNativeShell(shellProbe()));
  assert.equal((payload.json as Record<string, unknown>)["shell"],
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
});

test("a bash.exe in either Git for Windows location, or on PATH, leaves shell to OpenCode's own discovery", () => {
  for (const found of [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\tools\\bash.exe",
  ]) {
    const probe = shellProbe({ fileExists: (candidate) => candidate === found });
    assert.equal(resolveNativeShell(probe), undefined, `bash at ${found} must not be overridden`);
  }
  // A quoted PATH entry with a trailing separator is still a directory to probe.
  const quoted = shellProbe({
    environment: { SystemRoot: "C:\\Windows", PATH: '"C:\\Program Files\\Git\\bin\\";C:\\other' },
    fileExists: (candidate) => candidate === "C:\\Program Files\\Git\\bin\\bash.exe",
  });
  assert.equal(resolveNativeShell(quoted), undefined);
});

test("off win32 no shell is written at all", () => {
  for (const platform of ["linux", "darwin"]) {
    assert.equal(resolveNativeShell(shellProbe({ platform, fileExists: () => false })), undefined);
  }
  assert.equal("shell" in (buildNativeConfigPayload(model(), [], PREFIX).json as Record<string, unknown>), false);
});

// --- C. OPENCODE_CONFIG is the primary discovery route ------------------------------------------------------------

test("buildRedirectPlan roots everything under nativeDataDirectory/opencode and names one deterministic config file", () => {
  const plan = buildRedirectPlan("/private/session-42", config());
  const base = path.join("/private/session-42", "opencode");
  for (const value of Object.values(plan.env)) assert.ok(value.startsWith(`${base}${path.sep}`));
  // The four directories OpenCode resolves for itself: config, data, cache and state (its lock directory).
  assert.equal(plan.env["XDG_CONFIG_HOME"], path.join(base, "xdg-config"));
  assert.equal(plan.env["XDG_DATA_HOME"], path.join(base, "xdg-data"));
  assert.equal(plan.env["XDG_CACHE_HOME"], path.join(base, "xdg-cache"));
  assert.equal(plan.env["XDG_STATE_HOME"], path.join(base, "xdg-state"));
  assert.equal(plan.configFile, path.join(base, "opencode.json"));
  assert.equal(plan.configDirectory, path.join(base, "config"));
  assert.equal(new Set(plan.configRoots).size, plan.configRoots.length);
  // With HOME no longer redirected, the operator's real ~/.config must never be a mirror target: the only
  // config home this Pack owns is the private XDG one.
  assert.deepEqual(plan.configRoots, [path.join(base, "xdg-config")]);
  assert.deepEqual(plan.skillRoots, [
    path.join(base, "config", "skills"),
    path.join(base, "xdg-config", "opencode", "skills"),
  ]);
});

test("buildRedirectPlan never invents a profile redirect the engine config does not ask for", () => {
  const plan = buildRedirectPlan("/private/session-42", config());
  for (const variable of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    assert.equal(variable in plan.env, false, `${variable} must stay the operator's real profile value`);
  }
});

test("writeNativeConfig points OPENCODE_CONFIG at the private file and mirrors identical content to the fallbacks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-opencode-native-config-"));
  try {
    const nativeDataDirectory = path.join(root, "native");
    const written = await writeNativeConfig(nativeDataDirectory, config(), model(), []);
    const pointer = written.redirectEnv[OPENCODE_CONFIG_ENVIRONMENT_VARIABLE];
    assert.equal(pointer, written.primaryConfigPath);
    assert.equal(pointer, path.join(nativeDataDirectory, "opencode", "opencode.json"));
    // The documented "Custom directory" step, pointed at a directory this Pack created inside the private tree.
    const directory = written.redirectEnv[OPENCODE_CONFIG_DIRECTORY_ENVIRONMENT_VARIABLE];
    assert.equal(directory, written.configDirectory);
    assert.equal(directory, path.join(nativeDataDirectory, "opencode", "config"));
    assert.ok((await stat(directory!)).isDirectory(), "OPENCODE_CONFIG_DIR must exist before the engine starts");
    assert.equal(written.configPaths[0], written.primaryConfigPath, "the OPENCODE_CONFIG target is written first");
    assert.equal(written.configPaths.length, 2, "primary plus the private XDG config home mirror");

    const primary = await readFile(written.primaryConfigPath, "utf8");
    for (const file of written.configPaths) {
      assert.ok(file.startsWith(nativeDataDirectory + path.sep), `${file} must live under the private native directory`);
      assert.equal(await readFile(file, "utf8"), primary, "every copy must be byte-identical");
    }
    assert.doesNotMatch(primary, new RegExp(BEARER_TOKEN));
    assert.doesNotMatch(primary, new RegExp(APP_ID));
    assert.doesNotMatch(primary, /:\s*"\$[A-Za-z_]/);
    assert.equal(written.secretEnv[`${PREFIX}API_KEY`], BEARER_TOKEN);
  } finally {
    await removeTree(root);
  }
});

test("writeNativeConfig carries nativePermissions from the engine config into the file on disk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-opencode-native-config-"));
  try {
    const asked = await writeNativeConfig(path.join(root, "ask"), config("ask"), model(), []);
    const askedJson = JSON.parse(await readFile(asked.primaryConfigPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(askedJson["permission"], { external_directory: "allow", edit: "ask", bash: "ask" });

    const defaulted = await writeNativeConfig(path.join(root, "default"), config(), model(), []);
    const defaultedJson = JSON.parse(await readFile(defaulted.primaryConfigPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(defaultedJson["permission"], { external_directory: "allow" });
  } finally {
    await removeTree(root);
  }
});

test("writeNativeConfig lists projected instruction paths in every copy of the config", async () => {
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
    await removeTree(root);
  }
});

test("several instruction assets all reach the config, in order, absolute and deduplicated", () => {
  const first = path.resolve("/private/native/opencode/assets/instructions/inst-1/COMPETITION.md");
  const second = path.resolve("/private/native/opencode/assets/instructions/inst-2/OFFICE.md");
  const third = path.resolve("/private/native/opencode/assets/instructions/inst-3/SHELL.md");
  const json = buildNativeConfigPayload(model(), [first, second, third, second], PREFIX).json as Record<string, unknown>;
  const instructions = json["instructions"] as string[];
  assert.deepEqual(instructions, [first, second, third], "order is the order the assets arrived, no duplicates");
  for (const entry of instructions) assert.ok(path.isAbsolute(entry), `${entry} must be absolute`);
});
