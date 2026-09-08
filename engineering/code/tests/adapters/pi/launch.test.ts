import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLaunchSpec, buildPiSettings, fingerprintPiModel, proxyEnvironment, readInstructionText,
  resolveBridgeExtensionPath, resolveSessionPaths, writePiModelsConfig, writePiSettings,
  WINDOWS_DEFAULT_TOOLS,
} from "../../../src/drivers/pi-rpc/launch.ts";
import type { AssetBinding, ResolvedModel } from "../../../src/contracts/index.ts";

/**
 * Covers the launch-side mechanisms that decide what the pi process is actually configured with.
 *
 * Their shapes are not guesses: a real `@earendil-works/pi-coding-agent` 0.85.1 process was run
 * against a local HTTP endpoint with exactly the `models.json` these tests assert (only `$NAME`
 * references, no values) and the named variables in its environment, and the endpoint received
 * `Authorization: Bearer <value>` plus every custom header (`docs/engines/pi.md` B08).
 */
async function newPaths(): Promise<ReturnType<typeof resolveSessionPaths>> {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-pi-launch-"));
  return resolveSessionPaths(root);
}
function model(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return { selection: { providerID: "approved-test", modelID: "approved-model" }, protocol: "openai-chat", headers: {}, ...overrides };
}

test("a capitalised Authorization header is read case-insensitively and becomes the apiKey reference", async () => {
  // Regression: the shipped settings file emits `Authorization`; this driver used to read
  // `model.headers.authorization` only, so the delivered configuration silently dropped the model
  // credential and pi called the endpoint unauthenticated (competition-readiness.md A9).
  const paths = await newPaths();
  const env = await writePiModelsConfig(paths, model({
    endpoint: "https://model.example.invalid/v1",
    headers: { Authorization: "Bearer sk-live-secret", appid: "appid-value" },
  }));
  const config = JSON.parse(await readFile(paths.modelsConfigFile, "utf8"));
  assert.deepEqual(config, {
    providers: {
      "approved-test": {
        api: "openai-completions",
        apiKey: "$PNP_PI_MODEL_API_KEY",
        baseUrl: "https://model.example.invalid/v1",
        headers: { appid: "$PNP_PI_MODEL_HEADER_1" },
        models: [{ id: "approved-model" }],
      },
    },
  });
  assert.equal(env.PNP_PI_MODEL_API_KEY, "sk-live-secret");
  assert.equal(env.PNP_PI_MODEL_HEADER_1, "appid-value");
});

test("models.json carries variable names only; every resolved value is in the launch environment", async () => {
  const paths = await newPaths();
  const env = await writePiModelsConfig(paths, model({
    endpoint: "https://model.example.invalid/v1",
    headers: { Authorization: "Bearer sk-live-secret", appid: "appid-value", "X-Extra": "extra-value" },
  }));
  const serialized = await readFile(paths.modelsConfigFile, "utf8");
  for (const secret of ["sk-live-secret", "appid-value", "extra-value"]) {
    assert.equal(serialized.includes(secret), false, `${secret} was written to models.json`);
  }
  // Everything credential-shaped in the file is a "$NAME" reference and nothing else.
  const config = JSON.parse(serialized) as { providers: Record<string, { apiKey: string; headers?: Record<string, string> }> };
  const provider = config.providers["approved-test"]!;
  assert.match(provider.apiKey, /^\$PNP_PI_MODEL_API_KEY$/);
  for (const value of Object.values(provider.headers ?? {})) assert.match(value, /^\$PNP_PI_MODEL_HEADER_\d+$/);
  assert.deepEqual(Object.keys(provider.headers ?? {}).sort(), ["X-Extra", "appid"]);
  assert.deepEqual(Object.values(env).sort(), ["appid-value", "extra-value", "sk-live-secret"]);
});

test("a non-Bearer Authorization header stays a custom header instead of being split into an apiKey", async () => {
  const paths = await newPaths();
  const env = await writePiModelsConfig(paths, model({ headers: { Authorization: "Basic dXNlcjpwYXNz" } }));
  const config = JSON.parse(await readFile(paths.modelsConfigFile, "utf8"));
  assert.deepEqual(config.providers["approved-test"].headers, { Authorization: "$PNP_PI_MODEL_HEADER_1" });
  assert.equal(config.providers["approved-test"].apiKey, "$PNP_PI_MODEL_API_KEY");
  assert.equal(env.PNP_PI_MODEL_HEADER_1, "Basic dXNlcjpwYXNz");
  assert.equal(env.PNP_PI_MODEL_API_KEY, "pnp-unused"); // Placeholder, not a credential.
});

