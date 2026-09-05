import { open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { PnpError } from "../core/errors.ts";

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
