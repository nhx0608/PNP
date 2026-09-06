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
// A test that never settles must fail by name, not hold the job until the runner's six-hour limit:
// a Windows-only hang in CI was invisible for exactly that reason. Two minutes is well above the
// slowest legitimate test (process-host launches on a loaded Windows runner take seconds, not minutes).
const perTestTimeoutMs = Number(process.env.PNP_TEST_TIMEOUT_MS ?? 120_000);
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", `--test-timeout=${perTestTimeoutMs}`, ...files],
  { cwd: codeRoot, stdio: "inherit", shell: false });
process.exit(result.status ?? 1);
