import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(codeRoot, "scripts", "source-stamp.mjs");

/**
 * The launcher shells out to this script and reads its stdout; a version that computes the right
 * answer and prints nothing is indistinguishable from one that cannot compute it at all.
 *
 * That was the actual defect. The CLI entry guard compared `import.meta.url` against
 * `file://${process.argv[1]}`, which on Windows is a backslash drive path and never matches, so the
 * script exited 0 with empty output on the only platform the package ships for. pnp-local.ps1 reads
 * an empty stamp as "dist/ cannot be verified", and the delivered bundle -- which ships a prebuilt
 * dist/ and no devDependencies -- refused to start with "the TypeScript compiler is not installed".
 *
 * So this test asserts on the process, not on computeSourceStamp(): importing the function would
 * have passed throughout, because the function was never broken.
 */
test("source-stamp.mjs prints a stamp when run as a command", () => {
  const plain = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout.trim(), /^[a-f0-9]{64}$/,
    `the launcher parses this as ^[a-f0-9]{64}$; got ${JSON.stringify(plain.stdout)}`);

  const json = spawnSync(process.execPath, [script, "--json"], { encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout) as { stamp: string; files: number };
  assert.equal(parsed.stamp, plain.stdout.trim());
  assert.ok(parsed.files > 0, "the stamp must cover at least one source file");
});
