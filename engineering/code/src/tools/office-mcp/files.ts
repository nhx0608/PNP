import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { OfficeToolError } from "./errors.ts";
import { requireAbsolutePath, requireExistingDirectory } from "./paths.ts";

export type FoundFile = { path: string; name: string; size: number; modifiedAt: string };

export type FindResult = {
  root: string;
  nameContains?: string;
  extensions?: string[];
  files: FoundFile[];
  directories: { path: string; name: string }[];
  scanned: number;
  truncated: boolean;
};

export const DEFAULT_MAX_RESULTS = 500;

function normalizeExtensions(extensions: readonly string[] | undefined): string[] | undefined {
  if (extensions === undefined || extensions.length === 0) return undefined;
  return extensions.map((extension) => {
    const trimmed = extension.trim().toLowerCase();
    return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
  });
}

/**
 * Name matching is case-insensitive so an English fragment behaves the way a user expects; a Chinese
 * fragment such as 西安 is unaffected because it has no case.
 */
function nameMatches(name: string, fragment: string | undefined, extensions: string[] | undefined): boolean {
  if (fragment !== undefined && fragment.length > 0 && !name.toLowerCase().includes(fragment.toLowerCase())) return false;
  if (extensions !== undefined && !extensions.includes(path.extname(name).toLowerCase())) return false;
  return true;
}

export async function fsFind(options: {
  root: string;
  nameContains?: string;
  extensions?: string[];
  recursive?: boolean;
  maxResults?: number;
}): Promise<FindResult> {
  const root = await requireExistingDirectory("root", options.root);
  const extensions = normalizeExtensions(options.extensions);
  const recursive = options.recursive !== false;
  const maxResults = options.maxResults === undefined || options.maxResults <= 0 ? DEFAULT_MAX_RESULTS : options.maxResults;
  const files: FoundFile[] = [];
  const directories: { path: string; name: string }[] = [];
  let scanned = 0;
  let truncated = false;
  const queue: string[] = [root];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      // An unreadable directory (permissions, a vanished mount) must not abort a search that has
      // already found results elsewhere in the tree.
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      scanned += 1;
      if (entry.isDirectory()) {
        // Directories are reported only when the caller asked for a name fragment: they are what
        // explains a later "nothing was deleted" (the match was a folder, and folders are never
        // deleted). Listing every directory of a tree would just bury the files.
        const fragment = options.nameContains;
        if (fragment !== undefined && fragment.length > 0 && nameMatches(entry.name, fragment, undefined)) {
          directories.push({ path: full, name: entry.name });
        }
        if (recursive) queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!nameMatches(entry.name, options.nameContains, extensions)) continue;
      if (files.length >= maxResults) {
        truncated = true;
        continue;
      }
      const info = await stat(full).catch(() => null);
      files.push({
        path: full,
        name: entry.name,
        size: info === null ? 0 : info.size,
        modifiedAt: info === null ? "" : info.mtime.toISOString(),
      });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const result: FindResult = { root, files, directories, scanned, truncated };
  if (options.nameContains !== undefined) result.nameContains = options.nameContains;
  if (extensions !== undefined) result.extensions = extensions;
  return result;
}

/**
 * Directories a delete must never touch. The "contains" list is checked for the whole subtree
 * because nothing under it is ever an evaluation artefact; the "exact" list stops a caller from
 * pointing the tool at a drive root or a profile root while still allowing the task directories
 * beneath them, which is where the documents actually live.
 */
const PROTECTED_SUBTREES_WINDOWS = ["windows", "program files", "program files (x86)", "programdata"];
const PROTECTED_SUBTREES_POSIX = ["/etc", "/bin", "/sbin", "/boot", "/proc", "/sys", "/dev", "/lib", "/lib64"];
const PROTECTED_EXACT_POSIX = ["/", "/home", "/root", "/usr", "/var", "/opt", "/srv", "/mnt", "/media"];

