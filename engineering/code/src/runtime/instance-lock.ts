import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, rename, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PnpError } from "../core/errors.ts";
import { bounded, deferred } from "./deadline.ts";
import { JsonlDecoder } from "./jsonl.ts";

/**
 * Conservative single-owner guard. Stale locks are never silently removed.
 * A validated recovery command must check owner identity and child quiescence.
 */
export async function acquireInstanceLock(path: string): Promise<() => Promise<void>> {
  let file: FileHandle;
  try { file = await open(path, "wx"); }
  catch { throw new PnpError("INSTANCE_LOCKED", "Data directory is already owned or requires explicit recovery.", 503); }
  await file.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await file.sync();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await file.close();
    await unlink(path);
  };
}

/** Windows process-lifetime ownership. The duplicated OS handles close only when this Node process exits. */
export async function acquireProcessLifetimeLock(directory: string, timeoutMs = 10_000): Promise<() => Promise<void>> {
  if (process.platform !== "win32") return acquireInstanceLock(path.join(directory, "gateway.lock"));
  const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const source = fileURLToPath(new URL("../../native/windows/InstanceGuard.cs", import.meta.url));
  const quoted = source.replaceAll("'", "''");
  const bootstrap = `$ErrorActionPreference='Stop';$source=[IO.File]::ReadAllText('${quoted}');Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.dll','System.Core.dll','System.Web.Extensions.dll';[Console]::InputEncoding=New-Object Text.UTF8Encoding($false);[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);[PNP.InstanceGuard]::Run()`;
  const encoded = Buffer.from(bootstrap, "utf16le").toString("base64");
  const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    env: Object.fromEntries(["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
    windowsHide: true, shell: false, stdio: "pipe",
  });
  const result = deferred<{ ok: boolean; code?: string; pid?: number; creationTime?: string }>();
  const decoder = new JsonlDecoder();
  child.stdout.on("data", (chunk: Buffer) => {
    try { for (const frame of decoder.push(chunk)) result.resolve(JSON.parse(frame)); }
    catch { result.resolve({ ok: false, code: "INSTANCE_GUARD_FAILED" }); }
  });
  child.stdout.on("end", () => { try { decoder.end(); } catch { result.resolve({ ok: false, code: "INSTANCE_GUARD_FAILED" }); } });
  child.stdin.on("error", () => result.resolve({ ok: false, code: "INSTANCE_GUARD_FAILED" }));
  child.stderr.resume();
  child.on("error", () => result.resolve({ ok: false, code: "INSTANCE_GUARD_FAILED" }));
  child.on("close", () => result.resolve({ ok: false, code: "INSTANCE_GUARD_FAILED" }));
  try {
    await new Promise<void>((resolve, reject) => child.stdin.write(`${JSON.stringify({ directory, pid: process.pid })}\n`, (error) => error ? reject(error) : resolve()));
    child.stdin.end();
    const grant = await bounded(result.promise, timeoutMs);
    if (!grant.ok || grant.pid !== process.pid || !/^\d+$/.test(grant.creationTime ?? "")) {
      throw new PnpError(grant.code === "INSTANCE_LOCKED" ? "INSTANCE_LOCKED" : "INSTANCE_GUARD_FAILED",
        grant.code === "INSTANCE_LOCKED" ? "Data directory is already owned." : "Instance ownership could not be established.", 503);
    }
    const ownership = { version: 2, nonce: randomUUID(), mode: "gateway", pid: process.pid, creationTime: grant.creationTime };
    const temporary = path.join(directory, `ownership.${ownership.nonce}.tmp`);
    await writeFile(temporary, JSON.stringify(ownership), { mode: 0o600, flag: "wx" });
    await unlink(path.join(directory, "ownership.json")).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
    await rename(temporary, path.join(directory, "ownership.json"));
    return async () => { /* The duplicated handles intentionally live until process exit. */ };
  } catch (error) {
    child.kill();
    if (error instanceof PnpError) throw error;
    throw new PnpError("INSTANCE_GUARD_FAILED", "Instance ownership could not be established.", 503);
  }
}
