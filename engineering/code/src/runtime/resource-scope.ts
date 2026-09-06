import type { ResourceScope, StopEvidence } from "../contracts/index.ts";
import { PnpError } from "../core/errors.ts";
import { bounded } from "./deadline.ts";

interface ScopeEntry {
  stop: () => Promise<StopEvidence>;
  /** Only proven quiescence is cached; a timeout or a failure must be retryable. */
  proven?: StopEvidence;
  /** Concurrent callers share one verification; a caller timeout never cancels it. */
  attempt?: Promise<StopEvidence>;
}

/** A cleanup registry exists before startup, not only after a channel has opened. */
export class OwnedResourceScope implements ResourceScope {
  private readonly stops = new Map<string, ScopeEntry>();
  closed = false;
  register(id: string, stop: () => Promise<StopEvidence>): void {
    if (this.closed) throw new PnpError("RESOURCE_SCOPE_CLOSED", "Resource acquisition after cancellation is forbidden.", 503);
    if (this.stops.has(id)) throw new PnpError("RESOURCE_DUPLICATE", "Resource identity already registered.", 500);
    this.stops.set(id, { stop });
  }
  stop(timeoutMs: number): Promise<StopEvidence> {
    this.closed = true;
    return Promise.all([...this.stops.values()].reverse().map((entry) => {
      if (entry.proven !== undefined) return Promise.resolve(entry.proven);
      if (entry.attempt === undefined) {
        const attempt = Promise.resolve().then(entry.stop);
        entry.attempt = attempt;
        void attempt.then((result) => {
          if (result.quiescent) entry.proven = result;
          if (entry.attempt === attempt) entry.attempt = undefined;
        }, () => {
          if (entry.attempt === attempt) entry.attempt = undefined;
        });
      }
      // The bound belongs to this caller only; the verification keeps running behind it.
      return bounded(entry.attempt, timeoutMs).catch(() => ({ quiescent: false, method: "process-tree" as const }));
    })).then((results) => ({
      quiescent: results.every((result) => result.quiescent),
      method: results.every((result) => result.method === "not-running") ? "not-running" as const : "process-tree" as const,
    }));
  }
}
