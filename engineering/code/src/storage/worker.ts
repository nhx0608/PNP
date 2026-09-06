import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Json, Message, Run, Session } from "../contracts/index.ts";
import type { InteractionRow, Operations, StorageDiagnostic, WorkerReply, WorkerRequest } from "./protocol.ts";
import { PnpError } from "../core/errors.ts";

if (parentPort === null) throw new Error("Storage must run in a worker.");
const port = parentPort;
const { databasePath } = workerData as { databasePath: string };
mkdirSync(dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
// Five seconds of busy waiting: on Windows an antivirus or sync client routinely holds the file for
// more than a second. Durability stays at FULL; long answers are made cheap by amortized checkpoints.
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
if (version > 1) throw new Error("Database schema is newer than this executable.");
if (version === 0) {
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      engine_id TEXT NOT NULL,
      document TEXT NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      idempotency_key TEXT,
      document TEXT NOT NULL,
      UNIQUE(session_id, idempotency_key)
    );
    CREATE UNIQUE INDEX one_live_run ON runs(session_id)
      WHERE state IN ('running', 'cancelling');
    CREATE TABLE messages (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      document TEXT NOT NULL
    );
    CREATE INDEX messages_by_session ON messages(session_id, ordinal);
    CREATE TABLE events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      properties TEXT NOT NULL
    );
    CREATE TABLE interactions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      document TEXT NOT NULL
    );
    PRAGMA user_version=1;
    COMMIT;
  `);
}
function parse<T>(row: Record<string, unknown> | undefined): T | null {
  return row === undefined ? null : JSON.parse(String(row.document)) as T;
}
function session(id: string): Session {
  const value = parse<Session>(db.prepare("SELECT document FROM sessions WHERE id=?").get(id));
  if (value === null) throw new PnpError("NOT_FOUND", "Session not found.", 404);
  return value;
}
function run(id: string): Run {
  const value = parse<Run>(db.prepare("SELECT document FROM runs WHERE id=?").get(id));
  if (value === null) throw new PnpError("NOT_FOUND", "Run not found.", 404);
  return value;
}
function saveSession(value: Session): void {
  db.prepare("UPDATE sessions SET document=? WHERE id=?").run(JSON.stringify(value), value.id);
}
function saveRun(value: Run): void {
  db.prepare("UPDATE runs SET state=?, document=? WHERE id=?").run(value.state, JSON.stringify(value), value.id);
}
function message(sessionId: string, runId: string, value: Message): void {
  db.prepare(`INSERT INTO messages(id,session_id,run_id,document) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET document=excluded.document`)
    .run(value.id, sessionId, runId, JSON.stringify(value));
}
function transaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const value = fn(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function input<K extends keyof Operations>(request: WorkerRequest): Operations[K]["input"] {
  return request.input as Operations[K]["input"];
}
function handle(request: WorkerRequest): unknown {
  switch (request.op) {
    case "createSession": {
      const value = input<"createSession">(request);
      db.prepare("INSERT INTO sessions(id,engine_id,document) VALUES(?,?,?)")
        .run(value.id, value.engineId, JSON.stringify(value));
      return value;
    }
    case "getSession":
      return parse<Session>(db.prepare("SELECT document FROM sessions WHERE id=?").get(input<"getSession">(request).id));
    case "listSessions":
      return db.prepare("SELECT document FROM sessions ORDER BY rowid").all().map((row) => parse<Session>(row));
    case "bindNative": {
      const value = input<"bindNative">(request);
      const current = session(value.id);
      if (current.channelId !== value.native.channelId) throw new PnpError("CHANNEL_MISMATCH", "Native session channel mismatch.", 409);
      current.native = value.native;
      current.recovery = "ready";
      saveSession(current);
      return null;
    }
    case "findRunByKey": {
      const value = input<"findRunByKey">(request);
      return parse<Run>(db.prepare("SELECT document FROM runs WHERE session_id=? AND idempotency_key=?")
        .get(value.sessionId, value.key));
    }
    case "startRun": {
      const value = input<"startRun">(request);
      return transaction(() => {
        const current = session(value.run.sessionId);
        if (current.status === "busy" || current.recovery === "blocked" || current.lifecycle !== "active") {
          throw new PnpError("SESSION_BUSY", "Session cannot accept a new run.", 409);
        }
        db.prepare("INSERT INTO runs(id,session_id,state,idempotency_key,document) VALUES(?,?,?,?,?)")
          .run(value.run.id, value.run.sessionId, value.run.state, value.run.idempotencyKey ?? null, JSON.stringify(value.run));
        current.status = "busy";
        current.updatedAt = value.run.startedAt;
        saveSession(current);
        message(current.id, value.run.id, value.message);
        return null;
      });
    }
    case "cancelling": {
      const current = run(input<"cancelling">(request).runId);
      if (current.state === "running") { current.state = "cancelling"; saveRun(current); }
      return null;
    }
    case "appendMessage": {
      const value = input<"appendMessage">(request);
      const current = run(value.runId);
      if (!["running", "cancelling"].includes(current.state)) {
        throw new PnpError("LATE_EVENT", "Run is already terminal.", 409);
      }
      message(value.sessionId, value.runId, value.message);
      return null;
    }
    case "messages":
      return db.prepare("SELECT document FROM messages WHERE session_id=? ORDER BY ordinal")
        .all(input<"messages">(request).sessionId).map((row) => parse<Message>(row));
    case "appendEvent": {
      const value = input<"appendEvent">(request);
      const sessionId = typeof value.properties.sessionID === "string" ? value.properties.sessionID : null;
      const result = db.prepare("INSERT INTO events(session_id,type,properties) VALUES(?,?,?)")
        .run(sessionId, value.type, JSON.stringify(value.properties));
      return { sequence: Number(result.lastInsertRowid), ...value };
    }
    case "eventsSince": {
      const value = input<"eventsSince">(request);
      const limit = Math.min(Math.max(Math.trunc(value.limit ?? 256), 1), 1000);
      return db.prepare("SELECT sequence,type,properties FROM events WHERE sequence>? ORDER BY sequence LIMIT ?")
        .all(Math.max(Math.trunc(value.afterSequence), 0), limit)
        .map((row) => ({
          sequence: Number(row.sequence), type: String(row.type),
          properties: JSON.parse(String(row.properties)) as { [key: string]: Json },
        }));
    }
    case "finishRun": {
      const value = input<"finishRun">(request);
      return transaction(() => {
        const current = run(value.runId);
        if (!["running", "cancelling"].includes(current.state)) return current;
        current.state = value.state;
        current.finishedAt = new Date().toISOString();
        if (value.errorCode !== undefined) current.errorCode = value.errorCode;
        if (value.nativeStopReason !== undefined) current.nativeStopReason = value.nativeStopReason;
        if (value.taskOutcome !== undefined) current.taskOutcome = value.taskOutcome;
        // Replace the live assistant projection and put the final message after all tool results.
        db.prepare("DELETE FROM messages WHERE id=? AND run_id=?").run(value.message.id, current.id);
        message(current.sessionId, current.id, value.message);
        saveRun(current);
        const parent = session(current.sessionId);
        parent.status = value.quiescent ? "idle" : "busy";
        // A turn that only stopped because the gateway forced termination is not a warm channel:
        // the next open has to resume the native session instead of assuming it is still attached.
        parent.recovery = value.quiescent
          ? (value.nativeResumeRequired === true && parent.native !== undefined ? "needs-native-resume" : "ready")
          : "blocked";
        parent.updatedAt = current.finishedAt;
        saveSession(parent);
        return current;
      });
    }
    case "beginDelete": {
      const current = session(input<"beginDelete">(request).sessionId);
      if (current.status === "busy" || current.recovery === "blocked") throw new PnpError("SESSION_BUSY", "Session execution is not quiescent.", 409);
      current.lifecycle = "deleting";
      saveSession(current);
      return null;
    }
    case "confirmStopped": {
      const current = session(input<"confirmStopped">(request).sessionId);
      current.status = "idle";
      current.recovery = current.native === undefined ? "ready" : "needs-native-resume";
      saveSession(current);
      return null;
    }
    case "diagnostics": {
      const all = db.prepare("SELECT document FROM sessions").all().map((r) => parse<Session>(r)!);
      return {
        sessions: all.length,
        runs: Number(db.prepare("SELECT count(*) AS n FROM runs").get()?.n),
        interrupted: Number(db.prepare("SELECT count(*) AS n FROM runs WHERE state='interrupted'").get()?.n),
        blocked: all.filter((s) => s.recovery === "blocked").length,
      };
    }
    case "deleteSession": {
      const value = input<"deleteSession">(request);
      if (session(value.sessionId).status === "busy") throw new PnpError("SESSION_BUSY", "Stop the run first.", 409);
      db.prepare("DELETE FROM sessions WHERE id=?").run(value.sessionId);
      return null;
    }
    case "getRun":
      return parse<Run>(db.prepare("SELECT document FROM runs WHERE id=?").get(input<"getRun">(request).runId));
    case "releaseIdempotencyKey": {
      const current = run(input<"releaseIdempotencyKey">(request).runId);
      // Only a proven terminal state frees the key. running, cancelling and interrupted keep it so that
      // an unverified stop can never be retried behind the same key.
      if (!["failed", "cancelled"].includes(current.state) || current.idempotencyKey === undefined) return false;
      delete current.idempotencyKey;
      db.prepare("UPDATE runs SET idempotency_key=NULL, document=? WHERE id=?").run(JSON.stringify(current), current.id);
      return true;
    }
    case "recover": {
      return transaction(() => {
        const rows = db.prepare("SELECT document FROM runs WHERE state IN ('running','cancelling')").all();
        for (const row of rows) {
          const current = parse<Run>(row)!;
          current.state = "interrupted";
          current.errorCode = "GATEWAY_INTERRUPTED";
          current.finishedAt = new Date().toISOString();
          saveRun(current);
          for (const stored of db.prepare("SELECT document FROM messages WHERE run_id=?").all(current.id)) {
            const item = parse<Message>(stored)!;
            if (item.tool_calls !== undefined) {
              item.parts = (item.parts ?? []).map((part) => {
                if (part !== null && typeof part === "object" && !Array.isArray(part) && part.type === "tool") {
                  const value = part.state;
                  if (value !== null && typeof value === "object" && !Array.isArray(value) && value.status === "running") {
                    return { ...part, state: { status: "error", terminalStatus: "result_unknown", source: "gateway-recovery" } };
                  }
                }
                return part;
              });
              message(current.sessionId, current.id, item);
            }
          }
          message(current.sessionId, current.id, { id: `recovery-${current.id}`, role: "assistant",
            content: "Execution was interrupted. External effects may already have occurred; the request was not replayed.",
            created_at: current.finishedAt, info: { role: "assistant", finish: "interrupted" },
            parts: [{ type: "text", content: "Interrupted execution; inspect resource ownership before continuing." }] });
          const parent = session(current.sessionId);
          parent.status = "busy"; // Do NOT assume an old child process has stopped.
          parent.recovery = "blocked";
          saveSession(parent);
        }
        for (const row of db.prepare("SELECT document FROM sessions").all()) {
          const current = parse<Session>(row)!;
          if (current.status === "idle" && current.native !== undefined) {
            current.recovery = "needs-native-resume";
            saveSession(current);
          }
        }
        db.prepare("UPDATE interactions SET state='expired' WHERE state='pending'").run();
        return rows.length;
      });
    }
    case "createInteraction": {
      const value = input<"createInteraction">(request);
      db.prepare("INSERT INTO interactions(id,session_id,run_id,kind,state,document) VALUES(?,?,?,?,?,?)")
        .run(value.id, value.sessionId, value.runId, value.kind, value.state, JSON.stringify(value));
      return null;
    }
    case "listInteractions":
      return db.prepare("SELECT document FROM interactions WHERE kind=? AND state='pending'")
        .all(input<"listInteractions">(request).kind).map((row) => parse<InteractionRow>(row));
    case "resolveInteraction": {
      const value = input<"resolveInteraction">(request);
      const current = parse<InteractionRow>(db.prepare("SELECT document FROM interactions WHERE id=? AND state='pending'").get(value.id));
      if (current === null) return false;
      current.state = "resolved";
      current.response = value.response;
      db.prepare("UPDATE interactions SET state='resolved',document=? WHERE id=?").run(JSON.stringify(current), current.id);
      return true;
    }
    case "expireInteractions":
      db.prepare("UPDATE interactions SET state='expired' WHERE run_id=? AND state='pending'")
        .run(input<"expireInteractions">(request).runId);
      return null;
    case "close":
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
      return null;
    default: throw new PnpError("STORAGE_PROTOCOL_ERROR", "Unknown storage operation.", 500);
  }
}
port.on("message", (request: WorkerRequest) => {
  let reply: WorkerReply;
  try { reply = { id: request.id, ok: true, value: handle(request) }; }
  catch (error) {
    const rawCode = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    const rawErrcode = typeof error === "object" && error !== null && "errcode" in error
      && typeof error.errcode === "number" && Number.isSafeInteger(error.errcode) ? error.errcode : undefined;
    const sqliteFailure = /^(?:ERR_)?SQLITE_[A-Z0-9_]+$/.test(rawCode) || rawErrcode !== undefined;
    const rawMessage = error instanceof Error ? error.message : "";
    // SQLITE_CONSTRAINT is 19; extended results keep it in the low byte. A rejected statement never
    // applied, so it is an expected state conflict rather than evidence that storage is unavailable.
    const constraint = /CONSTRAINT/i.test(rawCode) || /constraint failed/i.test(rawMessage)
      || (rawErrcode !== undefined && rawErrcode % 256 === 19);
    const readOnly = new Set<keyof Operations>(["getSession", "listSessions", "findRunByKey", "messages",
      "diagnostics", "getRun", "listInteractions", "eventsSince"]);
    const diagnostic: StorageDiagnostic = {
      category: sqliteFailure ? "sqlite" : "worker",
      ...(sqliteFailure ? { code: `${rawCode || "SQLITE_ERROR"}${rawErrcode === undefined ? "" : `/${rawErrcode}`}` } : {}),
      ...(rawMessage === "" ? {} : { detail: rawMessage.slice(0, 200) }),
      // A failed read cannot have committed a mutation. Write-side failures remain
      // unknown unless the transaction layer can prove rollback durably completed.
      outcome: readOnly.has(request.op) || constraint ? "known-failed" : "unknown",
    };
    if (error instanceof PnpError) {
      reply = { id: request.id, ok: false, code: error.code, message: error.message, status: error.status };
    } else if (constraint) {
      reply = { id: request.id, ok: false, code: "STATE_CONFLICT", message: "The requested state transition conflicts with stored state.", status: 409, diagnostic };
    } else {
      reply = { id: request.id, ok: false, code: "STORAGE_ERROR", message: "Storage operation failed.", status: 503, diagnostic };
    }
  }
  port.postMessage(reply);
});
