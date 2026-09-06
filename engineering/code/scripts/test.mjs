import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const codeRoot = fileURLToPath(new URL("../", import.meta.url));
function walk(root) { return readdirSync(root, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(root, e.name)) : [join(root, e.name)]); }
// A group may cover several directories so a new suite is reached by the existing entry points instead of
// depending on someone remembering an extra command. Adapter suites are unit-level: no binaries, no network.
const GROUP_DIRECTORIES = { unit: ["unit", "adapters"] };
const groups = process.argv.length > 2 ? process.argv.slice(2) : ["unit"];
const directories = groups.flatMap((group) => GROUP_DIRECTORIES[group] ?? [group]);
const files = directories.flatMap((directory) => walk(join(codeRoot, "tests", directory))).filter((p) => p.endsWith(".test.ts"));
if (!files.length) throw new Error(`No executable tests in ${groups.join(", ")}; empty coverage is not a pass.`);
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...files], { cwd: codeRoot, stdio: "inherit", shell: false });
process.exit(result.status ?? 1);