test("maps anthropic-messages to pi's anthropic-messages api and writes nothing for protocols pi cannot speak", async () => {
  const anthropic = await newPaths();
  await writePiModelsConfig(anthropic, model({ protocol: "anthropic-messages", selection: { providerID: "acme-anthropic", modelID: "internal-x" } }));
  const config = JSON.parse(await readFile(anthropic.modelsConfigFile, "utf8"));
  assert.deepEqual(config.providers["acme-anthropic"], { api: "anthropic-messages", apiKey: "$PNP_PI_MODEL_API_KEY", models: [{ id: "internal-x" }] });
  const unsupported = await newPaths();
  await writePiModelsConfig(unsupported, model({ protocol: "custom" }));
  await assert.rejects(readFile(unsupported.modelsConfigFile, "utf8"), { code: "ENOENT" });
});

test("the model fingerprint changes with every field the fixed process environment was built for", () => {
  const base = model({ endpoint: "https://one.invalid", headers: { Authorization: "Bearer one", appid: "a" }, caFile: "/certs/one.pem" });
  const digest = fingerprintPiModel(base);
  assert.match(digest, /^[a-f0-9]{64}$/);
  const variants: ResolvedModel[] = [
    { ...base, selection: { providerID: "other", modelID: "approved-model" } },
    { ...base, selection: { providerID: "approved-test", modelID: "other" } },
    { ...base, protocol: "anthropic-messages" },
    { ...base, endpoint: "https://two.invalid" },
    { ...base, caFile: "/certs/two.pem" },
    { ...base, tlsInsecure: true },
    { ...base, headers: { Authorization: "Bearer two", appid: "a" } },
    { ...base, headers: { Authorization: "Bearer one", appid: "b" } },
    { ...base, headers: { Authorization: "Bearer one" } },
  ];
  for (const variant of variants) assert.notEqual(fingerprintPiModel(variant), digest);
  // Header-name case and declaration order are not part of the identity; the values are.
  assert.equal(fingerprintPiModel({ ...base, headers: { appid: "a", authorization: "Bearer one" } }), digest);
});

test("win32 defaultTools swap bash for powershell, and keep bash only when a bash.exe was found", () => {
  // Upstream docs/windows.md: pi's `bash` tool needs Git Bash (or a `bash.exe` on PATH); the
  // documented remedy on a host without one is the optional `powershell` tool via `defaultTools`.
  const without = buildPiSettings({ platform: "win32", bashAvailable: () => false });
  assert.deepEqual(without, { defaultTools: [...WINDOWS_DEFAULT_TOOLS] });
  assert.equal((without.defaultTools as string[]).includes("bash"), false);
  assert.equal((without.defaultTools as string[]).includes("powershell"), true);
  const withBash = buildPiSettings({ platform: "win32", bashAvailable: () => true });
  assert.deepEqual(withBash, { defaultTools: [...WINDOWS_DEFAULT_TOOLS, "bash"] });
  // Off win32 nothing is pinned: pi's own defaults apply.
  assert.deepEqual(buildPiSettings({ platform: "linux", bashAvailable: () => false }), {});
});

test("the session-private settings.json is written into PI_CODING_AGENT_DIR", async () => {
  const paths = await newPaths();
  await writePiSettings(paths, { platform: "win32", bashAvailable: () => false });
  assert.equal(path.dirname(paths.settingsFile), paths.agentConfigDir);
  assert.deepEqual(JSON.parse(await readFile(paths.settingsFile, "utf8")), { defaultTools: [...WINDOWS_DEFAULT_TOOLS] });
});

