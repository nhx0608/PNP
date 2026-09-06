import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import type { Json } from "../contracts/index.ts";
import type { StateStore } from "../storage/store.ts";
import type { ProcessHost } from "../contracts/host.ts";

const HOSTS = "hosts";
/** Records that cannot be judged are kept, not deleted, but they never gate a start. */
const QUARANTINE = "quarantine";
/** Records whose process proved it is gone; retained for audit, excluded from the next verification. */
const ARCHIVE = "done";

export interface RecoveryIssue {
  /** Ownership record file name, so an operator can inspect the exact record. */
  file: string;
  reason: "unreadable" | "malformed" | "orphaned" | "unverified" | "verification-failed";
  sessionId?: string;
  detail?: string;
}
export interface RecoverySummary {
  interrupted: number;
  confirmedSessions: number;
  blockedSessions: number;
  invalidRecords: number;
  unverifiedRecords: number;
  quarantinedRecords: number;
  archivedRecords: number;
  issues: RecoveryIssue[];
  /** Sessions whose owned resources proved they stopped. */
  clearedSessions: string[];
  /** Sessions that stay blocked until their stop can be proven. */
  fencedSessions: string[];
}

function detailOf(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const code = "code" in error && typeof error.code === "string" ? error.code : error.name;
  return `${code}: ${error.message}`.slice(0, 160);
}
async function moveRecord(dataDirectory: string, file: string, bucket: string): Promise<boolean> {
  const target = path.join(dataDirectory, HOSTS, bucket);
  try {
    await mkdir(target, { recursive: true });
    await rename(path.join(dataDirectory, HOSTS, file), path.join(target, file));
    return true;
  } catch { return false; } // Reported by the caller as a retained record; nothing is hidden.
}

/**
 * Reconciles persisted ownership without replaying prompts or guessing that missing evidence means
 * stopped. Its result is per session: an unverifiable record blocks its own session and nothing else,
 * because only another live owner of this data directory or unopenable storage can prove that
 * continuing would corrupt data.
 */
export async function recoverOwnedState(store: StateStore, host: ProcessHost, dataDirectory: string): Promise<RecoverySummary> {
  const interrupted = await store.call("recover", null);
  const issues: RecoveryIssue[] = [];
  const records = new Map<string, { file: string; record: Json }[]>();
  let invalidRecords = 0;
  let unverifiedRecords = 0;
  let quarantinedRecords = 0;
  let archivedRecords = 0;
  let files: string[] = [];
  try { files = await readdir(path.join(dataDirectory, HOSTS)); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      invalidRecords++;
      issues.push({ file: HOSTS, reason: "unreadable", detail: detailOf(error) });
    }
  }
  for (const file of files.filter((value) => value.endsWith(".json"))) {
    let parsed: Json;
    try { parsed = JSON.parse(await readFile(path.join(dataDirectory, HOSTS, file), "utf8")) as Json; }
    catch (error) {
      invalidRecords++;
      issues.push({ file, reason: "unreadable", detail: detailOf(error) });
      if (await moveRecord(dataDirectory, file, QUARANTINE)) quarantinedRecords++;
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
      || typeof parsed.sessionId !== "string" || parsed.sessionId === "") {
      invalidRecords++;
      issues.push({ file, reason: "malformed", detail: "The record has no gateway session identifier." });
      if (await moveRecord(dataDirectory, file, QUARANTINE)) quarantinedRecords++;
      continue;
    }
    const existing = records.get(parsed.sessionId) ?? [];
    existing.push({ file, record: parsed });
    records.set(parsed.sessionId, existing);
  }
  const sessions = await store.call("listSessions", null);
  const known = new Set(sessions.map((session) => session.id));
  const proven = new Map<string, boolean>();
  for (const [sessionId, owned] of records) {
    if (!known.has(sessionId)) {
      // An ownerless record has no session to block and no run to protect, so it is quarantined
      // and counted instead of being allowed to fence the whole gateway on every later round.
      for (const entry of owned) {
        issues.push({ file: entry.file, reason: "orphaned", sessionId });
        if (await moveRecord(dataDirectory, entry.file, QUARANTINE)) quarantinedRecords++;
      }
      continue;
    }
    let all = true;
    for (const entry of owned) {
      let quiescent = false;
      let failure: string | undefined;
      try { quiescent = (await host.reconcile(entry.record)).quiescent; }
      catch (error) { failure = detailOf(error); }
      if (quiescent) {
        // Nothing is left to verify on the next start, so the record leaves the active set.
        if (await moveRecord(dataDirectory, entry.file, ARCHIVE)) archivedRecords++;
        continue;
      }
      all = false;
      unverifiedRecords++;
      issues.push({ file: entry.file, sessionId,
        ...(failure === undefined ? { reason: "unverified" as const } : { reason: "verification-failed" as const, detail: failure }) });
    }
    proven.set(sessionId, all);
  }
  const clearedSessions: string[] = [];
  const fencedSessions: string[] = [];
  for (const session of sessions) {
    if (session.recovery !== "blocked") continue;
    // No record at all is not evidence of a stop; the session keeps its block.
    if (proven.get(session.id) !== true) { fencedSessions.push(session.id); continue; }
    try {
      await store.call("confirmStopped", { sessionId: session.id });
      clearedSessions.push(session.id);
    } catch (error) {
      fencedSessions.push(session.id);
      issues.push({ file: "", sessionId: session.id, reason: "verification-failed", detail: detailOf(error) });
    }
  }
  return {
    interrupted, confirmedSessions: clearedSessions.length, blockedSessions: fencedSessions.length,
    invalidRecords, unverifiedRecords, quarantinedRecords, archivedRecords, issues, clearedSessions, fencedSessions,
  };
}
