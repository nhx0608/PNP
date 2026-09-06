import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Json, StopEvidence } from "../../src/contracts/index.ts";
import { JsonlDecoder } from "../../src/runtime/jsonl.ts";
import { OwnedResourceScope } from "../../src/runtime/resource-scope.ts";
import { acquireInstanceLock } from "../../src/runtime/instance-lock.ts";
import { LocalProcessHost, baseEnvironment, bootTimeMs, windowsHelperCommand } from "../../src/runtime/process-host.ts";

const nativeRoot = fileURLToPath(new URL("../../native/windows/", import.meta.url));

/**
 * A fake supervisor speaking the real JSONL frame protocol. It is the only way to exercise the
 * Windows state machine off Windows; everything it stands in for is stated as such in the report.
 */
const fakeHelper = `
const fs = require("node:fs");
const config = JSON.parse(process.env.PNP_FAKE ?? "{}");
const mode = config.mode ?? "normal";
let buffer = "";
function emit(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function log(value) { if (config.record) fs.appendFileSync(config.record, JSON.stringify(value) + "\\n"); }
function handle(frame) {
  log(frame);
  if (frame.operation === "inspect") {
    emit({ type: "inspection", windowsSessionId: config.sessionId ?? 1, quiescent: config.inspectQuiescent === true,
      results: (frame.jobNames ?? []).map((name) => ({ jobName: name, quiescent: config.inspectQuiescent === true, error: 0 })) });
    process.exit(0);
  }
  if (frame.operation === "launch") {
    if (mode === "die-on-launch") process.exit(3);
    if (mode === "no-session") emit({ type: "prepared" });
    else emit({ type: "prepared", windowsSessionId: config.sessionId ?? 1 });
    return;
  }
  if (frame.type === "proceed") {
    if (mode === "job-error") { emit({ type: "error", code: "HOST_FAILURE", phase: "job" }); process.exit(4); }
    // Diagnostics precede the hang: a wedged engine still writes to standard error first.
    if (config.stderr) emit({ type: "stderr", data: Buffer.from(config.stderr).toString("base64") });
    if (mode === "stall") return;
    emit({ type: "ready", pid: config.enginePid ?? 4242, jobName: frame.jobName, windowsSessionId: config.sessionId ?? 1 });
    return;
  }
  if (frame.type === "write") { emit({ type: "stdout", data: frame.data }); return; }
  if (frame.type === "terminate") {
    if (mode === "stubborn") return;
    if (config.partialTail) emit({ type: "stdout", data: Buffer.from(config.partialTail).toString("base64") });
    emit({ type: "exit", code: config.exitCode ?? 0, quiescent: config.quiescent !== false, drained: config.drained !== false });
    setTimeout(() => process.exit(0), 5);
  }
}
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (line.trim().length > 0) handle(JSON.parse(line));
  }
});
if (mode === "die-now") process.exit(5);
// The harness makes the forceful stop a no-op for a stubborn supervisor; this timer only
// guarantees the process cannot outlive the test if that cleanup is ever missed.
if (mode === "stubborn") setTimeout(() => process.exit(0), 15000);
`;

interface FakeOptions {
  mode?: string;
  record?: string;
  sessionId?: number;
  enginePid?: number;
  exitCode?: number;
  quiescent?: boolean;
  drained?: boolean;
  stderr?: string;
  partialTail?: string;
  inspectQuiescent?: boolean;
  helperThrows?: boolean;
  tool?: (file: string, args: readonly string[]) => { code: number | null; stdout: string };
}

