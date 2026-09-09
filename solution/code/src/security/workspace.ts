import path from "node:path";
import { mkdir, realpath, stat } from "node:fs/promises";
import { PnpError } from "../core/errors.ts";

export interface WorkspaceOptions {
  /** The gateway's own data directory. A workspace may never be placed inside it. */
  dataDirectory: string;
}
export interface NormalizedWorkspace {
  directory: string;
  /** True when this call created the directory, so the session record can say so. */
  created: boolean;
}
/**
 * Locations the gateway refuses to hand to an engine on Windows whatever the caller asks for.
 * Read from the environment rather than hard-coded: a machine may not use C:\Windows.
 */
function protectedRoots(): string[] {
  if (process.platform !== "win32") return [];
  return ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)"]
    .map((name) => process.env[name])
    .filter((value): value is string => value !== undefined && value.trim() !== "")
    .map((value) => path.resolve(value));
}
function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}
/** Canonicalises an existing path, or answers null when nothing is there yet. */
async function canonicalize(target: string): Promise<string | null> {
  try { return await realpath(target); }
  catch (error: unknown) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (code === "EACCES" || code === "EPERM") throw new PnpError("WORKSPACE_FORBIDDEN", "directory is not accessible.", 403);
    throw error;
  }
}
/**
 * Resolves the session working directory the assessment names. The path must be absolute and must
 * stay inside the boundaries below, but it does not have to exist yet: the assessment says a
 * directory is passed in, never that it was created first, and refusing the whole case at
 * POST /session over a missing folder costs far more than creating it. A created directory is
 * reported back so the session record can carry the fact; deleting the session never removes it.
 */
export async function normalizeWorkspace(directory: string, options: WorkspaceOptions): Promise<NormalizedWorkspace> {
  if (!path.isAbsolute(directory)) {
    throw new PnpError("VALIDATION_ERROR", "directory must be an absolute local path.", 400);
  }
  const requested = path.resolve(directory);
  // A volume root is every file on it. Nothing below can make that a working directory.
  if (path.parse(requested).root === requested) {
    throw new PnpError("VALIDATION_ERROR", "directory must not be a filesystem root.", 400);
  }
  const requestedDataRoot = path.resolve(options.dataDirectory);
  // Both spellings of the data directory are compared: a caller naming the path as written must be
  // caught before anything is created, and a link must not lead back in afterwards.
  const dataRoots = new Set([requestedDataRoot, (await canonicalize(requestedDataRoot)) ?? requestedDataRoot]);
  const guarded = protectedRoots();
  const assertOutsideBoundaries = (candidate: string): void => {
    // The gateway's own state is not a workspace: an engine working there could rewrite the
    // database, the instance lock or another session's native history.
    for (const root of dataRoots) {
      if (isWithin(root, candidate)) {
        throw new PnpError("VALIDATION_ERROR", "directory must not be inside the gateway data directory.", 400);
      }
    }
    for (const root of guarded) {
      if (isWithin(root, candidate)) {
        throw new PnpError("WORKSPACE_FORBIDDEN", "directory is inside a protected system location.", 403);
      }
    }
  };
  assertOutsideBoundaries(requested);
  let resolved = await canonicalize(requested);
  let created = false;
  if (resolved === null) {
    try { await mkdir(requested, { recursive: true }); }
    catch (error: unknown) {
      const code = errorCode(error);
      if (code === "EACCES" || code === "EPERM") throw new PnpError("WORKSPACE_FORBIDDEN", "directory could not be created.", 403);
      if (code === "ENOTDIR" || code === "EEXIST") throw new PnpError("VALIDATION_ERROR", "directory must reference a directory.", 400);
      throw error;
    }
    created = true;
    resolved = await canonicalize(requested);
    if (resolved === null) throw new PnpError("VALIDATION_ERROR", "directory must reference an existing directory.", 400);
  }
  let entry;
  try { entry = await stat(resolved); }
  catch (error: unknown) {
    const code = errorCode(error);
    if (code === "EACCES" || code === "EPERM") throw new PnpError("WORKSPACE_FORBIDDEN", "directory is not accessible.", 403);
    throw error;
  }
  if (!entry.isDirectory()) {
    throw new PnpError("VALIDATION_ERROR", "directory must reference a directory.", 400);
  }
  // Checked again on the canonical path: a link may point back inside a boundary the request did
  // not name lexically.
  assertOutsideBoundaries(resolved);
  return { directory: resolved, created };
}
/** Lexical containment helper only; callers still need realpath and reparse-point checks. */
export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
