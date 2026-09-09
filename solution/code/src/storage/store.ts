import { Worker } from "node:worker_threads";
import type { Operation, Operations, StorageDiagnostic, WorkerReply } from "./protocol.ts";
import { PnpError } from "../core/errors.ts";

const OPERATION_TIMEOUT_MS = 15_000;
/** Unanswered operations in a row before the worker itself is suspected. */
const FAILURE_BUDGET = 3;
/** Worker replacements before storage is reported as unavailable instead of restarted again. */
const REBUILD_BUDGET = 3;

/** Single SQLite writer, isolated from the HTTP/SSE event loop. */
export class StateStore {
  private readonly databasePath: string;
  private worker: Worker;
  private nextId = 0;
  private closed = false;
  private unavailable = false;
  private consecutiveFailures = 0;
  private rebuilds = 0;
  private readonly diagnosticRing: Array<StorageDiagnostic & { at: string }> = [];
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: unknown): void;
    timer: NodeJS.Timeout;
  }>();
  constructor(databasePath: string) {
    this.databasePath = databasePath;
    this.worker = this.spawn();
  }
  private spawn(): Worker {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const worker = new Worker(new URL(`./worker.${extension}`, import.meta.url), {
      workerData: { databasePath: this.databasePath },
    });
    worker.on("message", (reply: WorkerReply) => {
      if (this.worker !== worker) return;
      const request = this.pending.get(reply.id);
      if (request === undefined) return;
      clearTimeout(request.timer);
      this.pending.delete(reply.id);
      this.consecutiveFailures = 0; // The worker answered, so it is still processing its queue.
      if (reply.ok) request.resolve(reply.value);
      else {
        if (reply.diagnostic !== undefined) this.record(reply.diagnostic);
        request.reject(new PnpError(reply.code, reply.message, reply.status));
      }
    });
    worker.on("error", (error: Error) => {
      if (this.worker !== worker) return;
      // Keep the original failure identity: SQLITE_CANTOPEN, a permission error and a path error
      // are different operator actions and the message is the only place that distinguishes them.
      const code = "code" in error && typeof error.code === "string" ? error.code : error.name;
      this.record({ category: "worker", outcome: "unknown", code, detail: error.message.slice(0, 200) });
      this.replaceWorker();
    });
    worker.on("exit", () => {
      if (this.closed || this.worker !== worker) return;
      this.record({ category: "worker", outcome: "unknown", code: "WORKER_EXITED" });
      this.replaceWorker();
    });
    return worker;
  }
  /** Replaces a worker that stopped answering. Pending writes are rejected, never replayed. */
  private replaceWorker(): void {
    if (this.closed) return;
    const previous = this.worker;
    previous.removeAllListeners();
    void previous.terminate().then(() => undefined, () => undefined);
    this.rejectPending("Storage worker was replaced; unfinished writes must not be replayed.");
    this.consecutiveFailures = 0;
    if (this.rebuilds >= REBUILD_BUDGET) {
      this.unavailable = true;
      this.record({ category: "worker", outcome: "unknown", code: "WORKER_REBUILD_BUDGET_EXHAUSTED" });
      return;
    }
    this.rebuilds += 1;
    this.worker = this.spawn();
  }
  /** False once storage can no longer serve operations; readiness is derived from it, not latched by one failure. */
  get available(): boolean { return !this.closed && !this.unavailable; }
  call<K extends Operation>(op: K, input: Operations[K]["input"]): Promise<Operations[K]["output"]> {
    if (this.closed) return Promise.reject(new PnpError("STORAGE_UNAVAILABLE", "Storage is closed.", 503));
    if (this.unavailable) return Promise.reject(new PnpError("STORAGE_UNAVAILABLE", "Storage worker could not be restored.", 503));
    if (this.pending.size >= 1024) return Promise.reject(new PnpError("STORAGE_BACKPRESSURE", "Storage queue is full.", 503));
    const id = ++this.nextId;
    return new Promise<Operations[K]["output"]>((resolve, reject) => {
      const timer = setTimeout(() => {
        // One slow operation fails on its own; a worker is only replaced once it stops answering at all.
        this.pending.delete(id);
        this.record({ category: "timeout", outcome: "unknown" });
        this.consecutiveFailures += 1;
        reject(new PnpError("STORAGE_TIMEOUT", "Storage operation timed out; its outcome is unknown.", 503));
        if (this.consecutiveFailures >= FAILURE_BUDGET) this.replaceWorker();
      }, OPERATION_TIMEOUT_MS);
      this.pending.set(id, { resolve: (value) => resolve(value as Operations[K]["output"]), reject, timer });
      this.worker.postMessage({ id, op, input });
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    try { if (this.available) await this.call("close", null); }
    finally {
      this.closed = true;
      this.rejectPending("Storage was closed; unfinished writes must not be replayed.");
      await this.worker.terminate();
    }
  }
  diagnosticsSnapshot(): ReadonlyArray<StorageDiagnostic & { at: string }> {
    return this.diagnosticRing.map((entry) => ({ ...entry }));
  }
  private record(value: StorageDiagnostic): void {
    this.diagnosticRing.push({ ...value, at: new Date().toISOString() });
    if (this.diagnosticRing.length > 32) this.diagnosticRing.shift();
  }
  private rejectPending(message: string): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new PnpError("STORAGE_UNAVAILABLE", message, 503));
    }
    this.pending.clear();
  }
}