class FakeWindowsHost extends LocalProcessHost {
  readonly toolCalls: { file: string; args: string[] }[] = [];
  helperStarts = 0;
  private readonly script: string;
  private readonly options: FakeOptions;
  constructor(directory: string, script: string, options: FakeOptions, timeoutMs = 400, graceMs = 120) {
    super(directory, timeoutMs, graceMs);
    this.script = script;
    this.options = options;
  }
  protected override get hostPlatform(): NodeJS.Platform { return "win32"; }
  protected override async helper(): Promise<ChildProcessWithoutNullStreams> {
    this.helperStarts++;
    if (this.options.helperThrows === true) throw new Error("supervisor source is unavailable");
    const child = spawn(process.execPath, [this.script], {
      env: { ...process.env, PNP_FAKE: JSON.stringify(this.options) }, stdio: "pipe", shell: false,
    });
    if (this.options.mode === "stubborn") {
      // A wedged supervisor is the only way the process-id last resort is reached. Windows has no
      // signal a child can ignore, so the resistance is modelled here instead of in the child: the
      // forceful stop becomes a no-op and the real kill is kept for cleanup.
      const real = child.kill.bind(child);
      this.reap.push(() => { real("SIGKILL"); });
      child.kill = () => true;
    }
    return child;
  }
  /** Kills what the stubborn mode refused to kill, so a test never leaks a process. */
  readonly reap: (() => void)[] = [];
  protected override runTool(file: string, args: readonly string[], _timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
    void _timeoutMs;
    this.toolCalls.push({ file, args: [...args] });
    const answer = this.options.tool?.(file, args) ?? { code: null, stdout: "" };
    return Promise.resolve(answer);
  }
}

async function workspace(name: string): Promise<{ directory: string; script: string; nodeExe: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), `pnp-${name}-`));
  const script = path.join(directory, "fake-helper.cjs");
  await writeFile(script, fakeHelper);
  const nodeExe = path.join(directory, "node.exe");
  await symlink(process.execPath, nodeExe);
  return { directory, script, nodeExe };
}
async function ownershipRecord(directory: string): Promise<Record<string, Json>> {
  const files = (await readdir(path.join(directory, "hosts"))).filter((file) => file.endsWith(".json"));
  assert.equal(files.length, 1);
  return JSON.parse(await readFile(path.join(directory, "hosts", files[0]!), "utf8")) as Record<string, Json>;
}
const spec = (directory: string, nodeExe: string, args: string[]) => ({
  executable: nodeExe, args, cwd: directory, env: {}, sessionId: "s", ownerToken: "t",
});
async function reapedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  return pid;
}
function baseRecord(overrides: Record<string, Json>): Record<string, Json> {
  const hostId = randomUUID();
  return {
    hostId, sessionId: "s", ownerToken: "t", parentPid: process.pid, generation: Date.now(),
    jobName: `Local\\PNP-${hostId}`, platform: "win32", mode: "job", helperPid: process.pid,
    enginePid: 0, imageName: "powershell.exe", windowsSessionId: 1, quiescent: false, ...overrides,
  };
}

const queriedPid = (args: readonly string[]): string => (/PID eq (\d+)/.exec(args.join(" ")) ?? [])[1] ?? "0";
const taskRow = (pid: string) => `powershell.exe ${pid} Console 1 50 K\n`;
const noTasks = "INFO: No tasks are running which match the specified criteria.\n";

/* ---------------------------------------------------------------- fix 1: write guard */

test("a failed termination never re-opens the write channel and stays retryable", async () => {
  const { directory, script, nodeExe } = await workspace("guard");
  // taskkill reports the supervisor is still present, so the stop cannot be proven.
  const host = new FakeWindowsHost(directory, script, { mode: "stubborn",
    tool: (file, args) => file.endsWith("tasklist.exe")
      ? { code: 0, stdout: taskRow(queriedPid(args)) } // still there, before and after the kill
      : { code: 0, stdout: "" } });
  const scope = new OwnedResourceScope();
  try {
    const hosted = await host.start(spec(directory, nodeExe, []), new AbortController().signal, scope);
    await hosted.write("{\"before\":true}");
    const first = await hosted.terminate();
    assert.equal(first.quiescent, false, "an unstoppable supervisor must not report quiescence");
    await assert.rejects(hosted.write("{\"after\":true}"), { code: "HOST_EXITED" });
    const callsBefore = host.toolCalls.length;
    const second = await hosted.terminate();
    assert.equal(second.quiescent, false);
    assert.ok(host.toolCalls.length > callsBefore, "a failed stop must be retried, not cached");
    await assert.rejects(hosted.write("{\"still\":true}"), { code: "HOST_EXITED" });
  } finally { await scope.stop(500); for (const reap of host.reap) reap(); await rm(directory, { recursive: true, force: true }); }
});

