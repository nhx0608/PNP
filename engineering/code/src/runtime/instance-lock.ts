import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { PnpError } from "../core/errors.ts";
import { bounded, deferred } from "./deadline.ts";
import { JsonlDecoder } from "./jsonl.ts";
import { bootTimeMs, helperCacheDirectory, windowsHelperCommand } from "./process-host.ts";

interface LockOwner { pid: number; startedAt: string; }
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
function ownerAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return errorCode(error) !== "ESRCH"; }
}
/**
 * A lock is stale only when its recorded owner provably cannot be running: the file is not a
 * readable owner record, the process id is gone, or the record predates the current boot and the
 * live process id therefore belongs to somebody else.
 */
async function staleOwner(lockPath: string): Promise<boolean> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(lockPath, "utf8")); }
  catch { return true; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return true;
  const owner = parsed as Partial<LockOwner>;
  if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return true;
  if (!ownerAlive(owner.pid)) return true;
  const startedAt = typeof owner.startedAt === "string" ? Date.parse(owner.startedAt) : Number.NaN;
  return Number.isFinite(startedAt) && startedAt < bootTimeMs();
}

/**
 * Single-owner guard with an explicit self-healing exit: a lock whose owner is proven dead is
 * taken over and rewritten. A live owner is never displaced.
 */
export async function acquireInstanceLock(path: string): Promise<() => Promise<void>> {
  const locked = (): PnpError => new PnpError("INSTANCE_LOCKED", "Data directory is already owned or requires explicit recovery.", 503);
  let file: FileHandle;
  try { file = await open(path, "wx"); }
  catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") throw locked();
    if (!await staleOwner(path)) throw locked();
    try { file = await open(path, "r+"); await file.truncate(0); }
    catch { throw locked(); }
  }
  await file.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await file.sync();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await file.close();
    await unlink(path).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  };
}

/** Windows process-lifetime ownership. The duplicated OS handles close only when this Node process exits. */
export async function acquireProcessLifetimeLock(directory: string, timeoutMs = 30_000): Promise<() => Promise<void>> {
  const fileLock = (): Promise<() => Promise<void>> => acquireInstanceLock(path.join(directory, "gateway.lock"));
  if (process.platform !== "win32") return fileLock();
  let command: { executable: string; args: string[] };
  // The supervisor source is a delivery artefact; a missing one degrades to the file lock.
  try { command = windowsHelperCommand(await helperCacheDirectory(directory)); }
  catch { return fileLock(); }
  const child = spawn(command.executable, command.args, {
    env: Object.fromEntries(["SystemRoot", "WINDIR", "SystemDrive", "PATH", "PATHEXT", "TEMP", "TMP"]
      .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
    windowsHide: true, shell: false, stdio: "pipe",
  });
  const result = deferred<{ ok?: boolean; code?: string; pid?: number; creationTime?: string }>();
  const decoder = new JsonlDecoder();
  child.stdout.on("data", (chunk: Buffer) => {
    try { for (const frame of decoder.push(chunk)) result.resolve(JSON.parse(frame)); }
    catch { result.resolve({ ok: false, code: "INSTANCE_GUARD_FAILED" }); }
  });
  child.stdout.on("end", () => { try { decoder.end(); } catch { result.resolve({ ok: false, code: "INSTANCE_GUARD_FAILED" }); } });
  child.stdin.on("error", () => result.resolve({ ok: false, code: "INSTANCE_GUARD_FAILED" }));
  child.stderr.resume();
  child.on("error", () => result.resolve({ ok: false, code: "INSTANCE_GUARD_FAILED" }));
  child.on("exit", () => result.resolve({ ok: false, code: "INSTANCE_GUARD_FAILED" }));
  let granted = false;
  try {
    await new Promise<void>((resolve, reject) => child.stdin.write(
      `${JSON.stringify({ operation: "guard", directory, pid: process.pid })}\n`, (error) => error ? reject(error) : resolve()));
    child.stdin.end();
    const grant = await bounded(result.promise, timeoutMs);
    if (grant.code === "INSTANCE_LOCKED") throw new PnpError("INSTANCE_LOCKED", "Data directory is already owned.", 503);
    if (grant.ok !== true || grant.pid !== process.pid || !/^\d+$/.test(grant.creationTime ?? "")) {
      throw new PnpError("INSTANCE_GUARD_FAILED", "Instance ownership could not be established.", 503);
    }
    granted = true;
    const ownership = { version: 2, nonce: randomUUID(), mode: "gateway", pid: process.pid, creationTime: grant.creationTime };
    const temporary = path.join(directory, `ownership.${ownership.nonce}.tmp`);
    await writeFile(temporary, JSON.stringify(ownership), { mode: 0o600, flag: "wx" });
    await unlink(path.join(directory, "ownership.json")).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
    await rename(temporary, path.join(directory, "ownership.json"));
    return async () => { /* The duplicated handles intentionally live until process exit. */ };
  } catch (error) {
    child.kill();
    if (error instanceof PnpError && error.code === "INSTANCE_LOCKED") throw error;
    // A guard that never granted must not be a new single point of startup failure.
    if (!granted) return fileLock();
    if (error instanceof PnpError) throw error;
    throw new PnpError("INSTANCE_GUARD_FAILED", "Instance ownership could not be established.", 503);
  }
}
