#!/usr/bin/env node
// Orchestrates one end-to-end smoke run: mock model service, real gateway process,
// real engine, north-bound protocol client, artifact collection and teardown.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, openSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { codeRoot } from "../lib.mjs";

const { values } = parseArgs({
  options: {
    engine: { type: "string" },
    artifacts: { type: "string" },
    "timeout-ms": { type: "string" },
    "keep-temp": { type: "boolean" },
    // Local escape hatch only: the assessor starts on 6217 and so does this by default.
    "gateway-port": { type: "string" },
  },
});
const engine = values.engine ?? "mock";
if (!["mock", "opencode"].includes(engine)) throw new Error("--engine must be mock or opencode.");
// Defaults outside the repository: the tree has no ignore rule for an artifacts directory.
const artifacts = path.resolve(values.artifacts ?? path.join(os.tmpdir(), "pnp-e2e-artifacts", engine));
const totalTimeoutMs = Number(values["timeout-ms"] ?? 600_000);
const AUTH_VALUE = "Bearer e2e-not-a-secret";
const AUTH_VARIABLE = "PNP_E2E_MODEL_AUTHORIZATION";
const MODEL = { providerID: "e2e", modelID: "mock-1" };

const scriptsDir = path.join(codeRoot, "scripts", "e2e");
const distEntry = path.join(codeRoot, "dist", "main.js");
if (!existsSync(distEntry)) {
  process.stderr.write(`dist/main.js is missing at ${distEntry}. Run "npm run build" first.\n`);
  process.exit(2);
}

