import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codeRoot } from "./lib.mjs";

const SELF = fileURLToPath(import.meta.url);

/**
 * `tsc --noEmit` type-checks TypeScript grammar; it has no idea that Node's own strip-only loader
 * (AGENTS.md requires "Node strip-only compatible syntax", and package.json's `start`/`test`
 * scripts run under `--experimental-strip-types`) is a much dumber, purely lexical stripper. A
 * private method literally named `declare` is valid TypeScript — tsc is happy with it — but
 * strip-only reads `declare` as the TS `declare` modifier keyword, drops it, and leaves the
 * `private` in front of a now-bare method body: `private declare(x) { ... }` becomes
 * `private (x) { ... }`-shaped text that is not valid JavaScript. tsc never sees this because it
 * never runs the stripper; the failure only appears the moment something actually imports the
 * module at runtime.
 *
 * This reproduces exactly that transform (`node:module`'s `stripTypeScriptTypes`, the function
 * Node's own loader calls) and then only *parses* the result with `vm.SourceTextModule` — never
 * links or evaluates it — so a bug like this is caught for every source file, including
 * `main.ts`, without ever running a file that opens storage, binds a port, or spawns a process. A
 * compile error here can only be this stripping bug, never an environment problem.
 *
 * `vm.SourceTextModule` requires `--experimental-vm-modules`, a flag this process was not
 * necessarily started with (foundation-check.mjs, an npm script, a plain `node scripts/...`
 * invocation). A disposable worker child is spawned with the exact flags needed instead of
 * requiring every caller to remember one, and — for the same reason a parse failure should never
 * take the checking process down with it — a parse failure only ever happens inside that child.
 */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }

function collectFailures(root) {
  const files = walk(path.join(root, "src")).filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"));
  const failures = [];
  for (const file of files) {
    const relative = path.relative(root, file);
    let stripped;
    try { stripped = stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" }); }
    catch (error) { failures.push({ file: relative, error: errorMessage(error) }); continue; }
    try { new vm.SourceTextModule(stripped, { identifier: relative }); }
    catch (error) { failures.push({ file: relative, error: errorMessage(error) }); }
  }
  return failures;
}

if (process.argv[2] === "--worker") {
  process.stdout.write(JSON.stringify(collectFailures(process.argv[3])));
  process.exit(0);
}

export function checkStripOnlyLoadability(root = codeRoot) {
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--no-warnings", SELF, "--worker", root], { encoding: "utf8" });
  if (!result.stdout) {
    throw new Error(`strip-only-check worker did not produce output: ${result.stderr || result.error?.message || `exit ${result.status}`}`);
  }
  return JSON.parse(result.stdout);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const failures = checkStripOnlyLoadability();
  if (failures.length) {
    console.error(`${failures.length} file(s) type-check but are not loadable under Node's strip-only stripper:`);
    for (const failure of failures) console.error(`  ${failure.file}: ${failure.error}`);
    process.exit(1);
  }
  console.log("Strip-only loadability: PASS");
}
