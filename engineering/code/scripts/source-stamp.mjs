#!/usr/bin/env node
// One reproducible fingerprint of the TypeScript sources a `dist/` was built from.
//
// Both the packager (scripts/package-release.mjs, which ships a prebuilt dist/ inside the offline
// bundle) and the launcher (scripts/pnp-local.ps1, which must decide whether that dist/ is still
// current) need the SAME number, so the computation lives here once instead of being written twice
// in two languages. The launcher runs `node scripts/source-stamp.mjs` and compares the output with
// runtime/bootstrap/state/build.txt; when they match, `npm run build` is skipped and a delivered
// package needs neither TypeScript nor a network.
//
// The fingerprint is content-based, never timestamp-based: an extracted ZIP has arbitrary mtimes,
// so "dist is newer than src" cannot be asked of a delivered package. Line endings are part of the
// content hash, which is exactly why the repository pins LF (.gitattributes) and why the packager
// copies files byte for byte.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { codeRoot } from "./lib.mjs";

/** Every build input, relative to code/, in a stable order. */
const EXTRA_INPUTS = ["tsconfig.json"];

/**
 * Directories that are generated output, never source, and therefore never shipped. They must be
 * skipped HERE as well as by the packager: the launcher compares this stamp against the one recorded
 * in the delivered package to decide whether `dist/` is still current, so a directory the packager
 * drops but this walk counts would make the two numbers permanently disagree and force a rebuild --
 * needing TypeScript and a network -- on the assessor's machine. `__pycache__` appears the first
 * time the Python MCP server runs and is specific to one interpreter version.
 */
const IGNORED_DIRECTORIES = new Set(["__pycache__"]);

function walkSorted(dir, root, into) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      walkSorted(full, root, into);
    } else if (entry.isFile()) into.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return into;
}

/** `{ stamp, files }` for the sources under `root` (default: this checkout's code/). */
export function computeSourceStamp(root = codeRoot) {
  const sourceRoot = path.join(root, "src");
  const relative = existsSync(sourceRoot) ? walkSorted(sourceRoot, root, []) : [];
  for (const extra of EXTRA_INPUTS) {
    if (existsSync(path.join(root, extra))) relative.push(extra);
  }
  relative.sort((a, b) => a.localeCompare(b));

  const digest = createHash("sha256");
  for (const file of relative) {
    const absolute = path.join(root, file);
    const bytes = readFileSync(absolute);
    // path + byte size + content hash: a rename, a truncation and an edit each change the stamp.
    digest.update(`${file}\u0000${statSync(absolute).size}\u0000${createHash("sha256").update(bytes).digest("hex")}\n`);
  }
  return { stamp: digest.digest("hex"), files: relative.length };
}

// pathToFileURL, not a `file://` template: argv[1] is a Windows path with backslashes and a drive
// letter, which never equals import.meta.url, so the template form made this script print nothing
// and exit 0 on the one platform the package ships for. pnp-local.ps1 reads that empty output as
// "cannot compute a stamp", concludes the prebuilt dist/ is stale, and fails the delivered bundle
// with "dist\main.js is missing or out of date and the TypeScript compiler is not installed" --
// the bundle omits devDependencies, so it never has one. Silent, and fatal exactly on the
// assessor's machine.
// argv[1] is undefined when this module is imported by `node -e`, and pathToFileURL(undefined)
// throws -- which would break every importer, not just the CLI. Checked, not assumed.
const invokedAs = process.argv[1];
if (invokedAs !== undefined && import.meta.url === pathToFileURL(invokedAs).href) {
  const result = computeSourceStamp();
  process.stdout.write(process.argv.includes("--json")
    ? `${JSON.stringify(result)}\n`
    : `${result.stamp}\n`);
}
