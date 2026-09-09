#!/usr/bin/env node
// One end-to-end pass over the documented gateway API against the REAL model service this machine
// configures (INSTRUCTION.md 1.3). Nothing here stands in for that service: no mock model server is
// started, no model variable is invented, and the gateway is launched exactly the way the manual
// tells an assessor to launch it -- the shipped launcher, `--engine <id> --port <port>`, with this
// process's own environment. `runtime/local.env` is left to the gateway, which loads it itself.
//
// Every assertion below is made through the north-bound HTTP surface only, so a passing run is
// evidence about the delivered product rather than about this script's own internals. The offline
// counterpart is scripts/e2e/ci-smoke.mjs, which mocks the model and needs no configuration at all.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, openSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { codeRoot } from "../lib.mjs";

const { values } = parseArgs({
  options: {
    engine: { type: "string" },
    port: { type: "string" },
    directory: { type: "string" },
    artifacts: { type: "string" },
    keep: { type: "boolean" },
    "prompt-timeout-ms": { type: "string" },
    "ready-timeout-ms": { type: "string" },
    help: { type: "boolean" },
  },
});

const USAGE = `Usage: node scripts/e2e/live-check.mjs --engine <opencode|pi> [options]

  --engine <id>            Required. The engine to start the gateway with.
  --port <n>               Gateway port (default 6217, the port the manual documents).
  --directory <path>       Absolute working directory for the session. Default: a fresh
                           temporary workspace, removed again on success.
  --artifacts <dir>        Where evidence is written. Default: <tmp>/pnp-live-artifacts/<engine>.
  --keep                   Keep the temporary workspace even when every check passes.
  --prompt-timeout-ms <n>  Budget for one prompt_async round trip (default 600000).
  --ready-timeout-ms <n>   Budget for /health/ready after start (default 180000).

The model service is the one this environment already configures: PNP_MODEL_ENDPOINT and
PNP_MODEL_ID (plus the optional PNP_MODEL_API_KEY / PNP_MODEL_HEADERS / PNP_MODEL_CA_FILE), either
exported into this console or written into code\\runtime\\local.env. See INSTRUCTION.md 1.3.
`;
if (values.help === true) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const SUPPORTED_ENGINES = ["opencode", "pi"];
const engine = values.engine ?? "";
const log = (message) => process.stdout.write(`[live-check] ${message}\n`);
const fail = (message) => { process.stderr.write(`[live-check] ${message}\n`); };

if (!SUPPORTED_ENGINES.includes(engine)) {
  fail(`--engine must be one of ${SUPPORTED_ENGINES.join(", ")}; a live check runs a real engine against a real model.`);
  process.stderr.write(`\n${USAGE}`);
  process.exit(2);
}

const port = Number(values.port ?? 6217);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  fail("--port must be a TCP port between 1 and 65535.");
  process.exit(2);
}
const promptTimeoutMs = Number(values["prompt-timeout-ms"] ?? 600_000);
if (!Number.isInteger(promptTimeoutMs) || promptTimeoutMs < 1_000) {
  fail("--prompt-timeout-ms must be an integer of at least 1000.");
  process.exit(2);
}
const readyTimeoutMs = Number(values["ready-timeout-ms"] ?? 180_000);
if (!Number.isInteger(readyTimeoutMs) || readyTimeoutMs < 1_000) {
  fail("--ready-timeout-ms must be an integer of at least 1000.");
  process.exit(2);
}
// The gateway's own cancel grace decides how long a stop may legitimately take; the extra half
// minute covers the HTTP round trip and the engine's own teardown.
const cancelGraceMs = (() => {
  const raw = process.env.PNP_CANCEL_GRACE_MS;
  const parsed = raw === undefined || raw.trim() === "" ? 15_000 : Number(raw);
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 300_000 ? parsed : 15_000;
})();
const abortSettleBudgetMs = cancelGraceMs + 30_000;

const distEntry = path.join(codeRoot, "dist", "main.js");
if (!existsSync(distEntry)) {
  fail(`dist/main.js is missing at ${distEntry}. Run "npm run build" first, or start this through pnp.cmd livecheck.`);
  process.exit(2);
}

// ---------------------------------------------------------------- model configuration gate
/**
 * Names defined by `runtime/local.env` (or whatever PNP_LOCAL_ENV_FILE points at) with a non-empty
 * value, parsed the way src/config/local-env.ts parses it. Only NAMES are ever returned: this file
 * holds credentials and nothing may read a value out of it here.
 */
