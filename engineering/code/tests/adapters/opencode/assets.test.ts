import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { instructionAssetTargetPath, projectOpenCodeAssets, skillAssetTargetPaths } from "../../../src/engines/opencode/assets.ts";
import { parseOpenCodeEngineConfig, type OpenCodeEngineConfig } from "../../../src/engines/opencode/config.ts";
import type { AssetBinding, Session } from "../../../src/contracts/index.ts";

function config(): OpenCodeEngineConfig {
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
    redirect: { variables: { XDG_CONFIG_HOME: "xdg-config", HOME: "home" } },
    model: { policy: "launch" },
    headerEnvironmentPrefix: "PNP_OPENCODE_HEADER_",
    timeouts: { requestMs: 30000, cancelGraceMs: 2000, cancelAckMs: 1000 },
    capabilityEvidence: "probed",
  });
}
function fakeSession(directory: string): Session {
  return {
    id: "session-1", title: "t", directory, engineId: "opencode", channelId: "acp",
    lifecycle: "active", status: "idle", recovery: "ready", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
async function makeAsset(sourceRoot: string, id: string, kind: AssetBinding["kind"], filename: string, content: string, required: boolean): Promise<AssetBinding> {
  const file = path.join(sourceRoot, filename);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  return { id, kind, path: file, sha256, required };
}

test("a required asset of an unsupported kind fails before anything is written", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-opencode-assets-"));
  try {
    const sourceRoot = path.join(root, "source");
    const nativeDataDirectory = path.join(root, "native");
    const asset = await makeAsset(sourceRoot, "ext-1", "native-extension", "ext.json", "{}", true);
    await assert.rejects(
      projectOpenCodeAssets(config(), { assets: [asset], session: fakeSession(path.join(root, "workspace")), nativeDataDirectory }),
      { code: "ENGINE_ASSET_KIND_UNSUPPORTED" },
    );
    await assert.rejects(readFile(path.join(nativeDataDirectory, "opencode", "home", ".config", "opencode", "opencode.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an optional asset of an unsupported kind is skipped, not silently dropped nor claimed as projected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-opencode-assets-"));
  try {
    const sourceRoot = path.join(root, "source");
    const nativeDataDirectory = path.join(root, "native");
    const asset = await makeAsset(sourceRoot, "ext-1", "native-extension", "ext.json", "{}", false);
    const result = await projectOpenCodeAssets(config(), { assets: [asset], session: fakeSession(path.join(root, "workspace")), nativeDataDirectory }) as { projected: unknown[]; skipped: string[] };
    assert.deepEqual(result.skipped, ["ext-1"]);
    assert.deepEqual(result.projected, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a skill asset is mirrored to every candidate config root, never into the workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-opencode-assets-"));
  try {
    const sourceRoot = path.join(root, "source");
    const nativeDataDirectory = path.join(root, "native");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const asset = await makeAsset(sourceRoot, "skill-office", "skill", "SKILL.md", "# Office skill\n", true);
    const targets = skillAssetTargetPaths(nativeDataDirectory, config(), asset);
    assert.equal(targets.length, 2);
    const result = await projectOpenCodeAssets(config(), { assets: [asset], session: fakeSession(workspace), nativeDataDirectory }) as { projected: { id: string; targets: string[] }[] };
    assert.equal(result.projected.length, 1);
    assert.deepEqual(result.projected[0]!.targets, targets);
    for (const target of targets) {
      assert.ok(target.startsWith(nativeDataDirectory + path.sep), "skill must be projected under the private native directory");
      assert.ok(!target.startsWith(workspace), "skill must never be projected into the user workspace");
      assert.equal(await readFile(target, "utf8"), "# Office skill\n");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an instruction asset is copied to its canonical target and matches instructionAssetTargetPath", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-opencode-assets-"));
  try {
    const sourceRoot = path.join(root, "source");
    const nativeDataDirectory = path.join(root, "native");
    const asset = await makeAsset(sourceRoot, "inst-agents", "instruction", "AGENTS.md", "Follow the rules.\n", true);
    const expected = instructionAssetTargetPath(nativeDataDirectory, asset);
    const result = await projectOpenCodeAssets(config(), { assets: [asset], session: fakeSession(path.join(root, "workspace")), nativeDataDirectory }) as { projected: { id: string; targets: string[] }[] };
    assert.deepEqual(result.projected[0]!.targets, [expected]);
    assert.equal(await readFile(expected, "utf8"), "Follow the rules.\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
