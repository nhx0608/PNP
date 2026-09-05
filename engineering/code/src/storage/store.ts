import { Worker } from "node:worker_threads";
import type { Operation, Operations, WorkerReply } from "./protocol.ts";
import { PnpError } from "../core/errors.ts";

/** Single SQLite writer, isolated from the HTTP/SSE event loop. */
export class StateStore {
  private readonly worker: Worker;
  private nextId = 0;
  private closed = false;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: unknown): void;
    timer: NodeJS.Timeout;
  }>();
  constructor(databasePath: string) {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    this.worker = new Worker(new URL(`./worker.${extension}`, import.meta.url), {
      workerData: { databasePath },
    });
    this.worker.on("message", (reply: WorkerReply) => {
      const request = this.pending.get(reply.id);
      if (request === undefined) return;
      clearTimeout(request.timer);
      this.pending.delete(reply.id);
      if (reply.ok) request.resolve(reply.value);
      else request.reject(new PnpError(reply.code, reply.message, reply.status));
    });
    this.worker.on("error", () => this.fail());
    this.worker.on("exit", () => { if (!this.closed || this.pending.size > 0) this.fail(); });
  }
  call<K extends Operation>(op: K, input: Operations[K]["input"]): Promise<Operations[K]["output"]> {
    if (this.closed) return Promise.reject(new PnpError("STORAGE_UNAVAILABLE", "Storage is closed.", 503));
    if (this.pending.size >= 1024) return Promise.reject(new PnpError("STORAGE_BACKPRESSURE", "Storage queue is full.", 503));
    const id = ++this.nextId;
    return new Promise<Operations[K]["output"]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail();
        void this.worker.terminate();
      }, 15_000);
      this.pending.set(id, { resolve: (value) => resolve(value as Operations[K]["output"]), reject, timer });
      this.worker.postMessage({ id, op, input });
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    try { await this.call("close", null); }
    finally { this.closed = true; await this.worker.terminate(); }
  }
  private fail(): void {
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new PnpError("STORAGE_UNAVAILABLE", "Storage worker failed; writes must not be replayed.", 503));
    }
    this.pending.clear();
  }
}
