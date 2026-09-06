import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { uptime } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HostedProcess, LaunchSpec, ProcessHost } from "../contracts/host.ts";
import type { Json, ResourceScope, StopEvidence } from "../contracts/index.ts";
import { PnpError } from "../core/errors.ts";
import { Redactor } from "../security/redaction.ts";
import { bounded, deferred } from "./deadline.ts";
import { JsonlDecoder } from "./jsonl.ts";

/**
 * Minimal inheritance exists to keep credentials out of engine processes, not to starve the
 * engine of the system identity every Windows toolchain reads. None of these carry a secret.
 */
const systemKeys = ["SystemRoot", "WINDIR", "SystemDrive", "PATH", "PATHEXT", "TEMP", "TMP",
  "USERPROFILE", "HOME", "LOCALAPPDATA", "APPDATA", "COMSPEC",
  "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "ProgramData",
  "ALLUSERSPROFILE", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH",
  "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS", "PUBLIC", "SESSIONNAME", "PSModulePath"];
/** The source is injectable so a test can assert the allow-list without mutating the real process. */
export function baseEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(systemKeys.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]!]]));
}
const diagnosticLimitBytes = 16 * 1024;
const secretishKey = /key|token|secret|password|credential|cookie|authorization/i;
function controlWrite(child: ChildProcessWithoutNullStreams, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => child.stdin.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : resolve()));
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return !(e instanceof Error && "code" in e && e.code === "ESRCH"); } }
/** Processes created before the current boot cannot still be running; a margin keeps the clock skew safe. */
export function bootTimeMs(marginMs = 60_000): number { return Date.now() - uptime() * 1000 - marginMs; }
export function supervisorEngineExit(event: unknown): { code: number | null; signal: string | null } | undefined {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return undefined;
  const value = event as { type?: unknown; code?: unknown };
  if (value.type !== "exit" || (value.code !== null && typeof value.code !== "number")) return undefined;
  return { code: value.code as number | null, signal: null };
}

export interface HelperSource { file: string; text: string; hash: string; }
let helperSourceCache: HelperSource | undefined;
/** The single Windows compilation unit. A missing source is a degradation trigger, never a silent failure. */
export function windowsHelperSource(): HelperSource {
  if (helperSourceCache !== undefined) return helperSourceCache;
  const file = fileURLToPath(new URL("../../native/windows/JobHost.cs", import.meta.url));
  let text: string;
  try {
    if (!statSync(file).isFile()) throw new PnpError("HOST_START_FAILED", "Windows supervisor source is not a file.", 503);
    text = readFileSync(file, "utf8");
  } catch (error: unknown) {
    if (error instanceof PnpError) throw error;
    throw new PnpError("HOST_START_FAILED", "Windows supervisor source is unavailable.", 503);
  }
  helperSourceCache = { file, text, hash: createHash("sha256").update(text).digest("hex") };
  return helperSourceCache;
}
/** Compiled-artifact cache keyed by source hash; a missing directory only costs an in-memory compile. */
export async function helperCacheDirectory(dataDirectory: string): Promise<string | undefined> {
  const directory = path.join(dataDirectory, "cache");
  try { await mkdir(directory, { recursive: true }); return directory; }
  catch { return undefined; }
}
function powerShellQuote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
/** Execution policy and mark-of-the-web are bypassed by encoding the bootstrap, not by a .ps1 file. */
export function windowsHelperCommand(cacheDirectory: string | undefined): { executable: string; args: string[] } {
  const source = windowsHelperSource();
  const cache = cacheDirectory === undefined ? "" : path.join(cacheDirectory, `helper-${source.hash}.dll`);
  const temporary = cacheDirectory === undefined ? "" : path.join(cacheDirectory, `helper-${source.hash}.${randomUUID()}.tmp`);
  const bootstrap = [
    "$ErrorActionPreference='Stop'",
    "$refs=@('System.dll','System.Core.dll','System.Web.Extensions.dll')",
    `$src=${powerShellQuote(source.file)}`,
    `$cache=${powerShellQuote(cache)}`,
    `$tmp=${powerShellQuote(temporary)}`,
    "$ok=$false",
    "if ($cache.Length -gt 0) {",
    "  try { if ([IO.File]::Exists($cache)) { [void][Reflection.Assembly]::LoadFrom($cache); $ok=$true } } catch { $ok=$false }",
    "  if (-not $ok) {",
    "    try {",
    "      Add-Type -TypeDefinition ([IO.File]::ReadAllText($src)) -ReferencedAssemblies $refs -OutputAssembly $tmp -OutputType Library",
    "      try { [IO.File]::Move($tmp,$cache) } catch { }",
    "      if ([IO.File]::Exists($cache)) { [void][Reflection.Assembly]::LoadFrom($cache) } else { [void][Reflection.Assembly]::LoadFrom($tmp) }",
    "      $ok=$true",
    "    } catch { $ok=$false }",
    "  }",
    "}",
    "if (-not $ok) { Add-Type -TypeDefinition ([IO.File]::ReadAllText($src)) -ReferencedAssemblies $refs }",
    "[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)",
    "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)",
    "[PNP.JobHost]::Run()",
  ].join("\n");
  return {
    executable: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
      Buffer.from(bootstrap, "utf16le").toString("base64")],
  };
}
function system32(tool: string): string {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", tool);
}