const log = (message) => process.stdout.write(`[ci-smoke:${engine}] ${message}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Nothing leaving this process may carry a live credential. */
const redact = (value) => value
  .split(AUTH_VALUE).join("[redacted]")
  .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");

/** True when nothing listens on the port on either loopback family. */
function portFree(port) {
  const attempt = (host) => new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (error) => resolve(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT"));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
  return attempt("127.0.0.1").then((v4) => v4 && attempt("::1"));
}
/** Polls /health/ready on every base until each answers 200 or the budget runs out. */
async function probeBind(bases, budgetMs, exited) {
  const startedAt = Date.now();
  const results = bases.map((base) => ({ base, status: null, elapsed_ms: null, last_error: null }));
  while (Date.now() - startedAt < budgetMs && results.some((result) => result.status !== 200)) {
    if (exited()) break;
    for (const result of results) {
      if (result.status === 200) continue;
      try {
        const response = await fetch(`${result.base}/health/ready`, { signal: AbortSignal.timeout(5_000) });
        result.status = response.status;
        if (response.status === 200) { result.elapsed_ms = Date.now() - startedAt; result.last_error = null; }
        else result.last_error = (await response.text()).slice(0, 200);
      } catch (error) {
        result.last_error = String(error?.cause?.code ?? error?.name ?? error);
      }
    }
    if (results.some((result) => result.status !== 200)) await sleep(500);
  }
  return results;
}
function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate) && candidate.endsWith(".js"));
}
/**
 * GitHub's windows-latest runner sets the npm global prefix away from the default,
 * so the OpenCode executable has to be resolved through `npm root -g`.
 */
function resolveOpenCodeExecutable() {
  const provided = process.env.PNP_OPENCODE_EXE_PATH;
  if (provided !== undefined && provided !== "") {
    return { path: provided, source: "PNP_OPENCODE_EXE_PATH", exists: existsSync(provided) };
  }
  const cli = npmCli();
  if (cli === undefined) return { path: null, source: "npm-root-unavailable", exists: false };
  const result = spawnSync(process.execPath, [cli, "root", "-g"], { encoding: "utf8", shell: false });
  if (result.status !== 0) return { path: null, source: "npm-root-failed", exists: false, error: (result.stderr ?? "").trim() };
  const root = result.stdout.trim().split(/\r?\n/).pop() ?? "";
  // opencode-ai's postinstall copies the platform binary to bin/opencode.exe on EVERY platform
  // (the name is fixed in the script); the platform package keeps the native name.
  const platform = { win32: "windows", linux: "linux", darwin: "darwin" }[process.platform] ?? process.platform;
  const native = process.platform === "win32" ? "opencode.exe" : "opencode";
  const candidates = [
    path.join(root, "opencode-ai", "bin", "opencode.exe"),
    path.join(root, `opencode-${platform}-${process.arch}`, "bin", native),
    path.join(root, `opencode-${platform}-${process.arch}-baseline`, "bin", native),
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  return { path: resolved ?? candidates[0], source: "npm root -g", exists: resolved !== undefined, npm_root: root, candidates };
}

const children = new Set();
function launch(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    ...(process.platform === "win32" ? {} : { detached: true }),
    shell: false,
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
function exited(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolve(true); });
  });
}
/** Windows has no process groups, so the tree is torn down with taskkill. */
async function stopTree(child, label) {
  if (child === undefined || child.pid === undefined) return { label, stopped: true, method: "not-started" };
  if (child.exitCode !== null || child.signalCode !== null) return { label, stopped: true, method: "already-exited" };
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: false });
    return { label, stopped: await exited(child, 10_000), method: "taskkill" };
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* Already gone. */ } }
  if (await exited(child, 8_000)) return { label, stopped: true, method: "SIGTERM" };
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* Already gone. */ } }
  return { label, stopped: await exited(child, 5_000), method: "SIGKILL" };
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pnp-e2e-"));
const dataDirectory = path.join(temporaryRoot, "data");
const workspace = path.join(temporaryRoot, "workspace");
const logs = path.join(temporaryRoot, "logs");
await mkdir(dataDirectory, { recursive: true });
await mkdir(workspace, { recursive: true });
await mkdir(logs, { recursive: true });
await mkdir(artifacts, { recursive: true });
log(`temp root ${temporaryRoot}`);

const modelRequestLog = path.join(logs, "model-requests.jsonl");
const gatewayStdout = path.join(logs, "gateway.stdout.log");
const gatewayStderr = path.join(logs, "gateway.stderr.log");
const runnerLog = path.join(logs, "e2e-runner.log");
const reportPath = path.join(logs, "e2e-report.json");
const profilePath = path.join(temporaryRoot, "configured-profile.json");
// Always present so the artifact set is the same shape whether or not the engine
// reached the model service (the mock engine never does).
await writeFile(modelRequestLog, "", "utf8");

const summary = {
  engine,
  platform: process.platform,
  node: process.version,
  started_at: new Date().toISOString(),
  temp_root: temporaryRoot,
  workspace,
  data_directory: dataDirectory,
};
let modelServer;
let gateway;
let exitCode = 1;
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  log(`total timeout of ${totalTimeoutMs}ms reached; forcing teardown`);
  void teardown();
}, totalTimeoutMs);

async function teardown() {
  const stops = [];
  stops.push(await stopTree(gateway, "gateway"));
  stops.push(await stopTree(modelServer, "mock-model-server"));
  summary.teardown = stops;
  return stops;
}

try {
  // ------------------------------------------------------------ mock model service
  modelServer = launch(process.execPath, [
    path.join(scriptsDir, "mock-model-server.mjs"),
    "--host", "127.0.0.1",
    "--port", "0",
    "--log", modelRequestLog,
    "--model-id", MODEL.modelID,
    "--stall-ms", "120000",
  ], { cwd: codeRoot, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let modelStderr = "";
  modelServer.stderr.on("data", (chunk) => { modelStderr += String(chunk); });
  const modelPort = await new Promise((resolve, reject) => {
    let buffer = "";
    const deadline = setTimeout(() => reject(new Error(`mock model server did not announce a port. stderr: ${modelStderr}`)), 20_000);
    modelServer.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      for (const line of buffer.split(/\r?\n/)) {
        if (line.trim() === "") continue;
        try {
          const value = JSON.parse(line);
          if (typeof value.port === "number") { clearTimeout(deadline); resolve(value.port); return; }
        } catch { /* Not the announcement line. */ }
      }
    });
    modelServer.once("exit", (code) => { clearTimeout(deadline); reject(new Error(`mock model server exited with ${code}: ${modelStderr}`)); });
  });
  summary.model_endpoint = `http://127.0.0.1:${modelPort}/v1`;
  log(`mock model service on ${summary.model_endpoint}`);

  // ------------------------------------------------------------ configured profile
  const profile = {
    models: [{
      selection: MODEL,
      endpoint: `http://127.0.0.1:${modelPort}/v1`,
      protocol: "openai-chat",
      // Only the variable NAME is stored; the gateway reads the value from the environment.
      headerEnvironment: { Authorization: AUTH_VARIABLE },
    }],
    tools: [],
    // The evaluator answers permissions it finds on GET /permission, so one operation has to actually
    // reach that endpoint. Only `write` is put on "ask": the driver authorises a permission request under
    // the tool name the engine announced the call with, and an "allow" policy would be decided inside the
    // gateway without ever publishing a pending request. The mock engine raises no permission at all, so
    // its leg keeps an empty operations map rather than waiting for something that never comes.
    policy: { default: "allow", operations: engine === "opencode" ? { write: "ask" } : {} },
  };
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

  // ------------------------------------------------------------ gateway process
  // Started exactly as INSTRUCTION.md tells the assessor to start it: AGENT_ENGINE in the
  // environment, `npm start -- --port 6217 --host localhost`. The competition's default port and
  // the documented command line are what this smoke exercises, not a private shortcut; only
  // --gateway-port exists for a developer whose 6217 is taken.
  const gatewayPort = Number(values["gateway-port"] ?? 6217);
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) throw new Error("--gateway-port must be a TCP port.");
  if (!await portFree(gatewayPort)) {
    throw new Error(`port ${gatewayPort} is already in use; the assessor starts the gateway on 6217, so free it or pass --gateway-port for a local run.`);
  }
  summary.gateway_base = `http://127.0.0.1:${gatewayPort}`;
  summary.gateway_hosts = [`http://127.0.0.1:${gatewayPort}`, `http://localhost:${gatewayPort}`];
  const environment = {
    ...process.env,
    PNP_DATA_DIR: dataDirectory,
    AGENT_ENGINE: engine,
    [AUTH_VARIABLE]: AUTH_VALUE,
  };
  // The bind address and port come from the documented command line, never from these.
  delete environment.PNP_HOST;
  delete environment.PNP_PORT;
  // Only the mock engine needs development mode (it is development-only by design). The real
  // engine runs in the same posture as a deployment: no development flag, configured profile.
  delete environment.PNP_MODE;
  if (engine === "mock") {
    environment.PNP_MODE = "development";
    environment.PNP_INTEGRATION = "mock";
    delete environment.PNP_CONFIGURED_PROFILE;
    delete environment.PNP_OPENCODE_NATIVE_PERMISSIONS;
  } else {
    environment.PNP_INTEGRATION = "configured";
    environment.PNP_CONFIGURED_PROFILE = profilePath;
    // OpenCode allows every operation unless its private config asks; without this the engine never
    // raises ACP session/request_permission and the approval loop below would have nothing to drive.
    environment.PNP_OPENCODE_NATIVE_PERMISSIONS = "ask";
    const executable = resolveOpenCodeExecutable();
    summary.opencode_executable = executable;
    log(`opencode executable: ${executable.path ?? "unresolved"} (${executable.source}, exists=${executable.exists})`);
    if (executable.path !== null) environment.PNP_OPENCODE_EXE_PATH = executable.path;
  }
  summary.engine_environment = Object.fromEntries(
    ["AGENT_ENGINE", "PNP_MODE", "PNP_INTEGRATION", "PNP_CONFIGURED_PROFILE", "PNP_OPENCODE_EXE_PATH",
      "PNP_OPENCODE_NATIVE_PERMISSIONS", "PNP_DATA_DIR"]
      .filter((key) => environment[key] !== undefined).map((key) => [key, environment[key]]),
  );

  const cli = npmCli();
  if (cli === undefined) throw new Error("npm-cli.js was not found next to the Node runtime; the documented start command is `npm start`.");
  const startArguments = ["start", "--", "--port", String(gatewayPort), "--host", "localhost"];
  summary.startup_command = `npm ${startArguments.join(" ")}`;
  gateway = launch(process.execPath, [cli, ...startArguments], {
    cwd: codeRoot,
    stdio: ["ignore", openSync(gatewayStdout, "a"), openSync(gatewayStderr, "a")],
    env: environment,
  });
  let gatewayExit = null;
  gateway.once("exit", (code, signal) => { gatewayExit = { code, signal }; });
  log(`gateway via \`${summary.startup_command}\` (npm pid ${gateway.pid}), AGENT_ENGINE=${engine}`);

  // `--host localhost` must serve both address families the assessor's client may resolve to:
  // Windows resolves localhost to ::1 first, a client may still dial 127.0.0.1. Both are probed
  // before the protocol client runs, and a gateway that answers on only one fails here.
  const readyBudgetMs = engine === "opencode" ? 120_000 : 60_000;
  summary.bind_probe = await probeBind(summary.gateway_hosts, readyBudgetMs, () => gatewayExit !== null);
  for (const probe of summary.bind_probe) {
    if (probe.status !== 200) throw new Error(`gateway did not answer /health/ready on ${probe.base}: ${JSON.stringify(probe)}`);
  }
  log(`ready on ${summary.bind_probe.map((probe) => `${probe.base} (${probe.elapsed_ms}ms)`).join(" and ")}`);

  // ------------------------------------------------------------ protocol client
  const runnerArgs = [
    path.join(scriptsDir, "run-e2e.mjs"),
    "--base", summary.gateway_base,
    "--workspace", workspace,
    "--report", reportPath,
    "--model-provider", MODEL.providerID,
    "--model-id", MODEL.modelID,
    // A prompt without `model` must run on the provider's default; this is contract, not a nicety.
    "--require-default-model",
  ];
  if (engine === "opencode") {
    runnerArgs.push("--expect-tools", "--marker", "E2E_HELLO_OK", "--abort-attempts", "1",
      // The Windows binary is ~172 MB and the first launch is slow.
      "--prompt-timeout-ms", "300000", "--ready-timeout-ms", "120000");
  } else {
    runnerArgs.push("--marker", "E2E_HELLO", "--abort-attempts", "8",
      "--abort-busy-timeout-ms", "150", "--prompt-timeout-ms", "60000");
  }
  const runner = launch(process.execPath, runnerArgs, { cwd: codeRoot, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let runnerOutput = "";
  runner.stdout.on("data", (chunk) => { runnerOutput += String(chunk); process.stdout.write(chunk); });
  runner.stderr.on("data", (chunk) => { runnerOutput += String(chunk); process.stderr.write(chunk); });
  // A gateway that refuses to start (a missing engine implementation, a bad profile) must
  // fail the job in seconds rather than after the client's readiness budget expires.
  gateway.once("exit", () => {
    if (runner.exitCode === null && runner.signalCode === null) {
      log("gateway exited before the client finished; stopping the client");
      void stopTree(runner, "run-e2e");
    }
  });
  const runnerExit = await new Promise((resolve) => runner.once("exit", (code, signal) => resolve({ code, signal })));
  await writeFile(runnerLog, redact(runnerOutput), "utf8");
  summary.runner_exit = runnerExit;
  summary.gateway_exit_during_run = gatewayExit;

  // ------------------------------------------------------------ diagnostics before teardown
  try {
    const response = await fetch(`${summary.gateway_base}/diagnostics`, { signal: AbortSignal.timeout(10_000) });
    const body = await response.text();
    await writeFile(path.join(logs, "diagnostics.json"), redact(body), "utf8");
    summary.diagnostics_status = response.status;
  } catch (error) {
    summary.diagnostics_error = String(error);
  }
  exitCode = runnerExit.code === 0 ? 0 : 1;
} catch (error) {
  summary.orchestrator_error = redact(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.stderr.write(`${summary.orchestrator_error}\n`);
  exitCode = 1;
} finally {
  clearTimeout(timer);
  await teardown();
  await sleep(200);

  // ------------------------------------------------------------ artifacts
  for (const name of ["gateway.stdout.log", "gateway.stderr.log", "model-requests.jsonl", "e2e-report.json", "e2e-runner.log", "diagnostics.json"]) {
    const source = path.join(logs, name);
    if (!existsSync(source)) continue;
    await writeFile(path.join(artifacts, name), redact(await readFile(source, "utf8")), "utf8");
  }
  if (existsSync(profilePath)) await copyFile(profilePath, path.join(artifacts, "configured-profile.json"));
  const hostsSource = path.join(dataDirectory, "hosts");
  if (existsSync(hostsSource)) {
    const hostsTarget = path.join(artifacts, "hosts");
    await mkdir(hostsTarget, { recursive: true });
    for (const entry of await readdir(hostsSource)) {
      if (!entry.endsWith(".json")) continue;
      await writeFile(path.join(hostsTarget, entry), redact(await readFile(path.join(hostsSource, entry), "utf8")), "utf8");
    }
    summary.host_records = (await readdir(hostsTarget)).length;
  } else {
    summary.host_records = 0;
  }
  const workspaceListing = existsSync(workspace) ? await readdir(workspace) : [];
  summary.workspace_entries = workspaceListing;
  if (existsSync(reportPath)) {
    try { summary.report_totals = JSON.parse(await readFile(reportPath, "utf8")).totals; }
    catch { summary.report_totals = null; }
  }
  if (existsSync(gatewayStderr)) {
    const stderrText = redact(await readFile(gatewayStderr, "utf8")).trim();
    if (stderrText !== "") summary.gateway_stderr_tail = stderrText.split(/\r?\n/).slice(-12);
  }
  summary.timed_out = timedOut;
  summary.finished_at = new Date().toISOString();
  summary.exit_code = timedOut ? 1 : exitCode;
  await writeFile(path.join(artifacts, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  log(`artifacts in ${artifacts}`);
  log(`result ${summary.exit_code === 0 ? "PASS" : "FAIL"}${timedOut ? " (timed out)" : ""}`);
  // A failed run keeps its working tree so the raw state can be inspected next to the artifacts.
  if (values["keep-temp"] === true || summary.exit_code !== 0) log(`temp root kept for inspection: ${temporaryRoot}`);
  else await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  process.exit(summary.exit_code);
}