async function localEnvironmentNames(file) {
  let text;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return { present: false, names: [] };
    return { present: true, unreadable: String(error?.code ?? error), names: [] };
  }
  const names = [];
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (line.slice(separator + 1).trim() === "") continue;
    names.push(name);
  }
  return { present: true, names };
}
const localEnvFile = (() => {
  const explicit = process.env.PNP_LOCAL_ENV_FILE;
  if (explicit === undefined || explicit.trim() === "") return path.join(codeRoot, "runtime", "local.env");
  return path.isAbsolute(explicit.trim()) ? explicit.trim() : path.resolve(codeRoot, explicit.trim());
})();
const localEnv = await localEnvironmentNames(localEnvFile);
const REQUIRED_MODEL_VARIABLES = ["PNP_MODEL_ENDPOINT", "PNP_MODEL_ID"];
const defined = (name) => (process.env[name] ?? "").trim() !== "" || localEnv.names.includes(name);
const missing = REQUIRED_MODEL_VARIABLES.filter((name) => !defined(name));
if (missing.length > 0) {
  fail(`this check talks to a real model service, and ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not configured.`);
  fail(`Neither this console nor ${localEnvFile}${localEnv.present ? "" : " (which does not exist)"} defines ${missing.length === 1 ? "it" : "them"}.`);
  fail("Run `.\\pnp.cmd config` (PowerShell) or `pnp.cmd config` (cmd) to write that file, or set them for this console:");
  fail("  set PNP_MODEL_ENDPOINT=<OpenAI-compatible base URL ending in /v1>");
  fail("  set PNP_MODEL_ID=<the model name that endpoint knows>");
  fail(`The same two lines written into ${localEnvFile} work just as well; the gateway loads that file itself.`);
  fail("PNP_MODEL_API_KEY, PNP_MODEL_HEADERS and PNP_MODEL_CA_FILE are optional; see INSTRUCTION.md 1.3.");
  fail("A check that needs no model at all is `pnp.cmd selfcheck --engine <id>`, which uses the offline mock model service.");
  process.exit(2);
}
// A live check whose integration is the mock one would prove nothing about the real service, and a
// silent pass is worse than no check at all.
const integration = (process.env.PNP_INTEGRATION ?? "").trim();
if (integration.toLowerCase() === "mock") {
  fail("PNP_INTEGRATION=mock is exported in this console, so the gateway would answer from the built-in stand-in instead of the configured model service.");
  fail("Clear PNP_INTEGRATION for a live check, or run `pnp.cmd selfcheck` if the offline check is what is wanted.");
  process.exit(2);
}

// ---------------------------------------------------------------- redaction
// Nothing this process writes or prints may carry a credential. The variable VALUES are masked by
// content, and the two credential shapes an OpenAI-compatible endpoint uses are masked by pattern.
const secretValues = ["PNP_MODEL_API_KEY", "PNP_MODEL_AUTHORIZATION", "PNP_MODEL_HEADERS"]
  .map((name) => process.env[name] ?? "")
  .filter((value) => value.trim().length >= 8);
function redact(value) {
  let out = String(value);
  for (const secret of secretValues) out = out.split(secret).join("[redacted]");
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, "[redacted]");
}

// ---------------------------------------------------------------- process helpers
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** True when nothing listens on the port on either loopback family. */
function portFree(target) {
  const attempt = (host) => new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (error) => resolve(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT"));
    probe.listen(target, host, () => probe.close(() => resolve(true)));
  });
  return attempt("127.0.0.1").then((v4) => v4 && attempt("::1"));
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
/** Windows has no process groups, so the launcher's tree is torn down with taskkill. */
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

// ---------------------------------------------------------------- workspace and artifacts
const artifacts = path.resolve(values.artifacts ?? path.join(os.tmpdir(), "pnp-live-artifacts", engine));
await mkdir(artifacts, { recursive: true });
const providedDirectory = values.directory;
if (providedDirectory !== undefined && !path.isAbsolute(providedDirectory)) {
  fail("--directory must be an absolute path; the gateway rejects a relative working directory with VALIDATION_ERROR.");
  process.exit(2);
}
const temporaryWorkspace = providedDirectory === undefined
  ? await mkdtemp(path.join(os.tmpdir(), "pnp-live-"))
  : undefined;
const workspace = providedDirectory ?? temporaryWorkspace;
await mkdir(workspace, { recursive: true });

const eventsPath = path.join(artifacts, "events.jsonl");
const gatewayStdout = path.join(artifacts, "gateway.stdout.log");
const gatewayStderr = path.join(artifacts, "gateway.stderr.log");
await writeFile(eventsPath, "", "utf8");
await writeFile(gatewayStdout, "", "utf8");
await writeFile(gatewayStderr, "", "utf8");

const marker = `LIVE_CHECK_${Math.random().toString(16).slice(2, 10).toUpperCase()}`;
const helloTarget = path.join(workspace, "live-hello.txt");
const countTarget = path.join(workspace, "live-count.txt");