test("instruction assets become one joined --append-system-prompt argument; no asset means no flag", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-pi-assets-"));
  const first = path.join(root, "competition.md");
  const second = path.join(root, "office.md");
  await writeFile(first, "Never ask the user a question.\n");
  await writeFile(second, "Write artefacts to the absolute path in the request.");
  const assets: AssetBinding[] = [
    { id: "a1", kind: "instruction", path: first, sha256: "0".repeat(64), required: true },
    { id: "s1", kind: "skill", path: second, sha256: "1".repeat(64), required: false },
    { id: "a2", kind: "instruction", path: second, sha256: "2".repeat(64), required: true },
  ];
  const text = await readInstructionText(assets);
  assert.equal(text, "Never ask the user a question.\n\nWrite artefacts to the absolute path in the request.");
  assert.equal(await readInstructionText([]), undefined);
  assert.equal(await readInstructionText(assets.filter((asset) => asset.kind === "skill")), undefined);

  const paths = await newPaths();
  const spec = buildLaunchSpec({ node: "/usr/bin/node", entry: "/opt/pi/cli.js", extraArgs: [], approve: "never" }, {
    sessionId: "s", ownerToken: "t", cwd: root, paths, model: model(), modelEnv: {}, appendSystemPrompt: text!,
  });
  const index = spec.args.indexOf("--append-system-prompt");
  assert.notEqual(index, -1);
  assert.equal(spec.args[index + 1], text); // One argv element, not one flag per file.
  const withoutAssets = buildLaunchSpec({ node: "/usr/bin/node", entry: "/opt/pi/cli.js", extraArgs: [], approve: "never" }, {
    sessionId: "s", ownerToken: "t", cwd: root, paths, model: model(), modelEnv: {},
  });
  assert.equal(withoutAssets.args.includes("--append-system-prompt"), false);
});

test("the launch environment carries the model/tool values, the TLS knobs and the gateway's proxy settings", async () => {
  const paths = await newPaths();
  const gatewayEnv = { PATH: "/usr/bin", HTTPS_PROXY: "http://proxy.invalid:8080", no_proxy: "127.0.0.1", PNP_UNRELATED: "leave-me" };
  const spec = buildLaunchSpec({ node: "/usr/bin/node", entry: "/opt/pi/cli.js", extraArgs: [], approve: "never" }, {
    sessionId: "s", ownerToken: "t", cwd: paths.sessionDir, paths,
    model: model({ caFile: "/certs/internal.pem", tlsInsecure: true }),
    modelEnv: { PNP_PI_MODEL_API_KEY: "sk-live-secret" },
    toolEnv: { PNP_PI_TOOLENV_1: "tool-secret" },
    bridgeFile: paths.toolsFile,
    gatewayEnv,
  });
  assert.equal(spec.env.PI_CODING_AGENT_DIR, paths.agentConfigDir);
  assert.equal(spec.env.PNP_PI_BRIDGE_FILE, paths.toolsFile);
  assert.equal(spec.env.NODE_EXTRA_CA_CERTS, "/certs/internal.pem");
  assert.equal(spec.env.NODE_TLS_REJECT_UNAUTHORIZED, "0");
  assert.equal(spec.env.HTTPS_PROXY, "http://proxy.invalid:8080");
  assert.equal(spec.env.no_proxy, "127.0.0.1");
  assert.equal(spec.env.PNP_UNRELATED, undefined); // Not a proxy variable and not on the allow-list.
  assert.equal(spec.env.PNP_PI_MODEL_API_KEY, "sk-live-secret");
  assert.equal(spec.env.PNP_PI_TOOLENV_1, "tool-secret");
  // No CA file and no insecure flag means neither variable is set at all.
  const plain = buildLaunchSpec({ node: "/usr/bin/node", entry: "/opt/pi/cli.js", extraArgs: [], approve: "never" }, {
    sessionId: "s", ownerToken: "t", cwd: paths.sessionDir, paths, model: model(), modelEnv: {}, gatewayEnv: { PATH: "/usr/bin" },
  });
  assert.equal("NODE_EXTRA_CA_CERTS" in plain.env, false);
  assert.equal("NODE_TLS_REJECT_UNAUTHORIZED" in plain.env, false);
  assert.equal("PNP_PI_BRIDGE_FILE" in plain.env, false);
  assert.deepEqual(proxyEnvironment({ HTTP_PROXY: "", NO_PROXY: "local" }), { NO_PROXY: "local" });
});

test("the bridge extension path follows the tree the driver itself was loaded from", () => {
  const fromSource = resolveBridgeExtensionPath("file:///opt/app/src/drivers/pi-rpc/launch.ts");
  assert.equal(fromSource, path.normalize("/opt/app/src/drivers/pi-rpc/extension/pnp-bridge.ts"));
  const fromBuild = resolveBridgeExtensionPath("file:///opt/app/dist/drivers/pi-rpc/launch.js");
  assert.equal(fromBuild, path.normalize("/opt/app/dist/drivers/pi-rpc/extension/pnp-bridge.js"));
  // The default (this test's own import graph) resolves to a file that really exists in `src/`.
  assert.equal(resolveBridgeExtensionPath(), fileURLToPath(new URL("../../../src/drivers/pi-rpc/extension/pnp-bridge.ts", import.meta.url)));
});