function windowsParts(target: string): { drive: string | null; segments: string[] } {
  const normalized = target.replace(/\//g, "\\");
  const drive = /^([A-Za-z]:)\\/.exec(normalized)?.[1] ?? null;
  const rest = drive === null ? normalized : normalized.slice(drive.length + 1);
  return { drive, segments: rest.split("\\").filter((segment) => segment.length > 0) };
}

export function protectedLocationReason(target: string): string | null {
  const normalized = path.normalize(target).replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(normalized) || /^[A-Za-z]:[\\/]?$/.test(target)) return "驱动器根目录 / drive root";
  const windows = windowsParts(normalized);
  if (windows.drive !== null) {
    if (windows.segments.length === 0) return "驱动器根目录 / drive root";
    const first = (windows.segments[0] ?? "").toLowerCase();
    if (PROTECTED_SUBTREES_WINDOWS.includes(first)) return `系统目录 / Windows system directory ${windows.drive}\\${windows.segments[0]}`;
    if (first === "users" && windows.segments.length <= 2) return "用户目录根 / user profile root";
    return null;
  }
  if (normalized === "" || normalized === "/") return "文件系统根目录 / filesystem root";
  if (PROTECTED_EXACT_POSIX.includes(normalized)) return `系统目录 / system directory ${normalized}`;
  for (const prefix of PROTECTED_SUBTREES_POSIX) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return `系统目录 / system directory ${prefix}`;
  }
  return null;
}

function assertDeletable(target: string): void {
  const reason = protectedLocationReason(target);
  if (reason !== null) {
    throw new OfficeToolError("PROTECTED_LOCATION", `拒绝在受保护位置删除 / refusing to delete in a protected location: ${target} (${reason})`);
  }
  const parent = path.dirname(target);
  const parentReason = protectedLocationReason(parent);
  if (parentReason !== null) {
    throw new OfficeToolError("PROTECTED_LOCATION",
      `拒绝删除受保护目录中的文件 / refusing to delete a file in a protected directory: ${target} (${parentReason})`);
  }
}

export type DeleteResult = {
  dryRun: boolean;
  matched: string[];
  deleted: string[];
  failed: { path: string; reason: string }[];
  skippedDirectories: string[];
};

/**
 * Deletes files and only files. Directories are reported as skipped rather than removed: a task that
 * says "delete every file whose name contains 西安" must not take the folder that holds them with it.
 */
export async function fsDelete(options: {
  paths?: string[];
  root?: string;
  nameContains?: string;
  extensions?: string[];
  recursive?: boolean;
  dryRun?: boolean;
}): Promise<DeleteResult> {
  const dryRun = options.dryRun === true;
  const explicit = options.paths ?? [];
  const hasSelector = options.root !== undefined && options.root.length > 0;
  if (explicit.length === 0 && !hasSelector) {
    throw new OfficeToolError("INVALID_ARGUMENT", "必须提供 paths 或 root(+nameContains) / needs either paths or root");
  }
  const matched: string[] = [];
  const failed: { path: string; reason: string }[] = [];
  const skippedDirectories: string[] = [];
  for (const candidate of explicit) {
    const absolute = requireAbsolutePath("paths[]", candidate);
    const info = await stat(absolute).catch(() => null);
    if (info === null) {
      failed.push({ path: absolute, reason: "PATH_NOT_FOUND 文件不存在 / file does not exist" });
      continue;
    }
    if (info.isDirectory()) {
      skippedDirectories.push(absolute);
      continue;
    }
    matched.push(absolute);
  }
  if (hasSelector) {
    if ((options.nameContains === undefined || options.nameContains.length === 0)
      && (options.extensions === undefined || options.extensions.length === 0)) {
      throw new OfficeToolError("INVALID_ARGUMENT",
        "按 root 删除时必须提供 nameContains 或 extensions，拒绝无条件删除整棵目录树 /" +
        " deleting by root requires nameContains or extensions; refusing to delete a whole tree");
    }
    const found = await fsFind({
      root: options.root as string,
      ...(options.nameContains === undefined ? {} : { nameContains: options.nameContains }),
      ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
      recursive: options.recursive !== false,
      maxResults: 100_000,
    });
    for (const file of found.files) if (!matched.includes(file.path)) matched.push(file.path);
    for (const directory of found.directories) skippedDirectories.push(directory.path);
  }
  for (const target of matched) assertDeletable(target);
  const deleted: string[] = [];
  if (!dryRun) {
    for (const target of matched) {
      try {
        await unlink(target);
        deleted.push(target);
      } catch (error) {
        failed.push({ path: target, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { dryRun, matched, deleted, failed, skippedDirectories };
}