/* ------------------------------------------------- fix 2: graded reconciliation evidence */

test("reconciliation grades evidence and never spawns a supervisor it does not need", async () => {
  const { directory, script } = await workspace("grade");
  const host = new FakeWindowsHost(directory, script, { inspectQuiescent: true });
  try {
    assert.equal((await host.reconcile(baseRecord({ quiescent: true }))).quiescent, true);
    assert.equal((await host.reconcile(baseRecord({ generation: bootTimeMs() - 1000 }))).quiescent, true,
      "a record older than the current boot describes a process that cannot exist");
    assert.equal((await host.reconcile(baseRecord({ helperPid: 0 }))).quiescent, true,
      "helperPid 0 means the process was never created");
    assert.equal((await host.reconcile(baseRecord({ helperPid: await reapedPid() }))).quiescent, true,
      "a dead supervisor already closed the job handle");
    assert.equal(host.helperStarts, 0, "none of the cheap verdicts may start an interpreter");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a missing Windows session id degrades the verdict instead of vetoing it", async () => {
  const { directory, script } = await workspace("session");
  const host = new FakeWindowsHost(directory, script, { inspectQuiescent: true, sessionId: 9 });
  try {
    assert.equal((await host.reconcile(baseRecord({ windowsSessionId: null }))).quiescent, true);
    assert.equal((await host.reconcile(baseRecord({ windowsSessionId: 9 }))).quiescent, true);
    assert.equal((await host.reconcile(baseRecord({ windowsSessionId: 8 }))).quiescent, false,
      "a recorded session id that disagrees with the live one is still conclusive");
    assert.equal(host.helperStarts, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a reused process id is decided by image name before the job is inspected", async () => {
  const { directory, script } = await workspace("reuse");
  const host = new FakeWindowsHost(directory, script, { inspectQuiescent: false,
    tool: () => ({ code: 0, stdout: `"notepad.exe","${process.pid}","Console","1","9,000 K"\r\n` }) });
  try {
    assert.equal((await host.reconcile(baseRecord({}))).quiescent, true, "the image name proves the id was reused");
    assert.equal(host.helperStarts, 0, "process id reuse must be settled without an inspection");
    const matching = new FakeWindowsHost(directory, script, { inspectQuiescent: false,
      tool: () => ({ code: 0, stdout: `"powershell.exe","${process.pid}","Console","1","9,000 K"\r\n` }) });
    assert.equal((await matching.reconcile(baseRecord({}))).quiescent, false,
      "a live supervisor with a matching image and a non-empty job is not quiescent");
    assert.equal(matching.helperStarts, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an unreadable process list is unknown liveness, never stop evidence", async () => {
  const { directory, script } = await workspace("unknown");
  const host = new FakeWindowsHost(directory, script, { inspectQuiescent: false, tool: () => ({ code: 1, stdout: "" }) });
  try { assert.equal((await host.reconcile(baseRecord({}))).quiescent, false); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

/* ------------------------------------------- fix 3: degraded mode and the taskkill path */

test("an unavailable supervisor degrades to a plain spawn instead of refusing the engine", async () => {
  const { directory, script, nodeExe } = await workspace("degrade-source");
  const host = new FakeWindowsHost(directory, script, { helperThrows: true,
    tool: (file) => file.endsWith("tasklist.exe") ? { code: 0, stdout: "INFO: No tasks are running.\n" } : { code: 0, stdout: "" } });
  const scope = new OwnedResourceScope();
  try {
    const hosted = await host.start(spec(directory, nodeExe,
      ["-e", "process.stdout.write('ready\\n');process.stdin.on('data',(b)=>process.stdout.write(b))"]),
      new AbortController().signal, scope);
    const frames: string[] = [];
    hosted.onFrame((frame) => frames.push(frame));
    await hosted.write("{\"echo\":1}");
    await waitFor(() => frames.some((frame) => frame.includes("echo")));
    const record = await ownershipRecord(directory);
    assert.equal(record.mode, "degraded");
    assert.equal(record.imageName, "node.exe");
    assert.equal((await hosted.terminate()).quiescent, true);
  } finally { await scope.stop(1000); for (const reap of host.reap) reap(); await rm(directory, { recursive: true, force: true }); }
});

test("a job that cannot be created degrades once the supervisor proves no engine exists", async () => {
  const { directory, script, nodeExe } = await workspace("degrade-job");
  const host = new FakeWindowsHost(directory, script, { mode: "job-error",
    tool: (file) => file.endsWith("tasklist.exe") ? { code: 0, stdout: "INFO: No tasks are running.\n" } : { code: 0, stdout: "" } });
  const scope = new OwnedResourceScope();
  try {
    const hosted = await host.start(spec(directory, nodeExe,
      ["-e", "process.stdout.write('ready\\n');setInterval(()=>{},1000)"]), new AbortController().signal, scope);
    const record = await ownershipRecord(directory);
    assert.equal(record.mode, "degraded");
    assert.equal(record.helperPid, record.enginePid);
    assert.equal((await hosted.terminate()).quiescent, true);
  } finally { await scope.stop(1000); for (const reap of host.reap) reap(); await rm(directory, { recursive: true, force: true }); }
});

test("the last resort kills by process id only and verifies with the process list", async () => {
  const { directory, script, nodeExe } = await workspace("taskkill");
  let present = true;
  const host = new FakeWindowsHost(directory, script, { mode: "stubborn",
    tool: (file, args) => {
      if (file.endsWith("taskkill.exe")) { present = false; return { code: 0, stdout: "SUCCESS" }; }
      return { code: 0, stdout: present ? taskRow(queriedPid(args)) : noTasks };
    } });
  const scope = new OwnedResourceScope();
  try {
    const hosted = await host.start(spec(directory, nodeExe, []), new AbortController().signal, scope);
    const pid = Number((await ownershipRecord(directory)).helperPid);
    assert.equal((await hosted.terminate()).quiescent, true);
    const kill = host.toolCalls.find((call) => call.file.endsWith("taskkill.exe"));
    assert.deepEqual(kill?.args, ["/PID", String(pid), "/T", "/F"]);
    const list = host.toolCalls.find((call) => call.file.endsWith("tasklist.exe"));
    assert.deepEqual(list?.args, ["/FI", `PID eq ${pid}`, "/NH"]);
    for (const call of host.toolCalls) {
      assert.equal(call.args.some((argument) => /\.exe$/i.test(argument)), false, "no command may name an image");
      assert.equal(call.args.includes("/IM"), false, "killing by image name is forbidden");
    }
    assert.equal((await ownershipRecord(directory)).quiescent, true);
  } finally { await scope.stop(1000); for (const reap of host.reap) reap(); await rm(directory, { recursive: true, force: true }); }
});

/* --------------------------------------------------------------- fix 4: the grace period */

test("termination asks for an orderly stop with a grace budget before anything is killed", async () => {
  const { directory, script, nodeExe } = await workspace("grace");
  const record = path.join(directory, "frames.jsonl");
  const host = new FakeWindowsHost(directory, script, { record }, 400, 250);
  const scope = new OwnedResourceScope();
  try {
    const hosted = await host.start(spec(directory, nodeExe, []), new AbortController().signal, scope);
    assert.equal((await hosted.terminate()).quiescent, true);
    const frames = (await readFile(record, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type?: string; graceMs?: number });
    const stop = frames.find((frame) => frame.type === "terminate");
    assert.equal(stop?.graceMs, 250, "the control frame must carry the grace budget");
    const launch = frames.find((frame) => (frame as { operation?: string }).operation === "launch");
    assert.equal((launch as { graceMs?: number } | undefined)?.graceMs, 250);
  } finally { await scope.stop(1000); for (const reap of host.reap) reap(); await rm(directory, { recursive: true, force: true }); }
});

test("the native supervisor closes standard input and waits before destroying the job", async () => {
  const source = await readFile(path.join(nativeRoot, "JobHost.cs"), "utf8");
  const control = source.slice(source.indexOf("Phase one:"));
  assert.match(control, /stdin\.Dispose\(\)/);
  const order = control.indexOf("stdin.Dispose()");
  const wait = control.indexOf("WaitForSingleObject(ownedProcess");
  const kill = control.indexOf("TerminateJobObject(ownedJob, 1)");
  assert.ok(order >= 0 && wait > order && kill > wait, "end of file, then grace, then termination");
});

/* ---------------------------------- fix 5: handle inheritance, exit detection, drain matrix */

test("the native supervisor clears inheritance on its own standard handles before CreateProcess", async () => {
  const source = await readFile(path.join(nativeRoot, "JobHost.cs"), "utf8");
  assert.match(source, /static extern IntPtr GetStdHandle\(int id\);/);
  assert.match(source, /SetHandleInformation\(handle, 1, 0\)/);
  for (const id of ["-10", "-11", "-12"]) assert.ok(source.includes(`ProtectStandardHandle(${id})`), `handle ${id}`);
  assert.ok(source.indexOf("ProtectStandardHandle(-10)") < source.indexOf("Check(CreateProcess("),
    "inheritance must be cleared before the engine is created");
});

test("process exit is decided by the exit event, not by a pipe a grandchild still holds", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pnp-exit-"));
  const host = new LocalProcessHost(directory, 1000, 100);
  const scope = new OwnedResourceScope();
  if (process.platform === "win32") return; // The POSIX group is the local stand-in for a Job Object.
  try {
    const hosted = await host.start({ executable: process.execPath, cwd: directory, env: {}, sessionId: "s", ownerToken: "t",
      args: ["-e", "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{stdio:['ignore',1,2]});setTimeout(()=>process.exit(9),50)"],
    }, new AbortController().signal, scope);
    const exit = await Promise.race([
      new Promise<{ code: number | null }>((resolve) => hosted.onExit(resolve)),
      new Promise<{ code: number | null }>((resolve) => setTimeout(() => resolve({ code: -1 }), 3000)),
    ]);
    assert.equal(exit.code, 9, "a grandchild holding the pipe must not hide the engine exit");
  } finally { await scope.stop(2000); await rm(directory, { recursive: true, force: true }); }
});

for (const shape of [
  { quiescent: true, drained: true, exitCode: 7, expectedCode: 7, expectedQuiescent: true },
  { quiescent: true, drained: false, exitCode: 7, expectedCode: 7, expectedQuiescent: true },
  { quiescent: false, drained: true, exitCode: 0, expectedCode: 0, expectedQuiescent: false },
  { quiescent: false, drained: false, exitCode: 0, expectedCode: 0, expectedQuiescent: false },
]) {
  test(`supervisor exit reports the engine code when quiescent=${shape.quiescent} drained=${shape.drained}`, async () => {
    const { directory, script, nodeExe } = await workspace("matrix");
    const host = new FakeWindowsHost(directory, script, { exitCode: shape.exitCode, quiescent: shape.quiescent,
      drained: shape.drained, inspectQuiescent: false,
      tool: () => ({ code: 0, stdout: "INFO: No tasks are running.\n" }) });
    const scope = new OwnedResourceScope();
    try {
      const hosted = await host.start(spec(directory, nodeExe, []), new AbortController().signal, scope);
      const seen = new Promise<{ code: number | null; signal: string | null }>((resolve) => hosted.onExit(resolve));
      const evidence = await hosted.terminate();
      const exit = await seen;
      assert.equal(exit.code, shape.expectedCode, "an undrained pipe must never replace the real exit code");
      assert.equal(exit.signal, null);
      assert.equal(evidence.quiescent, shape.expectedQuiescent);
    } finally { await scope.stop(1000); for (const reap of host.reap) reap(); await rm(directory, { recursive: true, force: true }); }
  });
}

test("an undrained trailing frame is discarded with a diagnostic, not raised as a protocol error", async () => {
  const { directory, script, nodeExe } = await workspace("undrained");
  const host = new FakeWindowsHost(directory, script, { drained: false, partialTail: "{\"half\":", exitCode: 0 });
  const scope = new OwnedResourceScope();
  try {
    const hosted = await host.start(spec(directory, nodeExe, []), new AbortController().signal, scope);
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      hosted.onExit(resolve);
      void hosted.terminate();
    });
    assert.equal(exit.code, 0);
    await waitFor(async () => {
      const failure = await hosted.write("{}").then(() => undefined, (error: unknown) => error as Error);
      return failure !== undefined && /undrained trailing frame/.test(failure.message);
    });
  } finally { await scope.stop(1000); for (const reap of host.reap) reap(); await rm(directory, { recursive: true, force: true }); }
});

/* ------------------------------------------------------- fix 6: the parent watchdog */

test("the parent watchdog polls for a proven exit instead of killing on a failed probe", async () => {
  const source = await readFile(path.join(nativeRoot, "JobHost.cs"), "utf8");
  const watchdog = source.slice(source.indexOf("Losing the synchronisation right"));
  const guarded = watchdog.slice(0, watchdog.indexOf("Emit(new { type=\"ready\""));
  assert.match(guarded, /catch \(Exception\) \{ gone = false; \}/);
  assert.match(guarded, /while \(!gone\)/);
  assert.match(guarded, /if \(!HandlesClosed\) TerminateJobObject/);
  assert.equal(/catch \(Exception\)\s*\{\s*\}\s*TerminateJobObject/.test(guarded), false,
    "a failed probe must never terminate the job");
});

/* ------------------------------------------------ fix 7: the environment whitelist */

test("the inherited environment carries system identity and still no credentials", () => {
  const required = ["SystemDrive", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles",
    "ProgramData", "ALLUSERSPROFILE", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH",
    "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS", "PUBLIC", "SESSIONNAME", "PSModulePath"];
  // A synthetic source instead of the real process environment: the real one already defines some of
  // these on Windows, and mutating it made the assertion depend on the host machine.
  const source: NodeJS.ProcessEnv = { PNP_FAKE_CREDENTIAL: "must-not-leak" };
  for (const key of required) source[key] = `value-of-${key}`;
  const environment = baseEnvironment(source);
  for (const key of required) assert.equal(environment[key], `value-of-${key}`, key);
  assert.equal(environment.PNP_FAKE_CREDENTIAL, undefined);
});

/* --------------------------------------- fix 8: one compilation unit with an artefact cache */

test("the Windows helper is one cached compilation unit and no longer a second source file", () => {
  assert.equal(existsSync(path.join(nativeRoot, "InstanceGuard.cs")), false);
  assert.equal(existsSync(path.join(nativeRoot, "JobHost.cs")), true);
  const cache = path.join(tmpdir(), "pnp-cache-probe");
  const command = windowsHelperCommand(cache);
  assert.equal(command.args.includes("-EncodedCommand"), true);
  assert.equal(command.args.includes("Bypass"), true);
  const script = Buffer.from(command.args[command.args.length - 1]!, "base64").toString("utf16le");
  assert.match(script, /\[PNP\.JobHost\]::Run\(\)/);
  assert.match(script, /JobHost\.cs/);
  assert.match(script, /-OutputAssembly \$tmp -OutputType Library/);
  assert.match(script, new RegExp(`helper-[0-9a-f]{64}\\.dll`));
  assert.match(script, /Reflection\.Assembly\]::LoadFrom\(\$cache\)/);
  assert.equal(/InstanceGuard/.test(script), false);
  // A lost cache must fall back to compiling the source, never to refusing to start.
  assert.match(script, /if \(-not \$ok\) \{ Add-Type -TypeDefinition/);
  assert.equal(windowsHelperCommand(cache).args[7], command.args[7] === undefined ? undefined : windowsHelperCommand(cache).args[7]);
});

test("the guard operation lives in the job host source and validates its own input", async () => {
  const source = await readFile(path.join(nativeRoot, "JobHost.cs"), "utf8");
  assert.match(source, /if \(operation == "guard"\) \{ Guard\(config\); return; \}/);
  assert.match(source, /INVALID_GUARD_INPUT/);
  assert.match(source, /INSTANCE_LOCKED/);
  assert.match(source, /jobNames/, "inspection must accept a batch of job names");
});

/* ------------------------------------------------- fix 9: stale lock takeover off Windows */

test("a lock whose owner is proven dead is taken over instead of blocking every later round", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pnp-stale-"));
  const lock = path.join(directory, "gateway.lock");
  try {
    await writeFile(lock, JSON.stringify({ pid: await reapedPid(), startedAt: new Date().toISOString() }));
    const release = await acquireInstanceLock(lock);
    assert.equal(JSON.parse(await readFile(lock, "utf8")).pid, process.pid);
    await release();
    // A live owner is never displaced.
    await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await assert.rejects(acquireInstanceLock(lock), { code: "INSTANCE_LOCKED" });
    // A live process id recorded before this boot is a reused id, not the owner.
    await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date(bootTimeMs() - 60_000).toISOString() }));
    await (await acquireInstanceLock(lock))();
    // Unreadable content cannot prove ownership either.
    await writeFile(lock, "not json at all");
    await (await acquireInstanceLock(lock))();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/* ---------------------------------------------------------- fix 10: the engine process id */

test("the engine process id from the ready frame is recorded as a second evidence source", async () => {
  const { directory, script, nodeExe } = await workspace("enginepid");
  const host = new FakeWindowsHost(directory, script, { enginePid: 31337 });
  const scope = new OwnedResourceScope();
  try {
    const hosted = await host.start(spec(directory, nodeExe, []), new AbortController().signal, scope);
    // The ownership save is deliberately detached from the ready frame, and an atomic write on a
    // loaded Windows runner is not fast, so the budget is generous rather than tight.
    await waitFor(async () => Number((await ownershipRecord(directory)).enginePid) === 31337, 20_000);
    await hosted.terminate();
  } finally { await scope.stop(1000); for (const reap of host.reap) reap(); await rm(directory, { recursive: true, force: true }); }
});

/* ---------------------------------------------------- fix 11: redacted standard error tail */

test("standard error becomes a redacted bounded diagnostic instead of a bare exit code", async () => {
  const { directory, script, nodeExe } = await workspace("stderr");
  const host = new FakeWindowsHost(directory, script, { mode: "stall",
    stderr: "Error: cannot find module 'acp'\napi_key=super-secret-value\n" });
  const scope = new OwnedResourceScope();
  try {
    const failure = await host.start(spec(directory, nodeExe, []), new AbortController().signal, scope)
      .then(() => undefined, (error: unknown) => error as Error);
    assert.ok(failure !== undefined);
    assert.match(failure.message, /cannot find module/);
    assert.equal(/super-secret-value/.test(failure.message), false, "diagnostics must be redacted");
    assert.match(failure.message, /\[REDACTED\]/);
  } finally { await scope.stop(1000); for (const reap of host.reap) reap(); await rm(directory, { recursive: true, force: true }); }
});

test("a bounded diagnostic keeps only the tail of a noisy engine", async () => {
  const { directory, script, nodeExe } = await workspace("bounded");
  const host = new FakeWindowsHost(directory, script, { mode: "stall", stderr: `${"A".repeat(64 * 1024)}TAIL-MARKER` });
  const scope = new OwnedResourceScope();
  try {
    const failure = await host.start(spec(directory, nodeExe, []), new AbortController().signal, scope)
      .then(() => undefined, (error: unknown) => error as Error);
    assert.ok(failure !== undefined);
    assert.match(failure.message, /TAIL-MARKER/);
    assert.ok(failure.message.length < 4096, "the diagnostic must stay bounded");
  } finally { await scope.stop(1000); for (const reap of host.reap) reap(); await rm(directory, { recursive: true, force: true }); }
});

/* --------------------------------------------------- fix 12: cancellation during startup */

test("cancellation during startup is reported as cancellation, not as a host exit", async () => {
  const { directory, script, nodeExe } = await workspace("cancel");
  const host = new FakeWindowsHost(directory, script, { mode: "stall" }, 2000, 100);
  const controller = new AbortController();
  const scope = new OwnedResourceScope();
  try {
    const started = host.start(spec(directory, nodeExe, []), controller.signal, scope);
    setTimeout(() => controller.abort(), 60);
    await assert.rejects(started, { code: "EXECUTION_CANCELLED", status: 409 });
  } finally { await scope.stop(1000); for (const reap of host.reap) reap(); await rm(directory, { recursive: true, force: true }); }
});

/* ----------------------------------------------------------- fix 13: idempotent teardown */

test("only a proven stop is cached, and repeat teardown has no further effect", async () => {
  const { directory, script, nodeExe } = await workspace("idempotent");
  const host = new FakeWindowsHost(directory, script, {});
  const scope = new OwnedResourceScope();
  try {
    const hosted = await host.start(spec(directory, nodeExe, []), new AbortController().signal, scope);
    const [a, b] = await Promise.all([hosted.terminate(), hosted.terminate()]);
    assert.equal(a.quiescent, true);
    assert.deepEqual(a, b, "concurrent callers share one verification");
    const calls = host.toolCalls.length;
    assert.deepEqual(await hosted.terminate(), a, "a proven stop is answered from cache");
    assert.equal(host.toolCalls.length, calls, "a proven stop has no side effects");
    assert.equal((await scope.stop(500)).quiescent, true, "closing a proven-silent channel also returns true");
    await assert.rejects(hosted.write("{}"), { code: "HOST_EXITED" });
  } finally { await scope.stop(500); for (const reap of host.reap) reap(); await rm(directory, { recursive: true, force: true }); }
});

test("the resource scope shares one attempt, retries failures and survives a caller timeout", async () => {
  const scope = new OwnedResourceScope();
  let attempts = 0;
  let release: (() => void) | undefined;
  scope.register("slow", () => {
    attempts++;
    if (attempts === 1) return new Promise<StopEvidence>((resolve) => { release = () => resolve({ quiescent: false, method: "process-tree" }); });
    return Promise.resolve({ quiescent: true, method: "process-tree" });
  });
  const first = scope.stop(30);
  const shared = scope.stop(30);
  assert.equal((await first).quiescent, false, "a caller timeout is not stop evidence");
  assert.equal((await shared).quiescent, false);
  assert.equal(attempts, 1, "a caller timeout must not start a second teardown");
  release?.();
  await waitFor(() => attempts === 1);
  assert.equal((await scope.stop(500)).quiescent, true, "a failed teardown stays retryable");
  assert.equal(attempts, 2);
  const cached = await scope.stop(500);
  assert.equal(cached.quiescent, true);
  assert.equal(attempts, 2, "only success is cached");
});

/* --------------------------------------------------------------- fix 14: quality items */

test("framing a large record scans a linear number of bytes, not a quadratic one", () => {
  const original = Buffer.byteLength;
  let scanned = 0;
  const counting = ((value: string | Buffer, encoding?: BufferEncoding): number => {
    if (typeof value === "string") scanned += value.length;
    return original(value as string, encoding);
  }) as typeof Buffer.byteLength;
  const target = Buffer as unknown as { byteLength: typeof Buffer.byteLength };
  target.byteLength = counting;
  try {
    const decoder = new JsonlDecoder();
    const chunk = Buffer.from("x".repeat(4096));
    const chunks = 768; // 3 MiB assembled from 4 KiB pieces.
    for (let index = 0; index < chunks; index++) decoder.push(chunk);
    assert.deepEqual(decoder.push(Buffer.from("\n")), ["x".repeat(chunks * 4096)]);
    assert.ok(scanned < 20 * chunks * 4096, `scanned ${scanned} bytes for ${chunks * 4096}`);
  } finally { target.byteLength = original; }
});

test("ending a framer is idempotent and still reports a truncated record once", () => {
  const decoder = new JsonlDecoder();
  decoder.push(Buffer.from("{\"a\":1}"));
  assert.throws(() => decoder.end(), { code: "ENGINE_PROTOCOL_ERROR" });
  decoder.end();
  assert.throws(() => decoder.push(Buffer.from("x")), { code: "ENGINE_PROTOCOL_ERROR" });
  const clean = new JsonlDecoder();
  assert.deepEqual(clean.push(Buffer.from("{\"a\":1}\n")), ["{\"a\":1}"]);
  clean.end();
  clean.end();
});

test("the supervisor gives its output pumps five seconds to drain", async () => {
  const source = await readFile(path.join(nativeRoot, "JobHost.cs"), "utf8");
  assert.match(source, /Task\.WaitAll\(new Task\[\] \{ stdout, stderr \}, 5000\)/);
});

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not reached in time");
}
void mkdir;
