import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
const failures = [];
const config = JSON.parse(readFileSync("config/release-profile.json", "utf8"));
const toolchain = JSON.parse(readFileSync("toolchain.json", "utf8"));
if (process.platform !== "win32") failures.push("Windows evidence must be verified in the target environment.");
if (process.versions.node !== toolchain.node) failures.push("Node version does not match toolchain.json.");
if (!existsSync("package-lock.json")) failures.push("Missing package-lock.json.");
const lock = existsSync("engines.lock.json") ? JSON.parse(readFileSync("engines.lock.json", "utf8")) : { engines: [] };
if (!lock.engines?.length) failures.push("Missing exact engine version lock.");
const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", shell: false });
const commit = git.status === 0 ? git.stdout.trim() : "";
if (!commit) failures.push("Repository commit is unavailable.");
if (config.engines.length < 2 || new Set(config.engines).size !== config.engines.length) failures.push("At least two distinct engines are required.");
for (const engine of config.engines) {
  if (!/^[a-z0-9-]+$/.test(engine) || engine === "mock") { failures.push("Invalid formal engine."); continue; }
  const source = readFileSync(`src/engines/${engine}/pack.ts`, "utf8");
  if (/implementationProvided:\s*false/.test(source)) failures.push(`${engine}: implementation absent.`);
  const entry = lock.engines?.find((e) => e.engineId === engine);
  if (!entry || !entry.version || /REQUIRED|latest|\*/i.test(entry.version) || !/^[a-f0-9]{64}$/i.test(entry.sha256 ?? "")) failures.push(`${engine}: exact installer lock is incomplete.`);
  const file = `../verification/internal/${engine}.json`;
  if (!existsSync(file)) { failures.push(`${engine}: internal acceptance evidence absent.`); continue; }
  const evidence = JSON.parse(readFileSync(file, "utf8"));
  const required = ["model-roundtrip", "tool-permission", "gateway-contract", "session-resume", "cancel-owned-tree", "windows-native", "task-artifacts"];
  if (evidence.kind !== "internal-acceptance" || evidence.gitCommit !== commit || evidence.platform !== "win32"
    || evidence.engineId !== engine || evidence.engineVersion !== entry?.version || evidence.channelId !== entry?.channelId
    || evidence.nodeVersion !== `v${toolchain.node}`) failures.push(`${engine}: evidence provenance mismatch.`);
  for (const id of required) if (!evidence.checks?.some((c) => c.id === id && c.status === "passed" && c.evidence?.length)) failures.push(`${engine}: ${id} lacks passing evidence.`);
}
if (failures.length) { console.error(JSON.stringify({ releasable: false, failures }, null, 2)); process.exitCode = 1; }
else console.log(JSON.stringify({ releasable: true, engines: config.engines, commit }));