const summary = {
  engine,
  platform: process.platform,
  node: process.version,
  started_at: new Date().toISOString(),
  gateway_port: port,
  workspace,
  workspace_is_temporary: temporaryWorkspace !== undefined,
  artifacts,
  marker,
  prompt_timeout_ms: promptTimeoutMs,
  ready_timeout_ms: readyTimeoutMs,
  cancel_grace_ms: cancelGraceMs,
  abort_settle_budget_ms: abortSettleBudgetMs,
  // Names only, never values: this is the evidence that the run used the deployment's own model
  // configuration rather than something this script supplied.
  model_variables_from_environment: ["PNP_MODEL_ENDPOINT", "PNP_MODEL_ID", "PNP_MODEL_API_KEY",
    "PNP_MODEL_HEADERS", "PNP_MODEL_CA_FILE", "PNP_ALLOW_HTTP_ENDPOINTS", "PNP_MODEL_TLS_INSECURE"]
    .filter((name) => (process.env[name] ?? "").trim() !== ""),
  local_env_file: { path: localEnvFile, present: localEnv.present, names: localEnv.names },
  checks: [],
};

// ---------------------------------------------------------------- check runner
// The full list, in order, so a run that stops early still accounts for every check by name
// instead of quietly reporting a smaller total than it set out to make.
const PLANNED_CHECKS = ["health-ready", "event-stream-open", "session/create", "task1/write-file",
  "task2/history", "task3/abort", "question-and-permission", "session/delete"];
const checks = [];
function record(name, status, evidence, startedAt) {
  const entry = { name, status, duration_ms: Date.now() - startedAt, evidence };
  checks.push(entry);
  process.stdout.write(`[${{ pass: "PASS", fail: "FAIL", skip: "SKIP" }[status]}] ${name} (${entry.duration_ms}ms)\n`);
  // A failure must always carry what it saw -- the HTTP status and body, or the assertion's own
  // evidence -- so a report never has to say only that something "failed".
  if (status !== "pass") process.stdout.write(`       ${redact(JSON.stringify(evidence))}\n`);
  return entry;
}
async function check(name, fn) {
  const startedAt = Date.now();
  const evidence = {};
  try {
    const outcome = await fn(evidence);
    return record(name, outcome === "skip" ? "skip" : "pass", evidence, startedAt);
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    return record(name, "fail", evidence, startedAt);
  }
}
function assert(condition, message, detail) {
  if (!condition) {
    const error = new Error(detail === undefined ? message : `${message} :: ${redact(JSON.stringify(detail)).slice(0, 900)}`);
    throw error;
  }
}

// ---------------------------------------------------------------- HTTP client
let base = `http://127.0.0.1:${port}`;
async function call(method, route, { body, timeoutMs = 30_000 } = {}) {
  try {
    const response = await fetch(`${base}${route}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json;
    if (text !== "") { try { json = JSON.parse(text); } catch { json = undefined; } }
    return { status: response.status, json, text: text.slice(0, 2_000) };
  } catch (error) {
    return { status: null, json: undefined, text: "", error: String(error?.cause?.code ?? error) };
  }
}
/** Everything a failure report needs about one response, and nothing that could carry a secret. */
const responseEvidence = (response) => ({
  status: response.status,
  body: response.json ?? redact(response.text).slice(0, 600),
  ...(response.error === undefined ? {} : { transport_error: response.error }),
});

// ---------------------------------------------------------------- SSE collector
const events = [];
let eventStreamError = null;
let eventWrites = Promise.resolve();
const eventsController = new AbortController();
function notice(event) {
  events.push(event);
  eventWrites = eventWrites
    .then(() => appendFile(eventsPath, `${redact(JSON.stringify({ received_at: new Date().toISOString(), ...event }))}\n`, "utf8"))
    .catch(() => undefined);
}
async function openEventStream() {
  const response = await fetch(`${base}/event`, {
    headers: { Accept: "text/event-stream" },
    signal: eventsController.signal,
  });
  if (response.status !== 200) throw new Error(`GET /event returned ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let id = null;
          const dataLines = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("id:")) id = line.slice(3).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length > 0) {
            try { notice({ id, ...JSON.parse(dataLines.join("\n")) }); }
            catch { notice({ id, type: "unparsable", raw: dataLines.join("\n").slice(0, 400) }); }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!eventsController.signal.aborted) eventStreamError = String(error);
    }
  })();
  return response;
}
function waitForEvent(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    for (;;) {
      const found = events.find(predicate);
      if (found !== undefined) return found;
      if (Date.now() >= deadline) return null;
      await sleep(100);
    }
  })();
}

// ---------------------------------------------------------------- gateway process
let gateway;
let gatewayExit = null;
let exitCode = 1;
let timedOut = false;
const totalBudgetMs = readyTimeoutMs + promptTimeoutMs * 3 + abortSettleBudgetMs + 180_000;
const hardTimer = setTimeout(() => {
  timedOut = true;
  log(`total budget of ${totalBudgetMs}ms reached; tearing the gateway down`);
  void stopTree(gateway, "gateway");
}, totalBudgetMs);
hardTimer.unref?.();

