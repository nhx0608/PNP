import { rm } from "node:fs/promises";

/**
 * Removes a temporary directory a test owns, retrying while something still holds it.
 *
 * Neither observed case is a leak, and both are invisible until a loaded CI runner widens the
 * window. On Linux a host whose supervisor was reaped finishes its in-flight settle and saves the
 * ownership record into the tree being deleted, so `rmdir` sees ENOTEMPTY. On Windows the working
 * directory of a process that has already exited stays held for a moment afterwards, so `rmdir`
 * sees EBUSY. Node retries exactly those cases — EBUSY, EMFILE, ENFILE, ENOTEMPTY and EPERM — with
 * linear backoff, re-listing the directory on each attempt, which is what both races need.
 */
export function removeTree(target: string): Promise<void> {
  return rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
