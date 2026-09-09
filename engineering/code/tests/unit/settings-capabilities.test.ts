import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolvePnpSettingsDocument, validatePnpSettingsDocument, resolveAssetRoots } from "../../src/config/settings.ts";
import { removeTree } from "../kit/fs.ts";

function document(common: Record<string, unknown> = {}, cores: Record<string, unknown> = {}) {
  return {
    version: 1,
    common: {
      model: { default: { providerID: "local", modelID: "one" }, models: [{
        selection: { providerID: "local", modelID: "one" }, endpoint: "https://example.test/v1", protocol: "openai-chat",
      }] }, permissions: { default: "ask" }, ...common,
    }, cores,
  };
}
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "pnp-capabilities-"));
  try { await run(directory); } finally { await removeTree(directory); }
}

test("a third engine adds an entirely new domain without extending the settings envelope", async () => fixture(async (directory) => {
  await writeFile(path.join(directory, "memory.md"), "memory");
  const input = { engineId: "future-engine", settingsDirectory: directory, environment: {} };
  const result = await resolvePnpSettingsDocument(document({
    assets: { "dream-context": { memory: { path: "memory.md", required: true, parameters: { keep: 1, replace: { a: 1 } } } } },
    native: { "unheard-of-domain": { privateShape: [1, null, true] }, replace: { a: 1, b: 2 } },
  }, {
    "future-engine": {
      assets: { "dream-context": { memory: { parameters: { next: 2, replace: { b: 2 } } } }, another: { file: { path: "memory.md" } } },
      native: { replace: { z: 3 } },
    },
  }), input);
  assert.equal(result.assets["dream-context"]?.memory?.path, path.join(directory, "memory.md"));
  assert.deepEqual(result.assets["dream-context"]?.memory?.parameters, { keep: 1, next: 2, replace: { b: 2 } });
  assert.deepEqual(result.native, { "unheard-of-domain": { privateShape: [1, null, true] }, replace: { z: 3 } });
  assert.deepEqual(Object.keys(result.assets), ["dream-context", "another"]);
}));

test("skills partially override by id and disabled assets and packs are removed", async () => fixture(async (directory) => {
  await mkdir(path.join(directory, "skills"));
  await writeFile(path.join(directory, "skills", "SKILL.md"), "---\nname: writing\ndescription: Write useful text\n---\nContent");
  const value = document({
    skills: { writing: { path: "skills", required: true, parameters: { x: 1 } } },
    assets: { custom: { one: { path: "optional.md" } } },
    packs: { "test-pack": { root: "config", required: true, contributions: { custom: { x: { required: true, parameters: { a: 1 } } } } } },
  }, { alternate: {
    skills: { writing: { required: false, parameters: { y: 2 } } },
    assets: { custom: { one: { enabled: false } } },
    packs: { "test-pack": { contributions: { custom: { x: { enabled: false, parameters: { b: 2 } } } } } },
  }, disabled: { skills: { writing: { enabled: false } }, packs: { "test-pack": { enabled: false } } } });
  const result = await resolvePnpSettingsDocument(value, { engineId: "alternate", settingsDirectory: directory, environment: {} });
  assert.equal(result.skills[0]?.layout, "directory");
  assert.equal(result.skills[0]?.entry, "SKILL.md");
  assert.equal(result.skills[0]?.required, false);
  assert.deepEqual(result.skills[0]?.parameters, { x: 1, y: 2 });
  assert.deepEqual(result.assets.custom, {});
  assert.deepEqual(result.packs[0]?.contributions.custom?.x, { required: true, enabled: false, parameters: { a: 1, b: 2 } });
  const disabled = await resolvePnpSettingsDocument(value, { engineId: "disabled", settingsDirectory: directory, environment: {} });
  assert.deepEqual(disabled.skills, []);
  assert.deepEqual(disabled.packs, []);
}));

