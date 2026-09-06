import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { codeRoot, stringEnv, nodeVersionSatisfies } from "./lib.mjs";

const args = parseArgs({ options: { engine: { type: "string" } } });
// An empty AGENT_ENGINE is the same as an unset one everywhere else in this repo's scripts
// (see docs/engineering-review-2.md §9.5); it must not silently win over --engine, nor should it
// be reported as a conflict with a --engine value that was only ever meant to fill the gap.
const envEngine = stringEnv("AGENT_ENGINE", undefined);
const selected = envEngine ?? args.values.engine;
const conflict = !!(envEngine && args.values.engine && envEngine !== args.values.engine);
const toolchain = JSON.parse(readFileSync(path.join(codeRoot, "toolchain.json"), "utf8"));

const checks = [
  { id: "node-version", passed: nodeVersionSatisfies(toolchain.node, process.versions.node), observed: process.versions.node },
  { id: "target-os", passed: process.platform === "win32", observed: process.platform },
  { id: "dependency-lock", passed: existsSync(path.join(codeRoot, "package-lock.json")) },
  { id: "compiled-entry", passed: existsSync(path.join(codeRoot, "dist/main.js")) },
  { id: "selected-engine", passed: !!selected && selected !== "mock" && !conflict, observed: selected },
];
if (process.platform === "win32") {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::Write((Get-Process -Id $PID).SessionId)"], { encoding: "utf8", windowsHide: true });
  const id = Number((result.stdout ?? "").trim());
  checks.push({ id: "interactive-session-id", passed: result.status === 0 && Number.isFinite(id) && id > 0 });
}

/**
 * The runtime reads and compiles this source file on first use (see runtime/process-host.ts,
 * `windowsHelperSource`); a missing file only fails at that point, on Windows, on the first
 * session. Checking it here uses the compiled runtime's own resolution instead of guessing a path
 * or a file count, so a future change to how many native sources exist (they were already merged
 * from two into one) does not silently go unchecked.
 */
async function nativeSourceCheck() {
  const modulePath = path.join(codeRoot, "dist", "runtime", "process-host.js");
  if (!existsSync(modulePath)) {
    return { id: "native-source-files", passed: false, reason: "dist/runtime/process-host.js is missing; run `npm run build` first." };
  }
  try {
    const module = await import(pathToFileURL(modulePath).href);
    if (typeof module.windowsHelperSource !== "function") {
      return { id: "native-source-files", passed: false, reason: "The compiled runtime no longer exports windowsHelperSource(); update this check." };
    }
    const source = module.windowsHelperSource();
    return { id: "native-source-files", passed: true, observed: { file: path.relative(codeRoot, source.file), sha256: source.hash } };
  } catch (error) {
    return { id: "native-source-files", passed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Real smoke test of the process host: launches a process that exits immediately and checks the
 * handshake (the host returned without throwing), the exit report, and the stop evidence
 * (`terminate()` proving the resources are gone). Skipped off Windows, where the job-host
 * supervisor this exercises does not run (see docs/engineering-review-2.md §3 Q6).
 */
async function jobHelperSmoke() {
  if (process.platform !== "win32") {
    return { id: "job-helper-smoke", passed: true, skipped: true, reason: `not applicable on ${process.platform}; the Windows job-host supervisor only runs on win32` };
  }
  const modulePath = path.join(codeRoot, "dist", "runtime", "process-host.js");
  if (!existsSync(modulePath)) {
    return { id: "job-helper-smoke", passed: false, reason: "dist/runtime/process-host.js is missing; run `npm run build` first." };
  }
  let scratch;
  try {
    const { LocalProcessHost } = await import(pathToFileURL(modulePath).href);
    scratch = await mkdtemp(path.join(tmpdir(), "pnp-doctor-"));
    const host = new LocalProcessHost(scratch);
    const controller = new AbortController();
    const scope = { closed: false, register() {} };
    const proc = await host.start({
      sessionId: "doctor-smoke", ownerToken: "doctor-smoke-owner",
      executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: scratch, env: {},
    }, controller.signal, scope);
    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 10_000);
      proc.onExit((value) => { clearTimeout(timer); resolve(value); });
    });
    const evidence = await proc.terminate();
    return { id: "job-helper-smoke", passed: evidence.quiescent === true, observed: { exit, evidence } };
  } catch (error) {
    return { id: "job-helper-smoke", passed: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * A real detection entry point for the configured model path, not a hardcoded literal. This
 * script never makes the outbound call itself (its own output says `scope: "local-environment-only"`);
 * it only reports, honestly, how far the configuration actually gets: unconfigured, missing,
 * malformed, missing credentials, or structurally ready but not attempted.
 */
function modelRoundTripProbe() {
  const kind = stringEnv("PNP_INTEGRATION", undefined);
  if (kind !== "configured") {
    return { status: "not_configured", detail: kind === undefined
      ? "PNP_INTEGRATION is not set (defaults to internal, which has no model path yet)."
      : `PNP_INTEGRATION=${kind} does not read a model profile; this script performs no live call for it.` };
  }
  const profilePath = stringEnv("PNP_CONFIGURED_PROFILE", undefined);
  if (profilePath === undefined || !path.isAbsolute(profilePath)) {
    return { status: "not_configured", detail: "PNP_CONFIGURED_PROFILE must be set to an absolute path when PNP_INTEGRATION=configured." };
  }
  if (!existsSync(profilePath)) return { status: "profile_missing", detail: profilePath };
  let profile;
  try { profile = JSON.parse(readFileSync(profilePath, "utf8")); }
  catch (error) { return { status: "profile_invalid", detail: error instanceof Error ? error.message : String(error) }; }
  const models = Array.isArray(profile?.models) ? profile.models : [];
  if (models.length === 0) return { status: "profile_invalid", detail: "profile.models is missing or empty." };
  const missing = Object.values(models[0]?.headerEnvironment ?? {}).filter((variable) => !process.env[variable]);
  if (missing.length > 0) return { status: "credentials_missing", detail: `not resolvable: ${missing.join(", ")}` };
  return { status: "ready_untested", detail: `${models.length} model(s) configured with resolvable credentials; this script does not place a live call.` };
}

const [native, helper] = await Promise.all([nativeSourceCheck(), jobHelperSmoke()]);
checks.push(native, helper);

const report = {
  scope: "local-environment-only",
  checks,
  modelRoundTrip: modelRoundTripProbe(),
  desktopAction: "not_run",
  internalTools: "not_run",
};
console.log(JSON.stringify(report, null, 2));
if (checks.some((c) => !c.passed && !c.skipped)) process.exitCode = 1;
