import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Windows PowerShell 5.1 - the shell an assessor gets by default, and the one INSTRUCTION.md
 * targets - decodes a .ps1 that has no byte-order mark using the machine's ANSI code page, not
 * UTF-8. On a Chinese Windows that is code page 936, so every multi-byte character in the file is
 * mangled; some of the resulting byte pairs terminate a string or open a subexpression, and the
 * script fails to PARSE. It never runs, so no amount of correct logic inside it matters.
 *
 * This is not hypothetical: docs/run-eval-tasks.ps1 shipped without a BOM and produced 40+ parse
 * errors under PS 5.1 ("Unexpected token '浠嶄娇鐢�...'", "The string is missing the terminator"),
 * which made the entire evaluation suite unrunnable on the target platform while every automated
 * check stayed green - nothing in CI reads a .ps1 with PowerShell.
 *
 * Rule enforced here: a .ps1 containing any non-ASCII byte must start with the UTF-8 BOM. Files
 * that are pure ASCII are unaffected, because the ANSI code page and UTF-8 agree on those bytes.
 * PowerShell 7 does not need this, but the assessor is not running PowerShell 7.
 */

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const repositoryRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "runtime", "data", ".idea"]);

function collect(directory, found = []) {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch { return found; }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      collect(full, found);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".ps1")) {
      found.push(full);
    }
  }
  return found;
}

export function checkPowerShellEncoding(root = repositoryRoot) {
  const failures = [];
  for (const file of collect(root)) {
    const bytes = readFileSync(file);
    const hasNonAscii = bytes.some((byte) => byte > 0x7f);
    if (!hasNonAscii) continue;
    if (!bytes.subarray(0, 3).equals(BOM)) {
      failures.push({ file: path.relative(root, file), bytes: statSync(file).size });
    }
  }
  return failures;
}

// pathToFileURL, not a hand-built `file://` string: on Windows argv[1] is a backslash path and the
// naive comparison silently never matches, turning the whole check into a no-op that exits 0.
// scripts/strip-only-check.mjs shipped with exactly that bug.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = checkPowerShellEncoding();
  if (failures.length) {
    console.error(`PowerShell encoding check failed: ${failures.length} script(s) contain non-ASCII text but no UTF-8 BOM.`);
    console.error("Windows PowerShell 5.1 will decode these with the ANSI code page and fail to parse them.");
    for (const failure of failures) console.error(`  ${failure.file}`);
    console.error('Fix: rewrite the file as "UTF-8 with BOM" (VS Code: Save with Encoding -> UTF-8 with BOM).');
    process.exit(1);
  }
  console.log("PowerShell encoding check: PASS");
}