async function readTail(file, lines) {
  if (!existsSync(file)) return [];
  const text = redact(await readFile(file, "utf8")).trim();
  return text === "" ? [] : text.split(/\r?\n/).slice(-lines);
}

let sessionId = null;
let messageCountAfterTask1 = null;
let traceIndex = 0;
/** Saves one trajectory next to the other evidence and returns it for the assertions. */
async function captureMessages(label) {
  const response = await call("GET", `/session/${sessionId}/message`, { timeoutMs: 60_000 });
  traceIndex += 1;
  const file = path.join(artifacts, `messages-${traceIndex}.json`);
  await writeFile(file, `${redact(JSON.stringify({ label, session_id: sessionId, captured_at: new Date().toISOString(), response: response.json ?? response.text }, null, 2))}\n`, "utf8");
  return { response, file };
}
function summarise(messages) {
  return messages.map((message) => ({
    role: message.role,
    finish: message.info?.finish ?? null,
    tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls.map((entry) => entry?.name ?? null) : [],
    tool_name: message.tool_name ?? null,
    tool_call_id: message.tool_call_id ?? null,
    part_types: Array.isArray(message.parts) ? message.parts.map((part) => part?.type ?? null) : [],
    content: redact(String(message.content ?? "")).slice(0, 200),
  }));
}
/** The assistant text of one message: the `content` field plus whatever text parts carry. */
function assistantText(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const partText = parts
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text ?? part.content ?? ""))
    .join("");
  return `${String(message?.content ?? "")}\n${partText}`;
}
async function describeFile(target) {
  try {
    const content = await readFile(target, "utf8");
    return { exists: true, bytes: content.length, head: redact(content).slice(0, 200) };
  } catch (error) {
    return { exists: false, error_code: String(error?.code ?? error) };
  }
}
/** A prompt whose settlement can be read without awaiting it (the abort case needs both). */
function promptAsync(text, timeoutMs = promptTimeoutMs) {
  const state = { outcome: undefined };
  const promise = call("POST", `/session/${sessionId}/prompt_async`, {
    body: { parts: [{ type: "text", text }], model: { providerID: "any", modelID: "any" } },
    timeoutMs,
  }).then((response) => {
    state.outcome = responseEvidence(response);
    return state.outcome;
  });
  return { promise, outcome: () => state.outcome };
}
/** What was pending when a prompt did not settle the way it should have. */
async function pendingInteractions() {
  const question = await call("GET", "/question", { timeoutMs: 15_000 });
  const permission = await call("GET", "/permission", { timeoutMs: 15_000 });
  return {
    questions: Array.isArray(question.json) ? question.json.length : responseEvidence(question),
    permissions: Array.isArray(permission.json) ? permission.json.length : responseEvidence(permission),
  };
}

