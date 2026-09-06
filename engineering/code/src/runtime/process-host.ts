import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HostedProcess, LaunchSpec, ProcessHost } from "../contracts/host.ts";
import type { Json, ResourceScope, StopEvidence } from "../contracts/index.ts";
import { PnpError } from "../core/errors.ts";
import { bounded, deferred } from "./deadline.ts";
import { JsonlDecoder } from "./jsonl.ts";

const systemKeys = ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "HOME", "LOCALAPPDATA", "APPDATA", "COMSPEC"];
export function baseEnvironment(): Record<string, string> {
  return Object.fromEntries(systemKeys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
}
function controlWrite(child: ChildProcessWithoutNullStreams, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => child.stdin.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : resolve()));
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return !(e instanceof Error && "code" in e && e.code === "ESRCH"); } }
export function supervisorEngineExit(event: unknown): { code: number | null; signal: string | null } | undefined {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return undefined;
  const value = event as { type?: unknown; code?: unknown };
  if (value.type !== "exit" || (value.code !== null && typeof value.code !== "number")) return undefined;
  return { code: value.code as number | null, signal: null };
}

export class LocalProcessHost implements ProcessHost {
  private readonly directory: string;
  private readonly timeoutMs: number;
  constructor(dataDirectory: string, timeoutMs = 10_000) { this.directory = path.join(dataDirectory, "hosts"); this.timeoutMs = timeoutMs; }
  async start(spec: LaunchSpec, signal: AbortSignal, resources: ResourceScope): Promise<HostedProcess> {
    if (signal.aborted || resources?.closed) throw new PnpError("EXECUTION_CANCELLED", "Process launch was cancelled.", 409);
    if (!path.isAbsolute(spec.executable) || !path.isAbsolute(spec.cwd)) throw new PnpError("VALIDATION_ERROR", "Process executable and cwd must be absolute.", 400);
    if (process.platform === "win32" && !spec.executable.toLowerCase().endsWith(".exe")) {
      throw new PnpError("VALIDATION_ERROR", "Resolve npm shims to a real executable or node.exe plus a JS entrypoint.", 400);
    }
    const hostId = randomUUID();
    const generation = Date.now();
    const jobName = `Local\\PNP-${hostId}`;
    const exited = deferred<{ code: number | null; signal: string | null }>();
    const ready = deferred<void>();
    void ready.promise.catch(() => undefined); // Startup failures can arrive before the awaited handshake.
    const listeners = new Set<(frame: string) => void>();
    const exitListeners = new Set<(exit: { code: number | null; signal: string | null }) => void>();
    const buffered: string[] = [];
    let bufferedBytes = 0;
    let child: ChildProcessWithoutNullStreams | undefined;
    let exitValue: { code: number | null; signal: string | null } | undefined;
    let reportedExit: { code: number | null; signal: string | null } | undefined;
    let evidence = false;
    let stopPromise: Promise<StopEvidence> | undefined;
    let launching = true;
    let launchSent = process.platform !== "win32";
    let launchCommitted = process.platform !== "win32";
    let abortRequested = false;
    let decoderFailure: PnpError | undefined;
    const engineDecoder = new JsonlDecoder();
    const helperDecoder = new JsonlDecoder();
    const record = { hostId, sessionId: spec.sessionId, ownerToken: spec.ownerToken, parentPid: process.pid,
      generation, jobName, platform: process.platform, helperPid: 0, windowsSessionId: null as number | null, quiescent: false };
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
    const terminate = (): Promise<StopEvidence> => {
      if (stopPromise !== undefined) return stopPromise;
      const attempt = (async () => {
        if (child === undefined) return { quiescent: !launching, method: "not-running" as const };
        if (exitValue === undefined) {
          if (process.platform === "win32") {
            if (!launchSent) child.kill();
            else try { await bounded(controlWrite(child, { type: "terminate" }), this.timeoutMs); } catch { child.kill(); }
          } else {
            try { if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM"); } catch { }
          }
          try { await bounded(exited.promise, this.timeoutMs); }
          catch {
            if (process.platform === "win32") {
              // Killing only the owned helper closes its non-inherited Job Object handle.
              child.kill();
            } else { try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { } }
            try { await bounded(exited.promise, this.timeoutMs); } catch { return { quiescent: false, method: "process-tree" as const }; }
          }
        }
        if (process.platform !== "win32") {
          try { if (child.pid !== undefined) process.kill(-child.pid, 0); evidence = false; }
          catch (e) { evidence = e instanceof Error && "code" in e && e.code === "ESRCH"; }
        } else if (!evidence) {
          evidence = !launchCommitted || (await this.reconcile(record as unknown as Json)).quiescent;
        }
        record.quiescent = evidence;
        await save();
        return { quiescent: evidence, method: "process-tree" as const };
      })();
      stopPromise = attempt;
      void attempt.then((result) => {
        if (!result.quiescent && stopPromise === attempt) stopPromise = undefined;
      }, () => {
        if (stopPromise === attempt) stopPromise = undefined;
      });
      return attempt;
    };
    resources?.register(hostId, terminate);
    try {
      await mkdir(this.directory, { recursive: true });
      await save(); // The ownership record exists before CreateProcess/spawn.
      if (signal.aborted || resources?.closed) throw new PnpError("EXECUTION_CANCELLED", "Launch cancelled.", 409);
      if (process.platform === "win32") {
        child = this.helper();
      } else {
        child = spawn(spec.executable, [...spec.args], { cwd: spec.cwd, env: { ...baseEnvironment(), ...spec.env }, shell: false, detached: true, stdio: "pipe" });
      }
    } catch (error: unknown) {
      // A synchronous pre-spawn failure proves that no process was created.
      if (child === undefined) {
        launching = false;
        evidence = true;
        record.quiescent = true;
        await save().catch(() => undefined);
      }
      if (error instanceof PnpError) throw error;
      throw new PnpError("HOST_START_FAILED", "Process could not be started.", 503);
    }
    record.helperPid = child.pid ?? 0;
    const onAbort = () => { abortRequested = true; void terminate().catch(() => undefined); };
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => { ready.reject(new PnpError("HOST_START_FAILED", "Process could not be started.", 503)); });
    child.stdin.on("error", () => {
      const failure = new PnpError(launching ? "HOST_START_FAILED" : "HOST_EXITED",
        "Process control channel failed.", launching ? 503 : 502);
      ready.reject(failure);
      if (!launching) {
        decoderFailure = failure;
        reportExit({ code: null, signal: failure.code });
        void terminate().catch(() => undefined);
      }
    });
    child.on("close", (code, sig) => {
      launching = false;
      signal.removeEventListener("abort", onAbort);
      exitValue = { code, signal: sig };
      exited.resolve(exitValue);
      ready.reject(new PnpError("HOST_EXITED", "Process exited during startup.", 502));
      if (process.platform === "win32") reportExit({ code: null, signal: decoderFailure?.code ?? "HOST_FAILURE" });
      else reportExit(decoderFailure === undefined ? exitValue : { code: null, signal: decoderFailure.code });
    });
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        if (process.platform !== "win32") { for (const line of engineDecoder.push(chunk)) dispatch(line); return; }
        for (const frame of helperDecoder.push(chunk)) {
          const event = JSON.parse(frame) as { type: string; data?: string; quiescent?: boolean; drained?: boolean; windowsSessionId?: number };
          if (event.type === "prepared") {
            if (!Number.isInteger(event.windowsSessionId)) throw new PnpError("HOST_FAILURE", "Windows supervisor identity is missing.", 503);
            record.windowsSessionId = event.windowsSessionId!;
            void save().then(async () => {
              if (abortRequested || signal.aborted) await controlWrite(child!, { type: "terminate" });
              else { launchCommitted = true; await controlWrite(child!, { type: "proceed" }); }
            }).catch(() => {
              ready.reject(new PnpError("HOST_FAILURE", "Windows supervisor identity could not be recorded.", 503));
              void terminate().catch(() => undefined);
            });
          }
          else if (event.type === "ready") {
            if (!launchCommitted || !Number.isInteger(event.windowsSessionId) || event.windowsSessionId !== record.windowsSessionId)
              throw new PnpError("HOST_FAILURE", "Windows supervisor identity changed during launch.", 503);
            launching = false;
            ready.resolve();
          }
          else if (event.type === "stdout") for (const line of engineDecoder.push(Buffer.from(event.data!, "base64"))) dispatch(line);
          else if (event.type === "exit") {
            evidence = event.quiescent === true;
            try {
              if (event.drained !== true) throw new PnpError("ENGINE_PROTOCOL_ERROR", "Process output did not drain.", 502);
              engineDecoder.end();
              const engineExit = supervisorEngineExit(event);
              if (engineExit !== undefined) reportExit(engineExit);
            } catch {
              decoderFailure = new PnpError("ENGINE_PROTOCOL_ERROR", "Invalid process framing.", 502);
              reportExit({ code: null, signal: decoderFailure.code });
            }
          }
          else if (event.type === "error") ready.reject(new PnpError("HOST_FAILURE", "Windows supervisor failed.", 503));
          // stderr is consumed without persisting credentials. Adapters emit sanitized diagnostic events.
        }
      } catch { ready.reject(new PnpError("ENGINE_PROTOCOL_ERROR", "Invalid process framing.", 502)); void terminate().catch(() => undefined); }
    });
    child.stdout.on("end", () => {
      try {
        helperDecoder.end();
        if (process.platform !== "win32") engineDecoder.end();
      } catch {
        decoderFailure = new PnpError("ENGINE_PROTOCOL_ERROR", "Invalid process framing.", 502);
        ready.reject(decoderFailure);
      }
    });
    child.stderr.resume();
    if (process.platform !== "win32") child.once("spawn", () => { launching = false; ready.resolve(); });
    await save();
    if (process.platform === "win32") {
      if (abortRequested || signal.aborted) {
        await terminate();
        throw new PnpError("EXECUTION_CANCELLED", "Launch was cancelled.", 409);
      }
      try {
        await controlWrite(child, { operation: "launch", jobName, executable: spec.executable, args: spec.args,
          cwd: spec.cwd, env: { ...baseEnvironment(), ...spec.env }, parentPid: process.pid });
        launchSent = true;
      } catch (error: unknown) {
        await terminate().catch(() => undefined);
        if (abortRequested || signal.aborted) throw new PnpError("EXECUTION_CANCELLED", "Launch was cancelled.", 409);
        throw new PnpError("HOST_START_FAILED", "Process control channel failed during startup.", 503);
      }
    }
    if (signal.aborted || abortRequested) onAbort();
    try { await bounded(ready.promise, this.timeoutMs); }
    catch (error) { await terminate().catch(() => undefined); throw error; }
    signal.removeEventListener("abort", onAbort); // Launch cancellation ends at handshake; run cancellation is protocol-first.
    if (signal.aborted || abortRequested) { await terminate(); throw new PnpError("EXECUTION_CANCELLED", "Launch was cancelled.", 409); }
    const running = child;
    return {
      hostId, generation,
      write: async (frame) => {
        if (exitValue !== undefined || stopPromise !== undefined) throw new PnpError("HOST_EXITED", "Process is unavailable.", 502);
        if (Buffer.byteLength(frame) > 4 * 1024 * 1024) throw new PnpError("FRAME_TOO_LARGE", "Outgoing frame is too large.", 400);
        try {
          if (process.platform === "win32") await controlWrite(running, { type: "write", data: Buffer.from(`${frame}\n`).toString("base64") });
          else await new Promise<void>((resolve, reject) => running.stdin.write(`${frame}\n`, (error) => error ? reject(error) : resolve()));
        } catch { throw new PnpError("HOST_EXITED", "Process control channel is unavailable.", 502); }
      },
      onFrame: (listener) => { listeners.add(listener); const frames = buffered.splice(0); bufferedBytes = 0; for (const frame of frames) listener(frame); return () => { listeners.delete(listener); }; },
      onExit: (listener) => { exitListeners.add(listener); if (reportedExit !== undefined) listener(reportedExit); return () => { exitListeners.delete(listener); }; },
      terminate,
    };
  }
  private helper(): ChildProcessWithoutNullStreams {
    const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const source = fileURLToPath(new URL("../../native/windows/JobHost.cs", import.meta.url));
    try {
      if (!statSync(source).isFile()) throw new Error("not a file");
    } catch {
      throw new PnpError("HOST_START_FAILED", "Windows supervisor source is unavailable.", 503);
    }
    const quoted = source.replaceAll("'", "''");
    const bootstrap = `$ErrorActionPreference='Stop';$source=[IO.File]::ReadAllText('${quoted}');Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.dll','System.Core.dll','System.Web.Extensions.dll';[Console]::InputEncoding=New-Object Text.UTF8Encoding($false);[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);[PNP.JobHost]::Run()`;
    const encoded = Buffer.from(bootstrap, "utf16le").toString("base64");
    return spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { env: baseEnvironment(), windowsHide: true, shell: false, stdio: "pipe" });
  }
  async reconcile(previous: Json): Promise<StopEvidence> {
    if (previous === null || typeof previous !== "object" || Array.isArray(previous)) return { quiescent: false, method: "process-tree" };
    const value = previous as { hostId?: Json; sessionId?: Json; ownerToken?: Json; parentPid?: Json; generation?: Json;
      jobName?: Json; helperPid?: Json; platform?: Json; windowsSessionId?: Json; quiescent?: Json };
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
    if (value.platform !== process.platform) return { quiescent: false, method: "process-tree" };
    if (process.platform === "win32" && value.jobName !== `Local\\PNP-${hostId}`) return { quiescent: false, method: "process-tree" };
    // Durable stop evidence is stronger than later PID liveness: PIDs can be reused,
    // and a clean pre-spawn cancellation intentionally records helperPid=0.
    if (value.quiescent === true) return { quiescent: true, method: "process-tree" };
    if (helperPid <= 0 || alive(helperPid)) return { quiescent: false, method: "process-tree" };
    if (process.platform !== "win32") {
      try { process.kill(-helperPid, 0); return { quiescent: false, method: "process-tree" }; }
      catch (e) { return { quiescent: e instanceof Error && "code" in e && e.code === "ESRCH", method: "process-tree" }; }
    }
    const helper = this.helper();
    const result = deferred<{ quiescent: boolean; windowsSessionId?: number }>();
    const decoder = new JsonlDecoder();
    helper.stdout.on("data", (chunk: Buffer) => {
      try { for (const frame of decoder.push(chunk)) { const event = JSON.parse(frame); if (event.type === "inspection") result.resolve({ quiescent: event.quiescent === true, windowsSessionId: event.windowsSessionId }); } }
      catch { result.resolve({ quiescent: false }); }
    });
    helper.stderr.resume();
    helper.stdin.on("error", () => result.resolve({ quiescent: false }));
    helper.on("error", () => result.resolve({ quiescent: false }));
    helper.on("close", () => result.resolve({ quiescent: false }));
    try {
      await controlWrite(helper, { operation: "inspect", jobName: value.jobName });
      helper.stdin.end();
      const inspected = await bounded(result.promise, this.timeoutMs);
      return { quiescent: inspected.quiescent && typeof value.windowsSessionId === "number"
        && inspected.windowsSessionId === value.windowsSessionId, method: "process-tree" };
    } catch { return { quiescent: false, method: "process-tree" }; }
    finally { helper.kill(); }
  }
}
