import { readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AssetBinding } from "../contracts/index.ts";
import { PnpError } from "../core/errors.ts";
export async function resolveAsset(root: string, input: Omit<AssetBinding, "sha256"> & { sha256?: string }): Promise<AssetBinding> {
  const base = await realpath(root);
  const file = await realpath(path.resolve(base, input.path));
  const relative = path.relative(base, file);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new PnpError("ASSET_OUTSIDE_ROOT", "Asset path leaves the approved asset root.", 403);
  const info = await stat(file);
  if (!info.isFile() || info.size > 1024 * 1024) throw new PnpError("ASSET_INVALID", "Asset must be a bounded regular file.", 400);
  const digest = createHash("sha256").update(await readFile(file)).digest("hex");
  if (input.sha256 !== undefined && input.sha256 !== digest) throw new PnpError("ASSET_DIGEST_MISMATCH", "Asset content changed.", 409);
  return { ...input, path: file, sha256: digest };
}