try {
  if (!await portFree(port)) {
    throw new Error(`port ${port} is already in use. Stop the running gateway (pnp.cmd stop) or pass --port for this check.`);
  }
  // The manual's own start command, through the launcher a delivered package actually contains.
  // The environment is this process's, untouched: PNP_MODEL_* and everything else the operator set
  // travel through unchanged, and runtime/local.env is loaded by the gateway itself.
  const launcherName = process.platform === "win32" ? "gateway.cmd" : "gateway";
  const launcher = path.join(codeRoot, launcherName);
  if (!existsSync(launcher)) throw new Error(`launcher ${launcher} is missing; it ships next to package.json.`);
  const launcherArguments = ["--engine", engine, "--port", String(port)];
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : launcher;
  const commandArguments = process.platform === "win32"
    ? ["/d", "/s", "/c", launcher, ...launcherArguments]
    : launcherArguments;
  summary.startup_command = `${process.platform === "win32" ? ".\\gateway.cmd" : "./gateway"} ${launcherArguments.join(" ")}`;
  gateway = launch(command, commandArguments, {
    cwd: codeRoot,
    stdio: ["ignore", openSync(gatewayStdout, "a"), openSync(gatewayStderr, "a")],
    env: process.env,
  });
  gateway.once("exit", (code, signal) => { gatewayExit = { code, signal }; });
  log(`workspace ${workspace}`);
  log(`gateway via \`${summary.startup_command}\` (pid ${gateway.pid})`);
  log(`model endpoint and credentials come from this environment; only variable names are recorded.`);

  // ------------------------------------------------------------ 1. health-ready
  await check("health-ready", async (evidence) => {
    const candidates = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    const deadline = Date.now() + readyTimeoutMs;
    const attempts = candidates.map((candidate) => ({ base: candidate, status: null, last_error: null }));
    for (;;) {
      for (const attempt of attempts) {
        if (attempt.status === 200) continue;
        try {
          const response = await fetch(`${attempt.base}/health/ready`, { signal: AbortSignal.timeout(5_000) });
          attempt.status = response.status;
          const text = await response.text();
          if (response.status === 200) { attempt.body = text.slice(0, 200); attempt.last_error = null; }
          else attempt.last_error = redact(text).slice(0, 200);
        } catch (error) {
          attempt.last_error = String(error?.cause?.code ?? error?.name ?? error);
        }
      }
      const ready = attempts.find((attempt) => attempt.status === 200);
      if (ready !== undefined) {
        base = ready.base;
        evidence.base = base;
        evidence.body = ready.body;
        evidence.elapsed_ms = readyTimeoutMs - (deadline - Date.now());
        return;
      }
      evidence.attempts = attempts;
      evidence.gateway_exit = gatewayExit;
      if (gatewayExit !== null) {
        evidence.gateway_stderr_tail = await readTail(gatewayStderr, 20);
        evidence.gateway_stdout_tail = await readTail(gatewayStdout, 20);
        assert(false, "the gateway exited before it became ready", evidence);
      }
      assert(Date.now() < deadline, "the gateway did not answer /health/ready within the budget", evidence);
      await sleep(500);
    }
  });
  // Nothing below can mean anything if the gateway never came up.
  if (checks[0].status !== "pass") throw new Error("the gateway never became ready; the remaining checks were not attempted.");

  // ------------------------------------------------------------ 2. event-stream-open
  await check("event-stream-open", async (evidence) => {
    await openEventStream();
    const connected = await waitForEvent((event) => event.type === "server.connected", 15_000);
    evidence.events_file = eventsPath;
    evidence.server_connected = connected !== null;
    evidence.stream_error = eventStreamError;
    assert(connected !== null, "the SSE stream must deliver server.connected", { types: [...new Set(events.map((e) => e.type))] });
  });

  // ------------------------------------------------------------ 3. session/create
  await check("session/create", async (evidence) => {
    const response = await call("POST", "/session", { body: { title: "pnp live check", directory: workspace } });
    evidence.request_directory = workspace;
    evidence.create = responseEvidence(response);
    assert(response.status === 200, "POST /session must return 200", evidence.create);
    assert(typeof response.json?.id === "string" && response.json.id !== "", "POST /session must return an id", evidence.create);
    assert(response.json.status === "idle", "a new session must be created idle", evidence.create);
    sessionId = response.json.id;
    evidence.session_id = sessionId;
    const status = await call("GET", "/session/status");
    evidence.status = responseEvidence(status);
    assert(status.status === 200, "GET /session/status must return 200", evidence.status);
    const entry = status.json?.[sessionId];
    evidence.session_status_entry = entry ?? null;
    assert(entry !== null && typeof entry === "object", "GET /session/status must carry an entry keyed by the session id", evidence.status);
    assert(entry.type === "idle", "the new session's status must be {type:\"idle\"}", evidence.session_status_entry);
  });

  // ------------------------------------------------------------ 4. task1/write-file
  await check("task1/write-file", async (evidence) => {
    assert(sessionId !== null, "no session was created, so no task can run");
    const before = events.length;
    evidence.target = helloTarget;
    evidence.marker = marker;
    const prompt = `请在本机新建文本文件 ${helloTarget}，文件内容只写这一行：${marker}\n不要写入其他任何文字、引号或代码块标记。写完后回复"已完成"。`;
    evidence.prompt = prompt;
    const sent = promptAsync(prompt);
    const settled = await sent.promise;
    evidence.prompt_response = settled;
    if (settled.status !== 204) evidence.pending_interactions = await pendingInteractions();

    // Everything this check judges is collected BEFORE the first assertion, so a report about one
    // failed expectation still carries the trajectory and the event stream that go with it.
    evidence.file = await describeFile(helloTarget);
    const captured = await captureMessages("task1");
    evidence.messages_file = captured.file;
    const messages = Array.isArray(captured.response.json) ? captured.response.json : [];
    evidence.messages = summarise(messages);
    const last = messages[messages.length - 1];
    const parts = Array.isArray(last?.parts) ? last.parts : [];
    evidence.final_role = last?.role ?? null;
    evidence.final_finish = last?.info?.finish ?? null;
    evidence.final_parts = parts.map((part) => part?.type ?? null);
    const own = (event) => event.properties?.sessionID === sessionId;
    const stream = events.slice(before);
    const busyAt = stream.findIndex((event) => event.type === "session.status" && own(event) && event.properties?.status?.type === "busy");
    const idleAt = stream.findIndex((event, index) => index > busyAt && event.type === "session.status" && own(event) && event.properties?.status?.type === "idle");
    evidence.event_types = [...new Set(stream.map((event) => event.type))];
    evidence.busy_index = busyAt;
    evidence.idle_index = idleAt;
    evidence.session_idle = stream.some((event) => event.type === "session.idle" && own(event));
    evidence.part_updates = stream.filter((event) => event.type === "message.part.updated" && own(event)).length;
    const detail = await call("GET", `/session/${sessionId}`);
    messageCountAfterTask1 = detail.json?.message_count ?? null;
    evidence.message_count = messageCountAfterTask1;

    assert(settled.status === 204, "prompt_async must answer 204 once the round has finished and been persisted", settled);
    // The product of the round, on disk, where the prompt asked for it.
    assert(evidence.file.exists, `${helloTarget} must exist after the round`, evidence.file);
    assert(evidence.file.head.includes(marker), "the file must contain the exact marker the prompt named", evidence.file);
    // INSTRUCTION.md 3.1: the three conditions that together mean "finished".
    assert(captured.response.status === 200 && Array.isArray(captured.response.json),
      "GET /session/{id}/message must return an array", responseEvidence(captured.response));
    assert(last !== undefined, "the session must have messages");
    assert(evidence.final_role === "assistant", "the last message must be an assistant message", { role: evidence.final_role });
    assert(evidence.final_finish === "stop", "the final assistant message must carry info.finish == \"stop\"", { info: last.info ?? null });
    assert(evidence.final_parts.includes("step-finish"),
      "the final assistant message must carry a step-finish part", evidence.final_parts);
    // The event stream told a subscriber the same story.
    assert(busyAt >= 0, "the stream must publish session.status busy for this session", evidence.event_types);
    assert(idleAt > busyAt, "session.status idle must follow busy", { busy_index: busyAt, idle_index: idleAt });
    assert(evidence.session_idle, "the stream must publish session.idle for this session", evidence.event_types);
    assert(evidence.part_updates > 0, "the stream must publish at least one message.part.updated", evidence.event_types);
    assert(typeof messageCountAfterTask1 === "number" && messageCountAfterTask1 > 0,
      "GET /session/{id} must report a message_count above zero", responseEvidence(detail));
  });

  // ------------------------------------------------------------ 5. task2/history
  await check("task2/history", async (evidence) => {
    assert(sessionId !== null, "no session was created, so no task can run");
    // Read the count from the session itself rather than from what task1 happened to leave behind:
    // "it grew" must be measured across THIS round, whatever the previous check concluded.
    const beforeDetail = await call("GET", `/session/${sessionId}`);
    const countBefore = beforeDetail.json?.message_count ?? null;
    evidence.message_count_before = countBefore;
    evidence.message_count_after_task1 = messageCountAfterTask1;
    assert(typeof countBefore === "number", "GET /session/{id} must report message_count", responseEvidence(beforeDetail));

    const prompt = "把工作目录里 live-hello.txt 的内容原样回复给我，只回复内容本身";
    evidence.prompt = prompt;
    const settled = await promptAsync(prompt).promise;
    evidence.prompt_response = settled;
    if (settled.status !== 204) evidence.pending_interactions = await pendingInteractions();

    const captured = await captureMessages("task2");
    evidence.messages_file = captured.file;
    const messages = Array.isArray(captured.response.json) ? captured.response.json : [];
    evidence.messages = summarise(messages);
    const last = messages[messages.length - 1];
    evidence.final_text = redact(assistantText(last)).slice(0, 400);
    const detail = await call("GET", `/session/${sessionId}`);
    evidence.session_detail = responseEvidence(detail);
    const count = detail.json?.message_count ?? null;
    evidence.message_count_now = count;
    // The trajectory is a conversation, in order: it opens with the user's request, every tool
    // result answers a call an earlier assistant message announced, and it ends with the assistant.
    const roles = messages.map((message) => message.role);
    evidence.roles = roles;
    evidence.tool_messages = messages.filter((message) => message.role === "tool").length;
    const announced = new Map();
    const orphans = [];
    for (const message of messages) {
      if (message.role === "assistant") {
        for (const entry of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
          if (typeof entry?.id === "string") announced.set(entry.id, entry.name ?? null);
        }
      } else if (message.role === "tool" && !announced.has(message.tool_call_id)) {
        orphans.push(message.tool_call_id ?? null);
      }
    }
    evidence.orphan_tool_results = orphans;

    assert(settled.status === 204, "the second prompt_async must answer 204", settled);
    assert(captured.response.status === 200 && Array.isArray(captured.response.json),
      "GET /session/{id}/message must return an array", responseEvidence(captured.response));
    assert(last?.role === "assistant", "the last message must be an assistant message", { role: last?.role ?? null });
    // The marker only exists in the file the previous round wrote: quoting it back proves both that
    // the same session carried its history and that the engine really read the file.
    assert(assistantText(last).includes(marker),
      "the final assistant text must quote the marker the file contains", { final_text: evidence.final_text, marker });
    assert(typeof count === "number", "GET /session/{id} must report message_count", evidence.session_detail);
    assert(count > countBefore, "message_count must grow with the second round",
      { before: countBefore, after: count });

    assert(roles[0] === "user", "the trajectory must open with the user message", { roles });
    assert(roles.includes("assistant"), "the trajectory must contain assistant messages", { roles });
    assert(evidence.tool_messages > 0,
      "the trajectory must contain the tool entries the file work produced", { roles });
    assert(orphans.length === 0,
      "every tool result must follow the assistant message that announced its call", { orphans, roles });
    assert(roles[roles.length - 1] === "assistant", "the trajectory must end with the assistant", { roles });
  });

  // ------------------------------------------------------------ 6. task3/abort
  await check("task3/abort", async (evidence) => {
    assert(sessionId !== null, "no session was created, so no task can run");
    const prompt = `从 1 数到 5000，每个数字一行，写入 ${countTarget}，写完后再逐行核对一遍`;
    evidence.prompt = prompt;
    const sent = promptAsync(prompt);
    // The run has to be observably under way before a stop can mean anything.
    const busyDeadline = Date.now() + 20_000;
    let busy = false;
    let polls = 0;
    while (Date.now() < busyDeadline) {
      polls += 1;
      const status = await call("GET", "/session/status", { timeoutMs: 15_000 });
      if (status.json?.[sessionId]?.type === "busy") { busy = true; break; }
      if (sent.outcome() !== undefined) break;
      await sleep(250);
    }
    evidence.busy_polls = polls;
    evidence.observed_busy = busy;
    if (!busy && sent.outcome() !== undefined) {
      evidence.prompt_response = sent.outcome();
      // A round that ENDED before the abort could land leaves nothing to cancel, and that is a skip.
      // A round that FAILED is a different thing entirely and must be reported as the failure it is.
      assert(evidence.prompt_response.status === 204,
        "the long round ended before it could be aborted, and it did not end successfully", evidence.prompt_response);
      evidence.reason = "the round finished before it could be observed busy, so there was nothing left to stop";
      return "skip";
    }
    assert(busy, "GET /session/status never showed this session busy within 20s", { polls, prompt_response: sent.outcome() ?? null });

    const aborted = await call("POST", `/session/${sessionId}/abort`, { timeoutMs: 60_000 });
    evidence.abort = responseEvidence(aborted);
    assert(aborted.status === 200, "POST /session/{id}/abort must return 200", evidence.abort);
    assert(aborted.json?.ok === true, "abort must answer {ok:true}", evidence.abort);

    // A stop that is not settled within the gateway's own grace plus a round trip is a stop that
    // was not proven, and that is a failure rather than something to wait out.
    const settled = await Promise.race([
      sent.promise,
      sleep(abortSettleBudgetMs).then(() => ({ status: "not-settled", budget_ms: abortSettleBudgetMs })),
    ]);
    evidence.prompt_response = settled;
    evidence.abort_settle_budget_ms = abortSettleBudgetMs;
    assert(settled.status !== "not-settled",
      `the aborted prompt_async did not settle within PNP_CANCEL_GRACE_MS + 30s (${abortSettleBudgetMs}ms)`, settled);
    if (settled.status === 204) evidence.settlement = "204 (the run had started and was cancelled)";
    else if (settled.status === 409) evidence.settlement = `409 ${settled.body?.code ?? "(no code)"} (the run had not started)`;
    assert([204, 409].includes(settled.status),
      "the aborted prompt_async must settle with 204, or 409 EXECUTION_CANCELLED when the run had not started yet", settled);
    if (settled.status === 409) {
      assert(settled.body?.code === "EXECUTION_CANCELLED",
        "a 409 for an aborted run must carry EXECUTION_CANCELLED", settled);
    }

    const captured = await captureMessages("task3");
    evidence.messages_file = captured.file;
    const messages = Array.isArray(captured.response.json) ? captured.response.json : [];
    evidence.messages = summarise(messages);
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    evidence.final_finish = lastAssistant?.info?.finish ?? null;
    evidence.final_parts = Array.isArray(lastAssistant?.parts) ? lastAssistant.parts.map((part) => part?.type ?? null) : null;
    if (evidence.final_finish === "stop") {
      evidence.reason = "the model finished the long task before the abort landed; there was no cancellation to observe";
      evidence.file = await describeFile(countTarget);
      return "skip";
    }
    assert(evidence.final_finish === "cancelled",
      "the last assistant message of an aborted round must carry info.finish == \"cancelled\"",
      { finish: evidence.final_finish, messages: evidence.messages.slice(-4) });
    assert(!(evidence.final_parts ?? []).includes("step-finish"),
      "a cancelled round must not carry a step-finish part", evidence.final_parts);

    const status = await call("GET", "/session/status");
    evidence.session_status_entry = status.json?.[sessionId] ?? null;
    assert(evidence.session_status_entry?.type === "idle",
      "the session must be idle again after the abort", responseEvidence(status));
  });

  // ------------------------------------------------------------ 7. question-and-permission
  await check("question-and-permission", async (evidence) => {
    const question = await call("GET", "/question", { timeoutMs: 15_000 });
    const permission = await call("GET", "/permission", { timeoutMs: 15_000 });
    evidence.question = responseEvidence(question);
    evidence.permission = responseEvidence(permission);
    assert(question.status === 200 && Array.isArray(question.json), "GET /question must return 200 with an array", evidence.question);
    assert(permission.status === 200 && Array.isArray(permission.json), "GET /permission must return 200 with an array", evidence.permission);
    evidence.question_count = question.json.length;
    evidence.permission_count = permission.json.length;
    // The defaults answer questions automatically and allow every operation, so both lists are
    // normally empty. A pending entry is not a contract failure, but it is worth reporting.
    evidence.note = evidence.question_count === 0 && evidence.permission_count === 0
      ? "both lists are empty, which is the documented default posture"
      : "an interaction is still pending; PNP_QUESTION_POLICY / PNP_CONFIGURED_POLICY_OVERRIDES change this posture";
  });

  // ------------------------------------------------------------ 8. session/delete
  await check("session/delete", async (evidence) => {
    assert(sessionId !== null, "no session was created, so none can be deleted");
    const fileBefore = await describeFile(helloTarget);
    evidence.file_before = fileBefore;
    const removed = await call("DELETE", `/session/${sessionId}`, { timeoutMs: 120_000 });
    evidence.delete = responseEvidence(removed);
    assert(removed.status === 200, "DELETE /session/{id} must return 200", evidence.delete);
    assert(removed.json?.ok === true, "DELETE /session/{id} must answer {ok:true}", evidence.delete);
    const missing = await call("GET", `/session/${sessionId}`);
    evidence.after_delete = responseEvidence(missing);
    assert(missing.status === 404, "a deleted session must answer 404", evidence.after_delete);
    // Deleting a session clears this system's own state only; the work it produced is the user's.
    // A file the round never wrote is task1's failure to report, not this check's: the survival
    // assertion is made only about a file that was really there a moment ago.
    evidence.file_after = await describeFile(helloTarget);
    if (!fileBefore.exists) {
      evidence.note = "the task produced no file, so there was nothing for the delete to preserve; see task1";
      return;
    }
    assert(evidence.file_after.exists, "deleting the session must not remove the file the task produced",
      { before: fileBefore, after: evidence.file_after });
  });

  exitCode = checks.some((entry) => entry.status === "fail") ? 1 : 0;
} catch (error) {
  const message = redact(error instanceof Error ? (error.stack ?? error.message) : String(error));
  summary.orchestrator_error = message;
  process.stderr.write(`[live-check] ${message}\n`);
  exitCode = 1;
} finally {
  clearTimeout(hardTimer);
  eventsController.abort();
  await eventWrites.catch(() => undefined);
  summary.teardown = [await stopTree(gateway, "gateway")];
  await sleep(200);

  // A check that never ran is a check that did not pass; it is reported as a failure with the
  // reason, so the totals always cover the whole list.
  for (const name of PLANNED_CHECKS) {
    if (checks.some((entry) => entry.name === name)) continue;
    const reason = summary.orchestrator_error ?? (timedOut ? "the total budget expired" : "the run stopped before this check");
    checks.push({ name, status: "fail", duration_ms: 0, evidence: { not_attempted: reason.split("\n")[0] } });
    process.stdout.write(`[FAIL] ${name} (not attempted)\n`);
  }
  summary.checks = checks;
  summary.event_types = [...new Set(events.map((event) => event.type))];
  summary.event_count = events.length;
  summary.event_stream_error = eventStreamError;
  summary.gateway_exit = gatewayExit;
  summary.gateway_stderr_tail = await readTail(gatewayStderr, 20);
  summary.timed_out = timedOut;
  summary.finished_at = new Date().toISOString();
  const totals = {
    total: checks.length,
    passed: checks.filter((entry) => entry.status === "pass").length,
    failed: checks.filter((entry) => entry.status === "fail").length,
    skipped: checks.filter((entry) => entry.status === "skip").length,
  };
  summary.totals = totals;
  const passed = !timedOut && exitCode === 0 && totals.failed === 0 && summary.orchestrator_error === undefined;
  summary.result = passed ? "PASS" : "FAIL";
  summary.exit_code = passed ? 0 : 1;
  await writeFile(path.join(artifacts, "summary.json"), `${redact(JSON.stringify(summary, null, 2))}\n`, "utf8");

  // A failed run keeps its working tree so the produced files can be inspected next to the evidence.
  if (temporaryWorkspace !== undefined) {
    if (values.keep === true || !passed) log(`workspace kept for inspection: ${temporaryWorkspace}`);
    else await rm(temporaryWorkspace, { recursive: true, force: true }).catch(() => undefined);
  } else {
    log(`workspace ${workspace} was provided by --directory and is left untouched`);
  }
  process.stdout.write(`\n${JSON.stringify(totals)}\n`);
  log(`artifacts in ${artifacts}`);
  log(`result ${summary.result}${timedOut ? " (timed out)" : ""}`);
  process.exit(summary.exit_code);
}
