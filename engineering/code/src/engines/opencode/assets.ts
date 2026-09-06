import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AssetBinding, Json, Session } from "../../contracts/index.ts";
import { PnpError } from "../../core/errors.ts";
import { buildRedirectPlan } from "./native-config.ts";
import type { OpenCodeEngineConfig } from "./config.ts";

const SUPPORTED_KINDS = new Set<AssetBinding["kind"]>(["skill", "instruction"]);

/**
 * Canonical, single-copy location for a projected instruction asset. Also referenced verbatim by
 * native-config.ts's `instructions` array, so the two modules must agree on this path without sharing state.
 */
export function instructionAssetTargetPath(nativeDataDirectory: string, asset: AssetBinding): string {
  return path.join(nativeDataDirectory, "opencode", "assets", "instructions", asset.id, path.basename(asset.path));
}
/**
 * Skill assets are mirrored to every RedirectPlan.configRoots candidate under `opencode/skills/<id>/`, matching
 * the global skill path OpenCode documents (`~/.config/opencode/skills/<name>/SKILL.md`, T03-opencode.md #16).
 * Project-level skill paths (`.opencode/skills`, cwd-relative) are deliberately not used: writing into
 * Session.directory would be writing into the user's workspace, which contracts.md section 8 forbids.
 */
export function skillAssetTargetPaths(nativeDataDirectory: string, config: OpenCodeEngineConfig, asset: AssetBinding): string[] {
  const plan = buildRedirectPlan(nativeDataDirectory, config);
  return plan.configRoots.map((root) => path.join(root, "opencode", "skills", asset.id, path.basename(asset.path)));
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
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(asset.path, target);
      projected.push({ id: asset.id, kind: asset.kind, targets: [target] });
    } else if (asset.kind === "skill") {
      const targets = skillAssetTargetPaths(input.nativeDataDirectory, config, asset);
      for (const target of targets) {
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(asset.path, target);
      }
      projected.push({ id: asset.id, kind: asset.kind, targets });
    } else {
      skipped.push(asset.id);
    }
  }
  const result: Json = { projected: projected.map((entry) => ({ id: entry.id, kind: entry.kind, targets: entry.targets })), skipped };
  return result;
}
