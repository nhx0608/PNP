import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { codeRoot, engineeringRoot, nodeVersionSatisfies } from "./lib.mjs";

const failures = [];
const config = JSON.parse(readFileSync(path.join(codeRoot, "config/release-profile.json"), "utf8"));
const toolchain = JSON.parse(readFileSync(path.join(codeRoot, "toolchain.json"), "utf8"));

if (process.platform !== "win32") failures.push("Windows evidence must be verified in the target environment.");
// Environment gate: a range, same as `npm run doctor`/`foundation:check` (docs/engineering-review.md R10).
if (!nodeVersionSatisfies(toolchain.node, process.versions.node)) failures.push("Node version does not satisfy toolchain.json's minimum.");
if (!existsSync(path.join(codeRoot, "package-lock.json"))) failures.push("Missing package-lock.json.");

const lockPath = path.join(codeRoot, "engines.lock.json");
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : { engines: [] };
if (!lock.engines?.length) failures.push("Missing exact engine version lock.");

const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: engineeringRoot, encoding: "utf8", shell: false });
const commit = git.status === 0 ? git.stdout.trim() : "";
if (!commit) failures.push("Repository commit is unavailable.");

const required = config.requiredEngines ?? [];
const optional = config.optionalEngines ?? [];
if (required.length < (config.minimumDistinctEngines ?? 2) || new Set(required).size !== required.length) {
  failures.push(`At least ${config.minimumDistinctEngines ?? 2} distinct required engines are needed.`);
}

const REQUIRED_EVIDENCE_CHECKS = ["model-roundtrip", "tool-permission", "gateway-contract", "session-resume", "cancel-owned-tree", "windows-native", "task-artifacts"];

/**
 * Every structural and evidence check for one engine, returned as a list of problems (empty means
 * clean) plus whether internal acceptance evidence was submitted at all. Shared between the
 * blocking (required) and non-blocking (optional) engine lists so the two paths cannot drift.
 */
function evaluateEngine(engine) {
  const problems = [];
  if (!/^[a-z0-9-]+$/.test(engine) || engine === "mock") return { problems: [`${engine}: invalid formal engine identifier.`], evidenceSubmitted: false, passed: false };
  let source;
  try { source = readFileSync(path.join(codeRoot, "src", "engines", engine, "pack.ts"), "utf8"); }
  catch { problems.push(`${engine}: engine pack source is missing.`); }
  if (source !== undefined && /implementationProvided:\s*false/.test(source)) problems.push(`${engine}: implementation absent.`);
  const entry = lock.engines?.find((e) => e.engineId === engine);
  if (!entry || !entry.version || /REQUIRED|latest|\*/i.test(entry.version) || !/^[a-f0-9]{64}$/i.test(entry.sha256 ?? "")) {
    problems.push(`${engine}: exact installer lock is incomplete.`);
  }
  const file = path.join(engineeringRoot, "verification", "internal", `${engine}.json`);
  if (!existsSync(file)) return { problems, evidenceSubmitted: false, passed: problems.length === 0 };
  let evidence;
  try { evidence = JSON.parse(readFileSync(file, "utf8")); }
  catch { return { problems: [...problems, `${engine}: internal acceptance evidence is not valid JSON.`], evidenceSubmitted: true, passed: false }; }
  // Provenance comparison stays exact equality on purpose: it is cross-checking where the
  // evidence came from (this commit, this exact engine build, this exact Node build), not
  // gating the environment the way the Node-version check above does.
  if (evidence.kind !== "internal-acceptance" || evidence.gitCommit !== commit || evidence.platform !== "win32"
    || evidence.engineId !== engine || evidence.engineVersion !== entry?.version || evidence.channelId !== entry?.channelId
    || evidence.nodeVersion !== `v${toolchain.node}`) problems.push(`${engine}: evidence provenance mismatch.`);
  for (const id of REQUIRED_EVIDENCE_CHECKS) {
    if (!evidence.checks?.some((c) => c.id === id && c.status === "passed" && c.evidence?.length)) problems.push(`${engine}: ${id} lacks passing evidence.`);
  }
  return { problems, evidenceSubmitted: true, passed: problems.length === 0 };
}

for (const engine of required) {
  const result = evaluateEngine(engine);
  failures.push(...result.problems);
}

// Optional engines (the competition asks for two-plus harnesses; a third, e.g. an early Windows
// beta, is a bonus, not a gate — see docs/engineering-review.md §0 and AGENTS.md). Missing
// evidence is reported, never a failure; submitted evidence is validated the same way a required
// engine's is, and its own problems stay out of `failures` too.
const optionalReport = optional.map((engine) => {
  const result = evaluateEngine(engine);
  if (!result.evidenceSubmitted) {
    return { engine, status: "no-evidence", note: "Optional engine; missing evidence does not block release.",
      ...(result.problems.length ? { problems: result.problems } : {}) };
  }
  return { engine, status: result.passed ? "bonus-passed" : "evidence-invalid", problems: result.problems };
});

if (failures.length) {
  console.error(JSON.stringify({ releasable: false, failures, optionalEngines: optionalReport }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ releasable: true, requiredEngines: required, optionalEngines: optionalReport, commit }, null, 2));
}