test("prototype-shaped domain and asset identifiers remain ordinary own properties", async () => fixture(async (directory) => {
  const assets = JSON.parse('{"__proto__":{"constructor":{"path":"optional.md","parameters":{"__proto__":{"polluted":true}}}},"constructor":{"__proto__":{"path":"optional.md"}}}');
  const result = await resolvePnpSettingsDocument(document({ assets, native: JSON.parse('{"__proto__":{"safe":true}}') }), {
    engineId: "constructor", settingsDirectory: directory, environment: {},
  });
  assert.ok(Object.hasOwn(result.assets, "__proto__"));
  assert.ok(Object.hasOwn(result.assets.constructor, "__proto__"));
  assert.equal(result.assets["__proto__"]?.constructor.id, "constructor");
  assert.ok(Object.hasOwn(result.native, "__proto__"));
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
}));

test("closed envelopes and reserved aliases reject mistakes with a useful path", async () => fixture(async (directory) => {
  const input = { engineId: "new", settingsDirectory: directory, environment: {} };
  // The misspelling this envelope exists to catch: eight known keys, and nothing else.
  await assert.rejects(resolvePnpSettingsDocument(document({ permisions: { default: "ask" } }), input), /common.permisions.*unknown field/);
  await assert.rejects(resolvePnpSettingsDocument(document({ typo: true }), input), /common.typo.*unknown field/);
  await assert.rejects(resolvePnpSettingsDocument(document({}, { new: { typo: true } }), input), /cores.new.typo/);
  await assert.rejects(resolvePnpSettingsDocument(document({ assets: { skill: {} } }), input), /use skills/);
  await assert.rejects(resolvePnpSettingsDocument(document({ assets: { instruction: {} } }), input), /use instructions/);
  await assert.rejects(resolvePnpSettingsDocument(document({ skills: { new: { enabled: true } } }), input), /common.skills.new.path/);
  await assert.rejects(resolvePnpSettingsDocument(document({ native: [] }), input), /common.native must be an object/);
}));

test("approved root names cannot be replaced by paths or relative environment roots", async () => fixture(async (directory) => {
  const input = { engineId: "new", settingsDirectory: directory, environment: {} };
  await assert.rejects(resolveAssetRoots(directory, { PNP_PACK_ROOTS: "relative" }), /PNP_PACK_ROOTS\[0\].*absolute/);
  await assert.rejects(resolveAssetRoots(directory, { PNP_PACK_ROOTS: `${directory};` }), /PNP_PACK_ROOTS\[1\].*absolute/);
  for (const root of [directory, "../config", "extra:99"]) {
    await assert.rejects(resolvePnpSettingsDocument(document({ packs: { valid: { root } } }), input), /root must name an approved/);
  }
  await assert.rejects(resolvePnpSettingsDocument(document({ packs: { "../escape": {} } }), input), /invalid pack id/);
  const roots = await resolveAssetRoots(directory, { PNP_PACK_ROOTS: directory });
  assert.deepEqual(roots.map((root) => root.name), ["delivery", "config", "extra:0"]);
}));

test("asset paths, directory entries and junctions cannot escape approved roots", async () => fixture(async (directory) => {
  const config = path.join(directory, "config");
  const outside = path.join(directory, "outside");
  await mkdir(config); await mkdir(outside);
  await writeFile(path.join(outside, "secret.md"), "outside");
  const input = { engineId: "new", settingsDirectory: config, environment: {} };
  const asset = (entry: unknown) => document({ assets: { new: { asset: entry } } });
  await assert.rejects(resolvePnpSettingsDocument(asset({ path: "../outside/secret.md" }), input), { code: "ASSET_OUTSIDE_ROOT" });
  await assert.rejects(resolvePnpSettingsDocument(asset({ path: "missing", layout: "directory", entry: "../secret.md" }), input), { code: "ASSET_OUTSIDE_ROOT" });
  await symlink(outside, path.join(config, "link"), "junction");
  await assert.rejects(resolvePnpSettingsDocument(asset({ path: "link/secret.md" }), input), { code: "ASSET_OUTSIDE_ROOT" });
  await assert.rejects(resolvePnpSettingsDocument(asset({ path: "link/missing.md" }), input), { code: "ASSET_OUTSIDE_ROOT" });
  await mkdir(path.join(config, "tree"));
  await symlink(outside, path.join(config, "tree", "link"), "junction");
  await assert.rejects(resolvePnpSettingsDocument(asset({ path: "tree", layout: "directory" }), input), { code: "ASSET_OUTSIDE_ROOT" });
  const allowed = await resolvePnpSettingsDocument(asset({ path: "link/secret.md" }), { ...input, environment: { PNP_PACK_ROOTS: outside } });
  assert.equal(allowed.assets.new?.asset?.path, path.join(outside, "secret.md"));
}));

