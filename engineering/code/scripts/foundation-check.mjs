import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { npm, codeRoot, engineeringRoot, nodeVersionSatisfies } from "./lib.mjs";
import { checkStripOnlyLoadability } from "./strip-only-check.mjs";

const toolchain = JSON.parse(readFileSync(path.join(codeRoot, "toolchain.json"), "utf8"));

// Range, not exact equality: a legitimate 24.20.x runtime failed this gate outright before (see
// docs/engineering-review.md R10). A mismatch is reported and the process exits cleanly instead
// of throwing an uncaught error, which used to abort with a raw stack trace.
if (!nodeVersionSatisfies(toolchain.node, process.versions.node)) {
  console.error(`Foundation gate failed: requires Node ${toolchain.node} or a later release within the same major version (matches package.json "engines"); found ${process.versions.node}.`);
  process.exit(1);
}

if (!existsSync(path.join(codeRoot, "package-lock.json"))) {
  console.error("Foundation gate failed: real package-lock.json is required. Run `npm run dependencies:freeze` in the approved network.");
  process.exit(1);
}

// The delivery's own checksum manifest must match the tree it ships with a stale manifest is
// exactly the "the package was tampered with" signal a third party sees (see
// docs/engineering-review-2.md §5). Regenerate it with `npm run refresh-manifest` after an
// intentional change, never by hand.
const verifyScript = path.join(engineeringRoot, "VERIFY.mjs");
if (existsSync(verifyScript)) {
  const result = spawnSync(process.execPath, [verifyScript], { cwd: engineeringRoot, stdio: "inherit", shell: false });
  if (result.status !== 0) {
    console.error("Foundation gate failed: the delivery checksum manifest does not match the current tree. Run `npm run refresh-manifest` after an intentional change and commit the result.");
    process.exit(1);
  }
} else {
  console.error("Foundation gate warning: engineering/VERIFY.mjs is missing; checksum manifest was not verified.");
}

// tsc type-checks TypeScript grammar; it has no idea Node's strip-only loader is a much dumber
// lexical stripper, so a name like a private method called `declare` type-checks cleanly and then
// fails to load at runtime under --experimental-strip-types (see scripts/strip-only-check.mjs for
// the exact failure mode). Every check above and `npm run check` below both leave this undetected.
const stripOnlyFailures = checkStripOnlyLoadability();
if (stripOnlyFailures.length) {
  console.error(`Foundation gate failed: ${stripOnlyFailures.length} file(s) type-check but are not loadable under Node's strip-only stripper:`);
  for (const failure of stripOnlyFailures) console.error(`  ${failure.file}: ${failure.error}`);
  process.exit(1);
}

npm(["run", "check"]);
console.log("Foundation gate passed. Record this commit and lockfile hash in the handoff.");
