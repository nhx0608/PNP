import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveAsset } from "../../src/assets/resolver.ts";
import { selectEngine, loadEngine } from "../../src/registry/index.ts";
import { ConfiguredIntegration } from "../../src/integration/configured/provider.ts";
import { DEFAULT_CONFIGURED_PROFILE, loadIntegration, probeIntegration } from "../../src/integration/index.ts";
import type { ModelSelection, Session } from "../../src/contracts/index.ts";

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
  // Competition default is allow (see docs/engineering-review-2.md §3); an explicit deny still
  // wins whenever config supplies one, which the "no fallback" test below covers.
  assert.equal((await ctx.authorize({ kind: "permission", operation: "file.write", payload: {} })).effect, "allow");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(create("https://example.test/v1").prepare({ ...input, signal: controller.signal }));
});

test("configured integration is explicit and strict, and mock never substitutes for a real engine", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-configured-"));
  const profile = path.join(dir, "configured.json");
  try {
    await writeFile(profile, JSON.stringify({
      models: [{ selection: { providerID: "approved", modelID: "model" }, endpoint: "https://example.test/v1",
        protocol: "openai-chat", headerEnvironment: { Authorization: "TEST_AUTH" } }],
      tools: [], policy: { default: "deny", operations: { "file.read": "allow" } },
    }));
    // configured is usable outside development: it is the only implemented model path for a real engine.
    const production = await loadIntegration({ kind: "configured", development: false, engineDevelopmentOnly: false,
      configuredProfile: profile, environment: { TEST_AUTH: "secret" } });
    assert.equal(production.id, "configured");
    // No PNP_CONFIGURED_PROFILE means the shipped profile, not a refusal to start.
    assert.equal((await loadIntegration({ kind: "configured", development: true, engineDevelopmentOnly: false,
      environment: {} })).id, "configured");
    await assert.rejects(loadIntegration({ kind: "configured", development: true, engineDevelopmentOnly: false,
      configuredProfile: "relative/profile.json" }), { code: "INTEGRATION_CONFIG_INVALID" });
    // A real engine must never fall back to mock, in development or otherwise.
    await assert.rejects(loadIntegration({ kind: "mock", development: true, engineDevelopmentOnly: false }),
      { code: "MOCK_FORBIDDEN" });
    await assert.rejects(loadIntegration({ kind: "mock", development: false, engineDevelopmentOnly: true }),
      { code: "MOCK_FORBIDDEN" });
    assert.equal((await loadIntegration({ kind: "mock", development: true, engineDevelopmentOnly: true })).id, "mock");
    // The default choice follows the engine: mock for the mock engine, the shipped configured
    // profile for a real one. `internal` is now only ever an explicit choice, and it is that
    // explicit choice — never a default — that fails at boot while it has no implementation.
    assert.equal((await loadIntegration({ kind: undefined, development: true, engineDevelopmentOnly: true })).id, "mock");
    const chosen = await loadIntegration({ kind: "internal", development: false, engineDevelopmentOnly: false });
    assert.equal(chosen.id, "internal");
    await assert.rejects(probeIntegration(chosen), { code: "INTEGRATION_UNAVAILABLE" });
    const configured = await loadIntegration({ kind: "configured", development: true, engineDevelopmentOnly: false,
      configuredProfile: profile, environment: { TEST_AUTH: "secret" } });
    assert.equal(configured.id, "configured");
    const selected = await configured.prepare({ session: { id: "test", title: "", directory: dir, engineId: "opencode", channelId: "acp",
      lifecycle: "active", status: "idle", recovery: "ready", createdAt: "", updatedAt: "" },
      request: { parts: [{ type: "text", text: "test" }], model: { providerID: "approved", modelID: "model" } },
      signal: new AbortController().signal });
    assert.equal(selected.model.headers.Authorization, "secret");
    assert.equal((await selected.authorize({ kind: "permission", operation: "file.read", payload: {} })).effect, "allow");
    assert.equal((await selected.authorize({ kind: "permission", operation: "file.write", payload: {} })).effect, "deny");
    await assert.rejects(loadIntegration({ kind: "unknown", development: true, engineDevelopmentOnly: false }),
      { code: "INTEGRATION_NOT_FOUND" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an empty AGENT_ENGINE is unset, not a value", () => {
  // A wrapper that exports the variable without a value must not disable --engine.
  assert.equal(selectEngine("opencode", ""), "opencode");
  assert.equal(selectEngine("opencode", "   "), "opencode");
  assert.equal(selectEngine(undefined, "pi"), "pi");
  assert.equal(selectEngine("", "pi"), "pi");
  assert.throws(() => selectEngine("", ""), { code: "ENGINE_NOT_FOUND" });
  assert.throws(() => selectEngine("opencode", "pi"), { code: "ENGINE_CONFIGURATION_CONFLICT" });
});

test("an unconfigured model selection resolves to the profile default, is recorded, and only 403s under PNP_MODEL_STRICT", async () => {
  const session: Session = { id: "test", title: "", directory: tmpdir(), engineId: "opencode", channelId: "acp",
    lifecycle: "active", status: "idle", recovery: "ready", createdAt: "", updatedAt: "" };
  const models = [
    { selection: { providerID: "competition", modelID: "default" }, endpoint: "http://127.0.0.1:9000/v1",
      protocol: "openai-chat" as const, headerEnvironment: {} },
    { selection: { providerID: "competition", modelID: "second" }, endpoint: "http://127.0.0.1:9001/v1",
      protocol: "openai-chat" as const, headerEnvironment: {} },
  ];
  const prepare = (model: ModelSelection, strict = false) => new ConfiguredIntegration(
    models, [], () => ({ effect: "allow", reasonCode: "TEST_ALLOW" }), {}, strict,
  ).prepare({ session, request: { parts: [{ type: "text", text: "test" }], model }, signal: new AbortController().signal });

  const exact = await prepare({ providerID: "competition", modelID: "second" });
  assert.equal(exact.model.selection.modelID, "second");
  assert.equal(exact.model.resolution?.outcome, "exact");
  // The route sends the empty sentinel when the caller omitted `model`; that keeps resolving to the default.
  const omitted = await prepare({ providerID: "", modelID: "" });
  assert.equal(omitted.model.selection.modelID, "default");
  assert.equal(omitted.model.resolution?.outcome, "default");
  // The evaluator supplies identifiers this deployment does not control: substitute, do not refuse.
  const substituted = await prepare({ providerID: "evaluator", modelID: "unknown-1" });
  assert.equal(substituted.model.selection.modelID, "default");
  assert.equal(substituted.model.selection.providerID, "competition");
  assert.equal(substituted.model.resolution?.outcome, "substituted");
  assert.deepEqual(substituted.model.resolution?.requested, { providerID: "evaluator", modelID: "unknown-1" });
  // Strict restores the 403 for the unknown selection only; the sentinel still means "the default".
  await assert.rejects(prepare({ providerID: "evaluator", modelID: "unknown-1" }, true), { code: "MODEL_NOT_ALLOWED" });
  assert.equal((await prepare({ providerID: "", modelID: "" }, true)).model.selection.modelID, "default");
  assert.equal((await prepare({ providerID: "competition", modelID: "second" }, true)).model.selection.modelID, "second");
});

test("PNP_MODEL_STRICT selects the strict provider where the configured integration is built", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-strict-"));
  const profile = path.join(dir, "configured.json");
  try {
    await writeFile(profile, JSON.stringify({
      models: [{ selection: { providerID: "approved", modelID: "model" }, endpoint: "https://example.test/v1",
        protocol: "openai-chat", headerEnvironment: { Authorization: "TEST_AUTH" } }],
      tools: [], policy: { default: "allow", operations: {} },
    }));
    const session: Session = { id: "test", title: "", directory: dir, engineId: "opencode", channelId: "acp",
      lifecycle: "active", status: "idle", recovery: "ready", createdAt: "", updatedAt: "" };
    const request = { parts: [{ type: "text" as const, text: "test" }], model: { providerID: "evaluator", modelID: "unknown" } };
    const lenient = await loadIntegration({ kind: "configured", development: false, engineDevelopmentOnly: false,
      configuredProfile: profile, environment: { TEST_AUTH: "secret" } });
    const context = await lenient.prepare({ session, request, signal: new AbortController().signal });
    assert.equal(context.model.selection.modelID, "model");
    assert.equal(context.model.resolution?.outcome, "substituted");
    const strict = await loadIntegration({ kind: "configured", development: false, engineDevelopmentOnly: false,
      configuredProfile: profile, environment: { TEST_AUTH: "secret", PNP_MODEL_STRICT: "1" } });
    await assert.rejects(strict.prepare({ session, request, signal: new AbortController().signal }), { code: "MODEL_NOT_ALLOWED" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a real engine defaults to the shipped profile, which names its endpoint and credential by variable", async () => {
  // The shipped profile is what an operator who sets no integration variable actually runs, so it
  // is asserted as delivered: no endpoint literal, no credential, only variable NAMES.
  const shipped = JSON.parse(await readFile(DEFAULT_CONFIGURED_PROFILE, "utf8")) as {
    models: { selection: { providerID: string; modelID: string }; endpoint?: string;
      endpointEnvironment?: string; headerEnvironment: Record<string, string> }[];
    tools: unknown[]; policy: { default: string; operations: Record<string, string> };
  };
  assert.equal(shipped.models.length, 1);
  const [first] = shipped.models;
  assert.equal(first?.endpoint, undefined);
  assert.equal(first?.endpointEnvironment, "PNP_MODEL_ENDPOINT");
  assert.deepEqual(first?.headerEnvironment, { Authorization: "PNP_MODEL_AUTHORIZATION" });
  assert.deepEqual(first?.selection, { providerID: "competition", modelID: "default" });
  assert.deepEqual(shipped.tools, []);
  assert.deepEqual(shipped.policy, { default: "allow", operations: {} });

  // A non-mock engine with nothing configured: the integration loads, and only a variable the
  // profile names — not an unimplemented provider — can stop the gateway from starting.
  const provider = await loadIntegration({ kind: undefined, development: false, engineDevelopmentOnly: false,
    environment: {} });
  assert.equal(provider.id, "configured");
  await assert.rejects(probeIntegration(provider), (error: unknown) => {
    const failure = error as { code: string; message: string };
    assert.equal(failure.code, "MODEL_ENVIRONMENT_MISSING");
    assert.match(failure.message, /PNP_MODEL_ENDPOINT/);
    assert.match(failure.message, /PNP_MODEL_AUTHORIZATION/);
    return true;
  });
  // Both variables present: startup passes and the endpoint the variable holds is the one used.
  const environment = { PNP_MODEL_ENDPOINT: "http://127.0.0.1:9000/v1", PNP_MODEL_AUTHORIZATION: "Bearer not-a-secret" };
  const ready = await loadIntegration({ kind: undefined, development: false, engineDevelopmentOnly: false, environment });
  await probeIntegration(ready);
  const context = await ready.prepare({
    session: { id: "test", title: "", directory: tmpdir(), engineId: "opencode", channelId: "acp",
      lifecycle: "active", status: "idle", recovery: "ready", createdAt: "", updatedAt: "" },
    request: { parts: [{ type: "text", text: "test" }], model: { providerID: "competition", modelID: "default" } },
    signal: new AbortController().signal });
  assert.equal(context.model.endpoint, "http://127.0.0.1:9000/v1");
  assert.equal(context.model.headers.Authorization, "Bearer not-a-secret");
  // The endpoint safety rule applies to whatever the variable holds, not only to a literal.
  const insecure = await loadIntegration({ kind: "configured", development: false, engineDevelopmentOnly: false,
    environment: { ...environment, PNP_MODEL_ENDPOINT: "http://model.example.invalid/v1" } });
  await assert.rejects(probeIntegration(insecure), { code: "INSECURE_MODEL_ENDPOINT" });
});

test("endpointEnvironment is parsed as an alternative to a literal endpoint, and only one of them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-endpoint-"));
  try {
    const write = async (name: string, model: Record<string, unknown>) => {
      const file = path.join(dir, name);
      await writeFile(file, JSON.stringify({ models: [model], tools: [], policy: { default: "allow", operations: {} } }));
      return file;
    };
    const selection = { providerID: "competition", modelID: "default" };
    const byVariable = await write("by-variable.json",
      { selection, endpointEnvironment: "PNP_MODEL_ENDPOINT", protocol: "openai-chat", headerEnvironment: {} });
    const both = await write("both.json",
      { selection, endpoint: "https://example.test/v1", endpointEnvironment: "PNP_MODEL_ENDPOINT", protocol: "openai-chat", headerEnvironment: {} });
    const neither = await write("neither.json", { selection, protocol: "openai-chat", headerEnvironment: {} });
    // A profile that names a variable parses even when the variable is not set: the value lives in
    // the environment, so it is the startup probe that reports the missing name.
    const provider = await loadIntegration({ kind: "configured", development: false, engineDevelopmentOnly: false,
      configuredProfile: byVariable, environment: {} });
    await assert.rejects(probeIntegration(provider), (error: unknown) => {
      const failure = error as { code: string; message: string };
      assert.equal(failure.code, "MODEL_ENVIRONMENT_MISSING");
      assert.match(failure.message, /PNP_MODEL_ENDPOINT/);
      return true;
    });
    await assert.rejects(loadIntegration({ kind: "configured", development: false, engineDevelopmentOnly: false,
      configuredProfile: both, environment: {} }), { code: "INTEGRATION_CONFIG_INVALID" });
    await assert.rejects(loadIntegration({ kind: "configured", development: false, engineDevelopmentOnly: false,
      configuredProfile: neither, environment: {} }), { code: "INTEGRATION_CONFIG_INVALID" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("PNP_CONFIGURED_POLICY_OVERRIDES adds a deployment policy without forking the shipped profile", async () => {
  const environment = { PNP_MODEL_ENDPOINT: "http://127.0.0.1:9000/v1", PNP_MODEL_AUTHORIZATION: "Bearer not-a-secret" };
  const load = (overrides?: string) => loadIntegration({ kind: undefined, development: false, engineDevelopmentOnly: false,
    environment: overrides === undefined ? environment : { ...environment, PNP_CONFIGURED_POLICY_OVERRIDES: overrides } });
  const context = async (provider: Awaited<ReturnType<typeof load>>) => provider.prepare({
    session: { id: "test", title: "", directory: tmpdir(), engineId: "opencode", channelId: "acp",
      lifecycle: "active", status: "idle", recovery: "ready", createdAt: "", updatedAt: "" },
    request: { parts: [{ type: "text", text: "test" }], model: { providerID: "competition", modelID: "default" } },
    signal: new AbortController().signal });
  const shipped = await context(await load());
  assert.equal((await shipped.authorize({ kind: "permission", operation: "write", payload: {} })).effect, "allow");
  const overridden = await context(await load(JSON.stringify({ write: "ask" })));
  const decision = await overridden.authorize({ kind: "permission", operation: "write", payload: {} });
  assert.equal(decision.effect, "ask");
  assert.equal(decision.reasonCode, "CONFIGURED_OVERRIDE");
  // Anything else in the same round still follows the profile.
  assert.equal((await overridden.authorize({ kind: "permission", operation: "read", payload: {} })).effect, "allow");
  // Malformed or unsupported overrides fail at load, never silently.
  await assert.rejects(load("{not json"), { code: "INTEGRATION_CONFIG_INVALID" });
  await assert.rejects(load(JSON.stringify({ write: "maybe" })), { code: "INTEGRATION_CONFIG_INVALID" });
  await assert.rejects(load(JSON.stringify(["write"])), { code: "INTEGRATION_CONFIG_INVALID" });
});
