import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CODE_ROOT } from "../../src/config/settings.ts";
import { loadIntegration, probeIntegration } from "../../src/integration/index.ts";
import type { IntegrationContext, Session } from "../../src/contracts/index.ts";
import { removeTree } from "../kit/fs.ts";

/**
 * The delivered configuration shape: one model whose identifier, endpoint, credential, extra headers
 * and certificate are all environment variable NAMES, so the repository carries no deployment
 * address and an operator configures a run without editing a file inside the delivery.
 */
const model = {
  selection: { providerID: "competition", modelID: "default" },
  modelIDEnvironment: "PNP_MODEL_ID",
  endpointEnvironment: "PNP_MODEL_ENDPOINT",
  protocol: "openai-chat",
  apiKeyEnvironment: "PNP_MODEL_API_KEY",
  headersEnvironment: "PNP_MODEL_HEADERS",
  caFileEnvironment: "PNP_MODEL_CA_FILE",
};
const session: Session = {
  id: "test", title: "", directory: tmpdir(), engineId: "opencode", channelId: "acp",
  lifecycle: "active", status: "idle", recovery: "ready", createdAt: "", updatedAt: "",
};
const endpoint = { PNP_MODEL_ENDPOINT: "https://model.test.invalid/v1", PNP_MODEL_ID: "endpoint-model" };

async function settingsFile(dir: string, value: unknown): Promise<string> {
  const file = path.join(dir, "settings.json");
  await writeFile(file, JSON.stringify(value));
  return file;
}
function withModels(models: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    common: {
      model: { default: { providerID: "competition" }, models },
      permissions: { default: "allow", operations: {} },
      ...extra,
    },
    cores: {},
  };
}
async function load(settingsPath: string, environment: NodeJS.ProcessEnv) {
  return loadIntegration({
    kind: "configured", development: false, engineDevelopmentOnly: false, engineId: "opencode",
    settingsPath, environment,
  });
}
async function prepared(settingsPath: string, environment: NodeJS.ProcessEnv): Promise<IntegrationContext> {
  const provider = await load(settingsPath, environment);
  return provider.prepare({
    session,
    request: { parts: [{ type: "text", text: "test" }], model: { providerID: "", modelID: "" } },
    signal: new AbortController().signal,
  });
}

test("the model identifier the endpoint expects replaces the declared one everywhere", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-model-id-"));
  try {
    const file = await settingsFile(dir, withModels([model]));
    const context = await prepared(file, { ...endpoint, PNP_MODEL_API_KEY: "not-a-secret" });
    // The substitution happens once, at load, so the selection the gateway publishes as
    // `model.resolved`, records in the trajectory and hands to the driver is the same identifier.
    assert.deepEqual(context.model.selection, { providerID: "competition", modelID: "endpoint-model" });
    // The default is still reached by the settings identifier: the request named no model at all.
    assert.equal(context.model.resolution?.outcome, "default");
  } finally { await removeTree(dir); }
});

test("a missing model identifier stops startup for the default model and the prompt for any other", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-model-id-missing-"));
  try {
    const secondary = {
      selection: { providerID: "secondary", modelID: "declared" },
      modelIDEnvironment: "PNP_SECONDARY_MODEL_ID",
      endpoint: "https://secondary.test.invalid/v1", protocol: "openai-chat", headerEnvironment: {},
    };
    const file = await settingsFile(dir, withModels([model, secondary]));
    // Nothing can run without the default model, so its variables are a start gate and the message
    // names them. Variable names are not secrets; no value is ever read out.
    await assert.rejects(probeIntegration(await load(file, {})), (error: unknown) => {
      const failure = error as { code: string; message: string };
      assert.equal(failure.code, "MODEL_ENVIRONMENT_MISSING");
      assert.match(failure.message, /PNP_MODEL_ENDPOINT/);
      assert.match(failure.message, /PNP_MODEL_ID/);
      return true;
    });
    // A second model nobody asked for must not stop the gateway; it fails when a prompt selects it.
    const provider = await load(file, endpoint);
    await probeIntegration(provider);
    await assert.rejects(provider.prepare({
      session,
      request: { parts: [{ type: "text", text: "test" }], model: { providerID: "secondary", modelID: "declared" } },
      signal: new AbortController().signal,
    }), (error: unknown) => {
      const failure = error as { code: string; message: string };
      assert.equal(failure.code, "MODEL_ENVIRONMENT_MISSING");
      assert.match(failure.message, /PNP_SECONDARY_MODEL_ID/);
      return true;
    });
  } finally { await removeTree(dir); }
});

