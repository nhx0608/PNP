import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Json } from "../contracts/index.ts";
import type { StateStore } from "../storage/store.ts";
import type { ProcessHost } from "../contracts/host.ts";

export interface RecoverySummary {
  interrupted: number;
  confirmedSessions: number;
  blockedSessions: number;
  invalidRecords: number;
  unverifiedRecords: number;
}

/** Reconciles persisted ownership without replaying prompts or guessing that missing evidence means stopped. */
export async function recoverOwnedState(store: StateStore, host: ProcessHost, dataDirectory: string): Promise<RecoverySummary> {
  const interrupted = await store.call("recover", null);
  const records = new Map<string, Json[]>();
  const verified = new Map<string, boolean[]>();
  let invalidRecords = 0;
  let files: string[] = [];
  try { files = await readdir(path.join(dataDirectory, "hosts")); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) invalidRecords++;
  }
  for (const file of files.filter((value) => value.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(await readFile(path.join(dataDirectory, "hosts", file), "utf8")) as Json;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
        || typeof parsed.sessionId !== "string") { invalidRecords++; continue; }
      const existing = records.get(parsed.sessionId) ?? [];
      existing.push(parsed);
      records.set(parsed.sessionId, existing);
    } catch { invalidRecords++; }
  }
  let unverifiedRecords = 0;
  for (const [sessionId, owned] of records) {
    const results: boolean[] = [];
    for (const record of owned) {
      let quiescent = false;
      try { quiescent = (await host.reconcile(record)).quiescent; }
      catch { quiescent = false; }
      results.push(quiescent);
      if (!quiescent) unverifiedRecords++;
    }
    verified.set(sessionId, results);
  }
  let confirmedSessions = 0;
  let blockedSessions = 0;
  for (const session of await store.call("listSessions", null)) {
    if (session.recovery !== "blocked") continue;
    const results = verified.get(session.id) ?? [];
    if (results.length === 0 || invalidRecords > 0 || unverifiedRecords > 0) { blockedSessions++; continue; }
    const quiescent = results.every(Boolean);
    if (!quiescent) { blockedSessions++; continue; }
    await store.call("confirmStopped", { sessionId: session.id });
    confirmedSessions++;
  }
  return { interrupted, confirmedSessions, blockedSessions, invalidRecords, unverifiedRecords };
}
