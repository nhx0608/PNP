import { copyFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AssetBinding, Json, Session } from "../../contracts/index.ts";
import { PnpError } from "../../core/errors.ts";
import { buildRedirectPlan } from "./native-config.ts";
import type { OpenCodeEngineConfig } from "./config.ts";

const SUPPORTED_KINDS = new Set<AssetBinding["kind"]>(["skill", "instruction"]);

/**
 * Canonical, single-copy location for a projected instruction asset, always absolute. Also referenced verbatim
 * by native-config.ts's `instructions` array, so the two modules must agree on this path without sharing state:
 * the path written into the generated config is the path of the copy made here, so the engine reads a file this
 * Pack put there. `path.resolve` (not `join`) so a relative nativeDataDirectory can never produce a relative
 * `instructions` entry, which OpenCode would resolve against the config file's own directory instead.
 */
export function instructionAssetTargetPath(nativeDataDirectory: string, asset: AssetBinding): string {
  return path.resolve(nativeDataDirectory, "opencode", "assets", "instructions", assetDirectoryName(asset.id), path.basename(asset.path));
}
/**
 * An asset id is a label, not a file name: the shipped ids look like `instruction:competition`, and a colon is
 * not a legal path character on Windows (mkdir fails with an unwrapped error, which surfaced as a 500 on the
 * first Windows run). The directory name keeps every portable character and replaces the rest; when anything
 * was replaced a short digest of the original id is appended so two ids that differ only in replaced
 * characters never share a directory.
 */
export function assetDirectoryName(id: string): string {
  const portable = id.replace(/[^A-Za-z0-9._-]/g, "_");
  if (portable === id) return id;
  return `${portable}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}
/**
 * Skill assets are copied into every RedirectPlan.skillRoots directory under `<root>/<id>/`: the private
 * OPENCODE_CONFIG_DIR (`<dir>/skills/<id>/SKILL.md`, the documented `.opencode` structure) and every redirected
 * config home (`<home>/opencode/skills/<id>/SKILL.md`, the global skill path OpenCode documents --
 * `~/.config/opencode/skills/<name>/SKILL.md`, T03-opencode.md #16). OPENCODE_CONFIG names a *file* and says
 * nothing about where skills are scanned, which is why the config-directory route matters now that HOME is no
 * longer redirected. Project-level skill paths (`.opencode/skills`, cwd-relative) are deliberately not used:
 * writing into Session.directory would be writing into the user's workspace, which contracts.md section 8
 * forbids.
 */
export function skillAssetTargetPaths(nativeDataDirectory: string, config: OpenCodeEngineConfig, asset: AssetBinding): string[] {
  const plan = buildRedirectPlan(nativeDataDirectory, config);
  return plan.skillRoots.map((root) => path.join(root, assetDirectoryName(asset.id), path.basename(asset.path)));
}

export interface ProjectAssetsInput {
  assets: readonly AssetBinding[];
  session: Session;
  nativeDataDirectory: string;
}
/**
 * Copies skill and instruction assets into this session's private native directory. Required assets of an
 * unsupported kind fail here, before openAcpChannel ever calls launch() or sends a prompt (contracts.md section 8:
 * "必需资产...必须在发送 Prompt 前拒绝"). Optional unsupported assets are skipped and reported, never silently
 * dropped nor claimed as projected.
 */
export async function projectOpenCodeAssets(config: OpenCodeEngineConfig, input: ProjectAssetsInput): Promise<Json> {
  const unsupportedRequired = input.assets.filter((asset) => !SUPPORTED_KINDS.has(asset.kind) && asset.required);
  if (unsupportedRequired.length > 0) {
    const kinds = [...new Set(unsupportedRequired.map((asset) => asset.kind))];
    throw new PnpError("ENGINE_ASSET_KIND_UNSUPPORTED",
      `OpenCode Pack has no native projection for required asset kind(s): ${kinds.join(", ")}.`, 502);
  }
  const projected: { id: string; kind: string; targets: string[] }[] = [];
  const skipped: string[] = [];
  for (const asset of input.assets) {
    if (asset.kind === "instruction") {
      const target = instructionAssetTargetPath(input.nativeDataDirectory, asset);
      await place(asset, target);
      projected.push({ id: asset.id, kind: asset.kind, targets: [target] });
    } else if (asset.kind === "skill") {
      const targets = skillAssetTargetPaths(input.nativeDataDirectory, config, asset);
      for (const target of targets) await place(asset, target);
      projected.push({ id: asset.id, kind: asset.kind, targets });
    } else {
      skipped.push(asset.id);
    }
  }
  const result: Json = { projected: projected.map((entry) => ({ id: entry.id, kind: entry.kind, targets: entry.targets })), skipped };
  return result;
}
/** A copy that cannot be made is an engine-side projection failure with a code, never an anonymous 500. */
async function place(asset: AssetBinding, target: string): Promise<void> {
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(asset.path, target);
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN";
    throw new PnpError("ENGINE_ASSET_PROJECTION_FAILED",
      `OpenCode Pack could not place asset ${asset.id} (${code}).`, 502);
  }
}