test("optional missing files are warnings, required targeted missing files fail", async () => fixture(async (directory) => {
  const input = { engineId: "new", settingsDirectory: directory, environment: {} };
  const optional = await validatePnpSettingsDocument(document({ skills: { missing: { path: "absent" } } }), input);
  assert.equal(optional.ok, true);
  assert.equal(optional.problems[0]?.code, "ASSET_MISSING");
  assert.equal(optional.effective?.skills.length, 1);
  await assert.rejects(resolvePnpSettingsDocument(document({ skills: { missing: { path: "absent", required: true } } }), input), /missing or unreadable/);
  const targeted = await resolvePnpSettingsDocument(document({ skills: { missing: { path: "absent", required: true, engines: ["another"] } } }), input);
  assert.equal(targeted.skills.length, 1);
  await mkdir(path.join(directory, "broken"));
  await writeFile(path.join(directory, "broken", "SKILL.md"), "---\nname: broken\n---\nNo description");
  await assert.rejects(resolvePnpSettingsDocument(document({ skills: { broken: { path: "broken" } } }), input), /frontmatter/);
}));

test("a variable-name slot must name a variable, not carry its value", async () => fixture(async (directory) => {
  const input = { engineId: "new", settingsDirectory: directory, environment: {} };
  const model = (extra: Record<string, unknown>) => ({
    model: {
      default: { providerID: "local", modelID: "one" },
      models: [{ selection: { providerID: "local", modelID: "one" }, protocol: "openai-chat", ...extra }],
    },
  });
  // The schema says these hold NAMES. A pasted secret would otherwise be stored verbatim and then
  // treated as a variable that merely happens to be unset - silently, and in a file a page serves.
  await assert.rejects(
    resolvePnpSettingsDocument(document(model({ endpointEnvironment: "https://model.test/v1" })), input),
    /endpointEnvironment must name an environment variable/);
  await assert.rejects(
    resolvePnpSettingsDocument(document(model({ endpointEnvironment: "PNP_MODEL_ENDPOINT", apiKeyEnvironment: "sk-live-0123456789" })), input),
    /apiKeyEnvironment must name an environment variable/);
  await assert.rejects(resolvePnpSettingsDocument(document({
    mcp: { servers: { one: { transport: "stdio", command: "/bin/one", env: { OPENAI_API_KEY: "sk-live-0123456789" } } } },
  }), input), /env\.OPENAI_API_KEY must name an environment variable/);
  await assert.rejects(resolvePnpSettingsDocument(document({
    mcp: { servers: { one: { transport: "streamable-http", urlEnvironment: "PNP_ONE_URL", headerEnvironment: { Authorization: "Bearer abc" } } } },
  }), input), /headerEnvironment\.Authorization must name an environment variable/);
  // A real name still passes, header case and underscores included.
  const fine = await resolvePnpSettingsDocument(document({
    mcp: { servers: { one: { transport: "streamable-http", urlEnvironment: "PNP_ONE_URL", headerEnvironment: { Authorization: "PNP_ONE_AUTH" } } } },
  }), input);
  assert.equal(fine.mcp.servers[0]?.id, "one");
}));