interface OwnershipRecord {
  hostId: string;
  sessionId: string;
  ownerToken: string;
  parentPid: number;
  generation: number;
  jobName: string;
  platform: string;
  /** "job": a Windows Job Object or a POSIX process group owns the tree. "degraded": no container exists. */
  mode: "job" | "degraded";
  helperPid: number;
  enginePid: number;
  imageName: string;
  windowsSessionId: number | null;
  quiescent: boolean;
}

export class LocalProcessHost implements ProcessHost {
  private readonly directory: string;
  private readonly dataDirectory: string;
  private readonly timeoutMs: number;
  private readonly graceMs: number;
  constructor(dataDirectory: string, timeoutMs = 10_000, graceMs = 3_000) {
    this.dataDirectory = dataDirectory;
    this.directory = path.join(dataDirectory, "hosts");
    this.timeoutMs = timeoutMs;
    this.graceMs = graceMs;
  }
  /** Seam: the Windows state machine is exercised without a Windows kernel. */
  protected get hostPlatform(): NodeJS.Platform { return process.platform; }
  protected async helper(): Promise<ChildProcessWithoutNullStreams> {
    const command = windowsHelperCommand(await helperCacheDirectory(this.dataDirectory));
    return spawn(command.executable, command.args, { env: baseEnvironment(), windowsHide: true, shell: false, stdio: "pipe" });
  }
  /** Seam: every Windows fallback runs through one auditable command runner. */
  protected runTool(file: string, args: readonly string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try { child = spawn(file, [...args], { env: baseEnvironment(), windowsHide: true, shell: false, stdio: "pipe" }); }
      catch { resolve({ code: null, stdout: "" }); return; }
      let stdout = "";
      let settled = false;
      const timer = setTimeout(() => { child.kill(); finish(null); }, timeoutMs);
      function finish(code: number | null): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout });
      }
      child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 64 * 1024) stdout += chunk.toString("utf8"); });
      child.stderr.resume();
      child.on("error", () => finish(null));
      child.on("close", (code) => finish(code));
    });
  }
  /** undefined means "tasklist could not answer": unknown liveness never becomes stop evidence. */
  protected async pidPresent(pid: number): Promise<boolean | undefined> {
    const result = await this.runTool(system32("tasklist.exe"), ["/FI", `PID eq ${pid}`, "/NH"], this.timeoutMs);
    if (result.code !== 0) return undefined;
    return new RegExp(`(^|[^0-9])${pid}([^0-9]|$)`).test(result.stdout);
  }
  protected async pidImageName(pid: number): Promise<string | undefined> {
    const result = await this.runTool(system32("tasklist.exe"), ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], this.timeoutMs);
    if (result.code !== 0) return undefined;
    const match = /"([^"]*)","(\d+)"/.exec(result.stdout);
    if (match === null || Number(match[2]) !== pid) return undefined;
    return match[1];
  }
  /** Only ever by process id and never by image name, per the ownership rules. */
  protected async killTree(pid: number): Promise<boolean | undefined> {
    await this.runTool(system32("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], this.timeoutMs);
    const present = await this.pidPresent(pid);
    return present === undefined ? undefined : !present;
  }
  async start(spec: LaunchSpec, signal: AbortSignal, resources: ResourceScope): Promise<HostedProcess> {
    const platform = this.hostPlatform;
    if (signal.aborted || resources?.closed) throw new PnpError("EXECUTION_CANCELLED", "Process launch was cancelled.", 409);
    if (!path.isAbsolute(spec.executable) || !path.isAbsolute(spec.cwd)) throw new PnpError("VALIDATION_ERROR", "Process executable and cwd must be absolute.", 400);
    if (platform === "win32" && !spec.executable.toLowerCase().endsWith(".exe")) {
      throw new PnpError("VALIDATION_ERROR", "Resolve npm shims to a real executable or node.exe plus a JS entrypoint.", 400);
    }
    const hostId = randomUUID();
    const generation = Date.now();
    const jobName = `Local\\PNP-${hostId}`;
    const graceMs = this.graceMs;
    const redactor = new Redactor(Object.entries(spec.env).flatMap(([key, value]) => secretishKey.test(key) ? [value] : []));
    const listeners = new Set<(frame: string) => void>();
    const exitListeners = new Set<(exit: { code: number | null; signal: string | null }) => void>();
    const buffered: string[] = [];
    let bufferedBytes = 0;
    let child: ChildProcessWithoutNullStreams | undefined;
    let wiring: "helper" | "direct" = platform === "win32" ? "helper" : "direct";
    /** A degraded relaunch must never let the abandoned supervisor's events rewrite live state. */
    let epoch = 0;
    let exited = deferred<{ code: number | null; signal: string | null }>();
    let ready = deferred<void>();
    void ready.promise.catch(() => undefined); // Startup failures can arrive before the awaited handshake.
    let engineDecoder = new JsonlDecoder();
    let helperDecoder = new JsonlDecoder();
    let exitValue: { code: number | null; signal: string | null } | undefined;
    let reportedExit: { code: number | null; signal: string | null } | undefined;
    let evidence = false;
    /** Set once the supervisor states the job's condition. An explicit negative is a finding, not an absence. */
    let supervisorStop: boolean | undefined;
    let hardKill = false;
    let stopPromise: Promise<StopEvidence> | undefined;
    /** Monotonic. A requested stop blocks writes forever; retryability lives in stopPromise alone. */
    let stopRequested = false;
    let provenStop: StopEvidence | undefined;
    let launching = true;
    let launchSent = wiring !== "helper";
    let launchCommitted = wiring !== "helper";
    let helperErrorSeen = false;
    let drainIncomplete = false;
    let abortRequested = false;
    let decoderFailure: PnpError | undefined;
    const tail: { text: string; bytes: number }[] = [];
    let tailBytes = 0;
    const note = (text: string): void => {
      if (text.length === 0) return;
      const capped = Buffer.byteLength(text) > diagnosticLimitBytes ? text.slice(-diagnosticLimitBytes) : text;
      const bytes = Buffer.byteLength(capped);
      tail.push({ text: capped, bytes });
      tailBytes += bytes;
      while (tailBytes > diagnosticLimitBytes && tail.length > 1) tailBytes -= tail.shift()!.bytes;
    };
    const diagnostics = (): string => {
      const merged = redactor.text(tail.map((entry) => entry.text).join("")).trim();
      return merged.length === 0 ? "" : ` Diagnostics: ${merged.slice(-2048)}`;
    };
    const record: OwnershipRecord = { hostId, sessionId: spec.sessionId, ownerToken: spec.ownerToken, parentPid: process.pid,
      generation, jobName, platform, mode: "job", helperPid: 0, enginePid: 0,
      imageName: wiring === "helper" ? "powershell.exe" : path.basename(spec.executable),
      windowsSessionId: null, quiescent: false };
    const recordPath = path.join(this.directory, `${hostId}.json`);
    let saveTail = Promise.resolve();
    const save = (): Promise<void> => {
      const serialized = JSON.stringify(record);
      const temporary = path.join(this.directory, `${hostId}.${randomUUID()}.tmp`);
      const publish = async () => {
        let handle: FileHandle | undefined;
        try {
          handle = await open(temporary, "wx", 0o600);
          await handle.writeFile(serialized);
          await handle.sync();
          await handle.close();
          handle = undefined;
          await rename(temporary, recordPath);
        } finally {
          await handle?.close().catch(() => undefined);
          await unlink(temporary).catch(() => undefined);
        }
      };
      const attempt = saveTail.catch(() => undefined).then(publish);
      saveTail = attempt;
      return attempt;
    };
    const dispatch = (frame: string) => {
      if (listeners.size === 0) {
        bufferedBytes += Buffer.byteLength(frame);
        if (bufferedBytes > 256 * 1024) throw new PnpError("HOST_BACKPRESSURE", "Consumer did not subscribe to process output.", 502);
        buffered.push(frame);
      } else for (const listener of listeners) listener(frame);
    };
    const reportExit = (value: { code: number | null; signal: string | null }) => {
      if (reportedExit !== undefined) return;
      reportedExit = value;
      for (const listener of exitListeners) listener(value);
    };
    const settle = async (): Promise<StopEvidence> => {
      const owned = child;
      if (owned === undefined) return { quiescent: !launching, method: "not-running" };
      const pid = owned.pid;
      if (pid === undefined) {
        // spawn() reports a process it could not create (ENOENT, EACCES) through "error" and never
        // assigns a pid; no "exit" follows. Nothing exists to wait for or to kill, so waiting on the
        // exit that cannot come would turn a missing executable into an unproven stop and fence the
        // session for a process that was never there.
        launching = false;
        evidence = true;
        record.quiescent = true;
        await save();
        return { quiescent: true, method: "not-running" };
      }
      if (exitValue === undefined) {
        // Phase one: a real end-of-file so the engine can finish writing an Office document,
        // then the grace window the supervisor honours before it destroys the job.
        if (wiring === "helper") {
          if (!launchSent) { hardKill = true; owned.kill(); }
          else try { await bounded(controlWrite(owned, { type: "terminate", graceMs }), this.timeoutMs); }
          catch { hardKill = true; owned.kill(); }
        } else {
          try { owned.stdin.end(); } catch { note("[pnp] standard input could not be closed before termination\n"); }
        }
        try { await bounded(exited.promise, graceMs + this.timeoutMs); }
        catch {
          // Phase two: stop the container. Killing the helper closes the job handle it alone owns.
          hardKill = true;
          if (platform === "win32") owned.kill();
          else try { if (pid !== undefined) process.kill(-pid, "SIGTERM"); } catch { note("[pnp] process group did not accept SIGTERM\n"); }
          try { await bounded(exited.promise, this.timeoutMs); }
          catch {
            if (platform !== "win32") {
              try { if (pid !== undefined) process.kill(-pid, "SIGKILL"); } catch { note("[pnp] process group did not accept SIGKILL\n"); }
              try { await bounded(exited.promise, this.timeoutMs); }
              catch { return { quiescent: false, method: "process-tree" }; }
            } else {
              // Phase three: by process id only. Killing by image name is forbidden.
              const killed = pid === undefined ? undefined : await this.killTree(pid);
              if (killed !== true) return { quiescent: false, method: "process-tree" };
              record.quiescent = true;
              await save();
              return { quiescent: true, method: "process-tree" };
            }
          }
        }
      }
      if (platform !== "win32") {
        if (record.mode === "job") {
          try { if (pid !== undefined) process.kill(-pid, 0); evidence = false; }
          catch (e) { evidence = e instanceof Error && "code" in e && e.code === "ESRCH"; }
        } else evidence = pid === undefined || !alive(pid);
      } else if (!evidence) {
        // The supervisor is the only component that can see inside the job. When it reported that the
        // job still had members, its own later absence is not permission to call the tree stopped.
        if (supervisorStop === false) return { quiescent: false, method: "process-tree" };
        if (!launchCommitted && wiring === "helper") evidence = true;
        else if (record.mode === "degraded") {
          const present = pid === undefined ? false : await this.pidPresent(pid);
          evidence = present === false;
        } else evidence = (await this.reconcile(record as unknown as Json)).quiescent;
      }
      record.quiescent = evidence;
      await save();
      return { quiescent: evidence, method: evidence && !hardKill ? "protocol" : "process-tree" };
    };
    const terminate = (): Promise<StopEvidence> => {
      stopRequested = true; // Written before any await: a requested stop can never re-open the channel.
      if (provenStop !== undefined) return Promise.resolve(provenStop);
      if (stopPromise !== undefined) return stopPromise;
      const attempt = settle();
      stopPromise = attempt;
      void attempt.then((result) => {
        if (result.quiescent) provenStop = result; // Only proven quiescence is cached.
        if (stopPromise === attempt) stopPromise = undefined;
      }, () => {
        if (stopPromise === attempt) stopPromise = undefined;
      });
      return attempt;
    };
    resources?.register(hostId, terminate);
    const wire = (owned: ChildProcessWithoutNullStreams): void => {
      const era = epoch;
      const live = (): boolean => era === epoch;
      owned.on("error", () => { if (live()) ready.reject(new PnpError("HOST_START_FAILED", `Process could not be started.${diagnostics()}`, 503)); });
      owned.stdin.on("error", () => {
        if (!live()) return;
        const failure = new PnpError(launching ? "HOST_START_FAILED" : "HOST_EXITED",
          `Process control channel failed.${diagnostics()}`, launching ? 503 : 502);
        ready.reject(failure);
        if (!launching) {
          decoderFailure = failure;
          reportExit({ code: null, signal: failure.code });
          void terminate().catch(() => undefined);
        }
      });
      // Exit is the process lifetime. Stream close only means the last pipe writer let go.
      owned.on("exit", (code, sig) => {
        if (!live()) return;
        launching = false;
        exitValue = { code, signal: sig };
        exited.resolve(exitValue);
        ready.reject(new PnpError("HOST_EXITED", `Process exited during startup.${diagnostics()}`, 502));
        if (wiring === "helper") reportExit({ code: null, signal: decoderFailure?.code ?? "HOST_FAILURE" });
        else reportExit(decoderFailure === undefined ? exitValue : { code: null, signal: decoderFailure.code });
      });
      owned.stdout.on("data", (chunk: Buffer) => {
        if (!live()) return;
        try {
          if (wiring !== "helper") { for (const line of engineDecoder.push(chunk)) dispatch(line); return; }
          for (const frame of helperDecoder.push(chunk)) {
            const event = JSON.parse(frame) as { type: string; data?: string; code?: number; pid?: number;
              quiescent?: boolean; drained?: boolean; phase?: string; windowsSessionId?: number };
            if (event.type === "prepared") {
              if (!Number.isInteger(event.windowsSessionId)) throw new PnpError("HOST_FAILURE", "Windows supervisor identity is missing.", 503);
              record.windowsSessionId = event.windowsSessionId!;
              void save().then(async () => {
                if (abortRequested || signal.aborted) await controlWrite(owned, { type: "terminate", graceMs: 0 });
                else { launchCommitted = true; await controlWrite(owned, { type: "proceed" }); }
              }).catch(() => {
                ready.reject(new PnpError("HOST_FAILURE", "Windows supervisor identity could not be recorded.", 503));
                void terminate().catch(() => undefined);
              });
            }
            else if (event.type === "ready") {
              if (!launchCommitted || !Number.isInteger(event.windowsSessionId) || event.windowsSessionId !== record.windowsSessionId)
                throw new PnpError("HOST_FAILURE", "Windows supervisor identity changed during launch.", 503);
              if (Number.isInteger(event.pid) && event.pid! > 0) { record.enginePid = event.pid!; void save().catch(() => undefined); }
              launching = false;
              ready.resolve();
            }
            else if (event.type === "stdout") for (const line of engineDecoder.push(Buffer.from(event.data!, "base64"))) dispatch(line);
            else if (event.type === "stderr") note(Buffer.from(event.data!, "base64").toString("utf8"));
            else if (event.type === "exit") {
              // Quiescence and drain are independent: an undrained pipe is not an engine protocol violation.
              evidence = event.quiescent === true;
              supervisorStop = evidence;
              if (event.drained !== true) {
                drainIncomplete = true;
                note("[pnp] supervisor output pump did not drain before exit\n");
              }
              const engineExit = supervisorEngineExit(event);
              if (engineExit !== undefined) reportExit(engineExit);
              else reportExit({ code: null, signal: "HOST_FAILURE" });
            }
            else if (event.type === "error") {
              helperErrorSeen = true;
              if (typeof event.phase === "string") note(`[pnp] supervisor failed in phase ${event.phase}\n`);
              ready.reject(new PnpError("HOST_FAILURE", `Windows supervisor failed.${diagnostics()}`, 503));
            }
          }
        } catch { ready.reject(new PnpError("ENGINE_PROTOCOL_ERROR", "Invalid process framing.", 502)); void terminate().catch(() => undefined); }
      });
      // end() runs on every production path, so a truncated tail frame can never be dropped silently.
      owned.stdout.on("end", () => {
        if (!live()) return;
        try {
          helperDecoder.end();
          if (drainIncomplete) { const pending = engineDecoder.discard(); if (pending.trim().length > 0) note("[pnp] discarded an undrained trailing frame\n"); }
          else engineDecoder.end();
        } catch {
          decoderFailure = new PnpError("ENGINE_PROTOCOL_ERROR", "Invalid process framing.", 502);
          ready.reject(decoderFailure);
        }
      });
      owned.stderr.on("data", (chunk: Buffer) => { if (live()) note(chunk.toString("utf8")); });
      if (wiring !== "helper") owned.once("spawn", () => { if (!live()) return; launching = false; ready.resolve(); });
    };
    const resetAttempt = (): void => {
      epoch++;
      exited = deferred<{ code: number | null; signal: string | null }>();
      ready = deferred<void>();
      void ready.promise.catch(() => undefined);
      engineDecoder = new JsonlDecoder();
      helperDecoder = new JsonlDecoder();
      exitValue = undefined;
      decoderFailure = undefined;
      drainIncomplete = false;
      helperErrorSeen = false;
      hardKill = false;
      launching = true;
      evidence = false;
      record.quiescent = false;
    };
    const spawnDirect = (): ChildProcessWithoutNullStreams => spawn(spec.executable, [...spec.args], {
      cwd: spec.cwd, env: { ...baseEnvironment(), ...spec.env }, shell: false,
      detached: platform !== "win32", stdio: "pipe",
    });
    const onAbort = () => { abortRequested = true; void terminate().catch(() => undefined); };
    const registerRecord = async (): Promise<void> => {
      record.helperPid = child?.pid ?? 0;
      record.mode = wiring === "helper" || platform !== "win32" ? "job" : "degraded";
      record.imageName = wiring === "helper" ? "powershell.exe" : path.basename(spec.executable);
      if (wiring !== "helper") record.enginePid = child?.pid ?? 0;
      await save();
    };
    try {
      await mkdir(this.directory, { recursive: true });
      await save(); // The ownership record exists before CreateProcess/spawn.
      if (signal.aborted || resources?.closed) throw new PnpError("EXECUTION_CANCELLED", "Launch cancelled.", 409);
      if (wiring === "helper") {
        try { child = await this.helper(); }
        catch (error: unknown) {
          // The supervisor could not even start: degrade rather than refuse to run the round.
          note(`[pnp] windows supervisor unavailable: ${error instanceof Error ? error.message : "unknown"}\n`);
          wiring = "direct";
          launchSent = true;
          launchCommitted = true;
          child = spawnDirect();
        }
      } else child = spawnDirect();
    } catch (error: unknown) {
      // A synchronous pre-spawn failure proves that no process was created.
      if (child === undefined) {
        launching = false;
        evidence = true;
        record.quiescent = true;
        await save().catch(() => undefined);
      }
      if (error instanceof PnpError) throw error;
      throw new PnpError("HOST_START_FAILED", `Process could not be started.${diagnostics()}`, 503);
    }
    signal.addEventListener("abort", onAbort, { once: true });
    wire(child);
    await registerRecord();
    const cancelled = (): boolean => signal.aborted || abortRequested || resources?.closed === true;
    const handshake = async (): Promise<void> => {
      if (wiring === "helper") {
        if (cancelled()) { await terminate(); throw new PnpError("EXECUTION_CANCELLED", "Launch was cancelled.", 409); }
        try {
          await controlWrite(child!, { operation: "launch", jobName, executable: spec.executable, args: spec.args,
            cwd: spec.cwd, env: { ...baseEnvironment(), ...spec.env }, parentPid: process.pid, graceMs });
          launchSent = true;
        } catch {
          await terminate().catch(() => undefined);
          if (cancelled()) throw new PnpError("EXECUTION_CANCELLED", "Launch was cancelled.", 409);
          throw new PnpError("HOST_START_FAILED", `Process control channel failed during startup.${diagnostics()}`, 503);
        }
      }
      if (cancelled()) onAbort();
      // A handshake deadline is the most common way a broken engine reports itself. Carry the
      // captured diagnostic tail out with it; a bare timeout tells an operator nothing.
      try { await bounded(ready.promise, this.timeoutMs + graceMs); }
      catch (error: unknown) {
        if (error instanceof PnpError && error.code === "EXECUTION_CANCELLED") throw error;
        const detail = diagnostics();
        if (detail === "" || (error instanceof PnpError && error.message.includes("Diagnostics:"))) throw error;
        const code = error instanceof PnpError && error.code.startsWith("HOST_") ? error.code : "HOST_START_FAILED";
        const status = error instanceof PnpError ? error.status : 503;
        const message = error instanceof PnpError ? error.message : "Process did not complete its handshake.";
        throw new PnpError(code, `${message}${detail}`, status);
      }
    };
    try { await handshake(); }
    catch (error: unknown) {
      // Cancellation outranks the host exit it caused; the caller must see 409, not 502.
      // Degrade on any supervisor failure, including one raised while creating the engine: a policy
      // that blocks CreateProcess from PowerShell may still allow it here, and refusing to try costs
      // the whole round. The supervisor's own phase stays in the diagnostics either way, so the
      // second attempt replaces neither the diagnosis nor the evidence.
      const canDegrade = platform === "win32" && wiring === "helper" && !cancelled() && (helperErrorSeen || !launchCommitted);
      await terminate().catch(() => undefined);
      if (cancelled()) throw new PnpError("EXECUTION_CANCELLED", "Launch was cancelled.", 409);
      if (!canDegrade) throw error;
      note("[pnp] windows job supervisor failed before the engine existed; continuing without a job object\n");
      signal.removeEventListener("abort", onAbort);
      child?.kill();
      wiring = "direct";
      launchSent = true;
      launchCommitted = true;
      stopPromise = undefined;
      provenStop = undefined;
      stopRequested = false;
      resetAttempt();
      try { child = spawnDirect(); }
      catch {
        launching = false;
        evidence = true;
        record.quiescent = true;
        await save().catch(() => undefined);
        throw new PnpError("HOST_START_FAILED", `Process could not be started.${diagnostics()}`, 503);
      }
      signal.addEventListener("abort", onAbort, { once: true });
      wire(child);
      await registerRecord();
      try { await handshake(); }
      catch (fallbackError: unknown) {
        await terminate().catch(() => undefined);
        if (cancelled()) throw new PnpError("EXECUTION_CANCELLED", "Launch was cancelled.", 409);
        // A spawn that never produced a process id created nothing, so the record must say so
        // outright. Leaving it unproven contradicts reconciliation, which already reads a record
        // without an owner as stopped, and an unproven record is the one thing that fences a
        // session on the next start.
        if (child?.pid === undefined && !evidence) {
          evidence = true;
          record.quiescent = true;
          await save().catch(() => undefined);
        }
        throw fallbackError;
      }
    }
    signal.removeEventListener("abort", onAbort); // Launch cancellation ends at handshake; run cancellation is protocol-first.
    if (cancelled()) { await terminate(); throw new PnpError("EXECUTION_CANCELLED", "Launch was cancelled.", 409); }
    const running = child;
    const runningWiring = wiring;
    return {
      hostId, generation,
      write: async (frame) => {
        if (stopRequested) throw new PnpError("HOST_EXITED", `Process was asked to stop; the channel stays blocked.${diagnostics()}`, 502);
        if (exitValue !== undefined) throw new PnpError("HOST_EXITED", `Process is unavailable.${diagnostics()}`, 502);
        if (Buffer.byteLength(frame) > 4 * 1024 * 1024) throw new PnpError("FRAME_TOO_LARGE", "Outgoing frame is too large.", 400);
        try {
          if (runningWiring === "helper") await controlWrite(running, { type: "write", data: Buffer.from(`${frame}\n`).toString("base64") });
          else await new Promise<void>((resolve, reject) => running.stdin.write(`${frame}\n`, (error) => error ? reject(error) : resolve()));
        } catch { throw new PnpError("HOST_EXITED", `Process control channel is unavailable.${diagnostics()}`, 502); }
      },
      onFrame: (listener) => { listeners.add(listener); const frames = buffered.splice(0); bufferedBytes = 0; for (const frame of frames) listener(frame); return () => { listeners.delete(listener); }; },
      onExit: (listener) => { exitListeners.add(listener); if (reportedExit !== undefined) listener(reportedExit); return () => { exitListeners.delete(listener); }; },
      terminate,
    };
  }
  /**
   * Evidence is ordered cheapest-first and stops at the first conclusive answer. A missing Windows
   * session id degrades the verdict instead of vetoing it: an unverifiable record would otherwise
   * outlive every future round.
   */
  async reconcile(previous: Json): Promise<StopEvidence> {
    const platform = this.hostPlatform;
    if (previous === null || typeof previous !== "object" || Array.isArray(previous)) return { quiescent: false, method: "process-tree" };
    const value = previous as { hostId?: Json; sessionId?: Json; ownerToken?: Json; parentPid?: Json; generation?: Json;
      jobName?: Json; helperPid?: Json; enginePid?: Json; imageName?: Json; mode?: Json;
      platform?: Json; windowsSessionId?: Json; quiescent?: Json };
    const validRecord = typeof value.hostId === "string" && value.hostId.length > 0
      && typeof value.sessionId === "string" && value.sessionId.length > 0
      && typeof value.ownerToken === "string" && value.ownerToken.length > 0
      && typeof value.parentPid === "number" && Number.isSafeInteger(value.parentPid) && value.parentPid > 0
      && typeof value.generation === "number" && Number.isSafeInteger(value.generation) && value.generation > 0
      && typeof value.helperPid === "number" && Number.isSafeInteger(value.helperPid) && value.helperPid >= 0
      && typeof value.quiescent === "boolean";
    if (!validRecord) return { quiescent: false, method: "process-tree" };
    const hostId = value.hostId as string;
    const helperPid = value.helperPid as number;
    const generation = value.generation as number;
    if (value.platform !== platform) return { quiescent: false, method: "process-tree" };
    if (platform === "win32" && value.jobName !== `Local\\PNP-${hostId}`) return { quiescent: false, method: "process-tree" };
    // 1. Durable stop evidence is stronger than any later liveness probe.
    if (value.quiescent === true) return { quiescent: true, method: "not-running" };
    // 2. A process recorded before this boot cannot still be running.
    if (generation < bootTimeMs()) return { quiescent: true, method: "not-running" };
    // 3. A record whose owner was never spawned describes no process at all.
    if (helperPid <= 0) return { quiescent: true, method: "not-running" };
    if (platform !== "win32") {
      if (alive(helperPid)) return { quiescent: false, method: "process-tree" };
      try { process.kill(-helperPid, 0); return { quiescent: false, method: "process-tree" }; }
      catch (e) { return { quiescent: e instanceof Error && "code" in e && e.code === "ESRCH", method: "process-tree" }; }
    }
    // 4. A dead supervisor already closed the job handle, and kill-on-close is unconditional.
    // The process list is the authority here: a local signal probe cannot see across Windows
    // sessions, and an unanswered probe never becomes stop evidence on its own.
    const present = await this.pidPresent(helperPid);
    if ((present ?? alive(helperPid)) === false) return { quiescent: true, method: "process-tree" };
    // 5. A live process id proves nothing until its image name matches what was recorded.
    const expectedImage = typeof value.imageName === "string" && value.imageName.length > 0
      ? value.imageName : (value.mode === "degraded" ? undefined : "powershell.exe");
    if (expectedImage !== undefined) {
      const actual = await this.pidImageName(helperPid);
      if (actual !== undefined && actual.toLowerCase() !== expectedImage.toLowerCase()) {
        return { quiescent: true, method: "not-running" }; // The process id was reused.
      }
    }
    // A degraded record has no job to inspect; the owned root process is the whole evidence.
    if (value.mode === "degraded") return { quiescent: false, method: "process-tree" };
    // 6. Only a genuinely live supervisor is worth an inspection.
    let helper: ChildProcessWithoutNullStreams;
    try { helper = await this.helper(); }
    catch { return { quiescent: false, method: "process-tree" }; }
    const result = deferred<{ quiescent: boolean; windowsSessionId?: number }>();
    const decoder = new JsonlDecoder();
    const jobName = value.jobName as string;
    helper.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) {
          const event = JSON.parse(frame) as { type?: string; quiescent?: boolean; windowsSessionId?: number;
            results?: { jobName?: string; quiescent?: boolean }[] };
          if (event.type !== "inspection") continue;
          const entry = event.results?.find((item) => item.jobName === jobName);
          result.resolve({ quiescent: (entry === undefined ? event.quiescent : entry.quiescent) === true,
            windowsSessionId: event.windowsSessionId });
        }
      } catch { result.resolve({ quiescent: false }); }
    });
    helper.stderr.resume();
    helper.stdin.on("error", () => result.resolve({ quiescent: false }));
    helper.on("error", () => result.resolve({ quiescent: false }));
    helper.on("exit", () => result.resolve({ quiescent: false }));
    try {
      await controlWrite(helper, { operation: "inspect", jobNames: [jobName] });
      helper.stdin.end();
      const inspected = await bounded(result.promise, this.timeoutMs);
      const recorded = value.windowsSessionId;
      // Degrade, do not veto: a record written before the handshake has no session id to compare.
      const sessionMatches = typeof recorded !== "number" || !Number.isInteger(inspected.windowsSessionId)
        || inspected.windowsSessionId === recorded;
      return { quiescent: inspected.quiescent && sessionMatches, method: "process-tree" };
    } catch { return { quiescent: false, method: "process-tree" }; }
    finally { helper.kill(); }
  }
}
