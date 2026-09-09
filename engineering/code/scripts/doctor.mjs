import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { codeRoot, nodeVersionSatisfies } from "./lib.mjs";
import { loadLocalEnvironment } from "../src/config/local-env.ts";
import { loadPnpSettings } from "../src/config/settings.ts";
import { loadIntegration, probeIntegration } from "../src/integration/index.ts";
import { loadEngine, selectEngine } from "../src/registry/index.ts";
import { errorStatus, safeDiagnostic, summarizeMcp } from "./doctor-config.mjs";

const args = parseArgs({ options: { engine: { type: "string" } } });
const environment = { ...process.env };
let localEnvironment;
try {
  localEnvironment = await loadLocalEnvironment({ environment });
} catch (error) {
  localEnvironment = { file: "runtime/local.env", present: true, names: [], error };
}
// Use the gateway's exact selection rules; an integration kind is never an engine identifier.
let selected;
let engineSelectionError;
try {
  selected = selectEngine(args.values.engine, environment.AGENT_ENGINE);
} catch (error) {
  engineSelectionError = error;
}
const conflict = engineSelectionError?.code === "ENGINE_CONFIGURATION_CONFLICT";
const validEngine = selected !== undefined && selected !== "mock" && engineSelectionError === undefined;
const toolchain = JSON.parse(readFileSync(path.join(codeRoot, "toolchain.json"), "utf8"));

const checks = [
  { id: "node-version", passed: nodeVersionSatisfies(toolchain.node, process.versions.node), observed: process.versions.node },
  { id: "target-os", passed: process.platform === "win32", observed: process.platform },
  { id: "dependency-lock", passed: existsSync(path.join(codeRoot, "package-lock.json")) },
  { id: "compiled-entry", passed: existsSync(path.join(codeRoot, "dist/main.js")) },
  { id: "selected-engine", passed: validEngine && !conflict, observed: selected,
    ...(engineSelectionError === undefined ? {} : { reason: safeDiagnostic(engineSelectionError) }) },
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

/** Loads and probes the same configured integration as main.ts. `probeIntegration` only validates
 * local configuration and reachability rules; it deliberately does not make a model request. */
async function modelRoundTripProbe() {
  if (localEnvironment.error !== undefined) return { status: "local_env_invalid", detail: safeDiagnostic(localEnvironment.error) };
  if (!validEngine) return { status: "engine_unselected", detail: safeDiagnostic(engineSelectionError ?? { code: "ENGINE_NOT_FOUND", message: "No valid engine selected." }), liveRequest: "not_attempted" };
  let engine;
  try { engine = await loadEngine(selected, environment.PNP_MODE === "development"); }
  catch (error) { return { status: "engine_unavailable", detail: safeDiagnostic(error), liveRequest: "not_attempted" }; }
  const kind = environment.PNP_INTEGRATION;
  let provider;
  try {
    provider = await loadIntegration({ kind, development: environment.PNP_MODE === "development", engineDevelopmentOnly: engine.descriptor.developmentOnly,
      engineId: selected, configuredProfile: environment.PNP_CONFIGURED_PROFILE, settingsPath: environment.PNP_SETTINGS,
      modelSettings: environment.PNP_MODEL_SETTINGS, environment });
  } catch (error) {
    return { status: errorStatus(error), detail: safeDiagnostic(error), liveRequest: "not_attempted" };
  }
  try {
    await probeIntegration(provider);
    let mcp;
    try {
      const legacyOnly = Boolean(environment.PNP_CONFIGURED_PROFILE?.trim()) && !environment.PNP_SETTINGS?.trim();
      if (legacyOnly) mcp = [];
      else {
        const settings = await loadPnpSettings({ engineId: selected, settingsPath: environment.PNP_SETTINGS, environment });
        mcp = summarizeMcp(settings, environment);
      }
    } catch (error) {
      return { status: "configuration_invalid", detail: safeDiagnostic(error), liveRequest: "not_attempted" };
    }
    const failedMcp = mcp.some((entry) => entry.status === "missing_file" || entry.status === "missing_variables");
    return { status: failedMcp ? "mcp_not_ready" : "ready_untested", liveRequest: "not_attempted", mcp,
      mcpScope: Boolean(environment.PNP_CONFIGURED_PROFILE?.trim()) && !environment.PNP_SETTINGS?.trim()
        ? "legacy-profile-not-inspected" : "effective-settings" };
  } catch (error) {
    return { status: errorStatus(error), detail: safeDiagnostic(error), liveRequest: "not_attempted" };
  }
}

const [native, helper] = await Promise.all([nativeSourceCheck(), jobHelperSmoke()]);
checks.push(native, helper);

const modelRoundTrip = await modelRoundTripProbe();
const report = {
  scope: "local-environment-only",
  checks,
  localEnvironment: localEnvironment.error === undefined
    ? { present: localEnvironment.present, names: localEnvironment.names }
    : { present: true, status: "invalid", detail: safeDiagnostic(localEnvironment.error) },
  modelRoundTrip,
  desktopAction: "not_run",
  internalTools: "not_run",
};
console.log(JSON.stringify(report, null, 2));
if (checks.some((c) => !c.passed && !c.skipped)
  || localEnvironment.error !== undefined
  || ["ready_untested", "not_configured"].includes(modelRoundTrip.status) === false) process.exitCode = 1;
