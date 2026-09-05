import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { PnpError } from "../core/errors.ts";

export async function normalizeWorkspace(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) {
    throw new PnpError("VALIDATION_ERROR", "directory must be an absolute local path.", 400);
  }
  const canonical = await realpath(directory);
  if (!(await stat(canonical)).isDirectory()) {
    throw new PnpError("VALIDATION_ERROR", "directory must reference a directory.", 400);
  }
  return canonical;
}
/** Lexical containment helper only; callers still need realpath and reparse-point checks. */
export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