test("request headers combine the three sources, and an existing Authorization wins whatever its case", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-model-headers-"));
  try {
    const file = await settingsFile(dir, withModels([model]));
    // Nothing set: no Authorization at all. An intranet endpoint that authenticates by network
    // position is a normal deployment, and an empty bearer would only fail later.
    assert.deepEqual((await prepared(file, endpoint)).model.headers, {});
    // The key alone becomes a bearer header.
    assert.deepEqual((await prepared(file, { ...endpoint, PNP_MODEL_API_KEY: "not-a-secret" })).model.headers,
      { Authorization: "Bearer not-a-secret" });
    // Extra headers are merged in, and they do not disturb the credential.
    assert.deepEqual((await prepared(file, {
      ...endpoint, PNP_MODEL_API_KEY: "not-a-secret", PNP_MODEL_HEADERS: JSON.stringify({ appid: "A1" }),
    })).model.headers, { appid: "A1", Authorization: "Bearer not-a-secret" });
    // A deployment that already states its own Authorization keeps it: a header name is
    // case-insensitive, so the bearer is not added a second time under a different spelling.
    assert.deepEqual((await prepared(file, {
      ...endpoint, PNP_MODEL_API_KEY: "not-a-secret",
      PNP_MODEL_HEADERS: JSON.stringify({ authorization: "Basic stated-by-deployment" }),
    })).model.headers, { authorization: "Basic stated-by-deployment" });
    // The same rule for the per-header variable form, which is resolved first.
    const declared = await settingsFile(await mkdtemp(path.join(dir, "declared")),
      withModels([{ ...model, headerEnvironment: { AUTHORIZATION: "PNP_MODEL_AUTHORIZATION" } }]));
    assert.deepEqual((await prepared(declared, {
      ...endpoint, PNP_MODEL_API_KEY: "not-a-secret", PNP_MODEL_AUTHORIZATION: "Bearer stated-by-deployment",
    })).model.headers, { AUTHORIZATION: "Bearer stated-by-deployment" });
  } finally { await removeTree(dir); }
});

test("an extra-headers variable that is not a JSON object of strings fails at startup by name", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-model-headers-invalid-"));
  try {
    const file = await settingsFile(dir, withModels([model]));
    for (const value of ["{not json", JSON.stringify(["appid"]), JSON.stringify({ appid: 7 })]) {
      await assert.rejects(probeIntegration(await load(file, { ...endpoint, PNP_MODEL_HEADERS: value })),
        (error: unknown) => {
          const failure = error as { code: string; message: string };
          assert.equal(failure.code, "MODEL_ENVIRONMENT_INVALID");
          // The variable is named so an operator can fix it; its content never appears.
          assert.match(failure.message, /PNP_MODEL_HEADERS/);
          assert.doesNotMatch(failure.message, /appid|not json/);
          return true;
        });
    }
    // An unset or empty variable simply contributes nothing.
    await probeIntegration(await load(file, { ...endpoint, PNP_MODEL_HEADERS: "" }));
  } finally { await removeTree(dir); }
});

test("a certificate bundle is probed at startup and published as an absolute path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-model-ca-"));
  try {
    const file = await settingsFile(dir, withModels([model]));
    const bundle = path.join(dir, "intranet-ca.pem");
    await writeFile(bundle, "-----BEGIN CERTIFICATE-----\ntest fixture\n-----END CERTIFICATE-----\n");
    const absolute = await prepared(file, { ...endpoint, PNP_MODEL_CA_FILE: bundle });
    assert.equal(absolute.model.caFile, bundle);
    // A deployment may write the path relative to the package root, the one directory it can name
    // without knowing where the delivery was unpacked.
    const relative = await prepared(file, { ...endpoint, PNP_MODEL_CA_FILE: path.relative(CODE_ROOT, bundle) });
    assert.equal(relative.model.caFile, bundle);
    // A named bundle that is not there is a deployment error, and it is caught before the first case.
    await assert.rejects(probeIntegration(await load(file, {
      ...endpoint, PNP_MODEL_CA_FILE: path.join(dir, "absent.pem"),
    })), (error: unknown) => {
      const failure = error as { code: string; message: string };
      assert.equal(failure.code, "MODEL_CA_FILE_MISSING");
      assert.match(failure.message, /PNP_MODEL_CA_FILE/);
      return true;
    });
    // No certificate named: nothing is published and nothing is probed.
    assert.equal((await prepared(file, endpoint)).model.caFile, undefined);
  } finally { await removeTree(dir); }
});

test("switching off certificate verification is carried on the binding, never assumed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-model-tls-"));
  try {
    const file = await settingsFile(dir, withModels([model]));
    assert.equal((await prepared(file, endpoint)).model.tlsInsecure, undefined);
    assert.equal((await prepared(file, { ...endpoint, PNP_MODEL_TLS_INSECURE: "1" })).model.tlsInsecure, true);
    // Only the documented value opts in; anything else keeps verification on.
    assert.equal((await prepared(file, { ...endpoint, PNP_MODEL_TLS_INSECURE: "true" })).model.tlsInsecure, undefined);
  } finally { await removeTree(dir); }
});

test("instruction files become one required instruction asset each, in order", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-model-instructions-"));
  try {
    await writeFile(path.join(dir, "competition.md"), "unattended run\n");
    await writeFile(path.join(dir, "extra.md"), "second\n");
    const file = await settingsFile(dir, withModels([model], { instructions: ["competition.md", "extra.md"] }));
    const context = await prepared(file, endpoint);
    assert.deepEqual(context.assets.map((asset) => ({ id: asset.id, kind: asset.kind, path: asset.path, required: asset.required })), [
      { id: "instruction:competition", kind: "instruction", path: path.join(dir, "competition.md"), required: true },
      { id: "instruction:extra", kind: "instruction", path: path.join(dir, "extra.md"), required: true },
    ]);
    // The digest comes from the shared resolver, so a changed instruction is a changed asset for
    // every adapter that compares one.
    assert.match(context.assets[0]!.sha256, /^[0-9a-f]{64}$/);
    const again = await prepared(file, endpoint);
    assert.equal(again.assets[0]!.sha256, context.assets[0]!.sha256);
    await writeFile(path.join(dir, "competition.md"), "unattended run, revised\n");
    assert.notEqual((await prepared(file, endpoint)).assets[0]!.sha256, context.assets[0]!.sha256);
  } finally { await removeTree(dir); }
});
