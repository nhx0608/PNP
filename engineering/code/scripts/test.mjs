import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const codeRoot = fileURLToPath(new URL("../", import.meta.url));
function walk(root) { return readdirSync(root, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(root, e.name)) : [join(root, e.name)]); }
const group = process.argv[2] ?? "unit";
const files = walk(join(codeRoot, "tests", group)).filter((p) => p.endsWith(".test.ts"));
if (!files.length) throw new Error(`No executable tests in ${group}; empty coverage is not a pass.`);
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...files], { cwd: codeRoot, stdio: "inherit", shell: false });
process.exit(result.status ?? 1);
