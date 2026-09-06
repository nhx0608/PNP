import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
export const codeRoot = fileURLToPath(new URL("../", import.meta.url));
export const engineeringRoot = path.dirname(codeRoot);
export function npm(args, cwd = codeRoot) {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")];
  const cli = candidates.find((p) => p && existsSync(p));
  if (!cli) throw new Error("npm CLI entrypoint not found.");
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, stdio: "inherit", shell: false });
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} failed.`);
}

/** An unset variable and an empty one mean the same thing everywhere in this repo's scripts:
 *  use the default, never let `Number("")` (which is 0) silently pick an invalid value. */
export function stringEnv(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw;
}

/** Parses a leading `major.minor.patch` out of a version string (a `v` prefix, if present, is ignored). */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value ?? "");
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * True when `actual` is the same major version as `minimum` and is not older than it — the same
 * range `package.json` declares (`>=<minimum> <nextMajor>`). An exact-equality check here is what
 * made every doctor/foundation/release gate fail on a legitimate 24.20.x runtime (see
 * docs/engineering-review.md R10): a patch or minor bump within the supported major version must
 * keep passing.
 */
export function nodeVersionSatisfies(minimum, actual) {
  const min = parseVersion(minimum);
  const cur = parseVersion(actual);
  if (!min || !cur) return false;
  if (cur.major !== min.major) return false;
  if (cur.minor !== min.minor) return cur.minor > min.minor;
  return cur.patch >= min.patch;
}

/** Resolves the data directory the same way everywhere: an explicit `PNP_DATA_DIR` (even a
 *  relative one, resolved against the current working directory as the operator intended), or a
 *  `data/` directory anchored to the package root — never a bare "data" that silently depends on
 *  the caller's current working directory. */
export function resolveDataDirectory(root = codeRoot) {
  return path.resolve(stringEnv("PNP_DATA_DIR", path.join(root, "data")));
}
