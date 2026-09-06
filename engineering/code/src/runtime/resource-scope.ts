import type { ResourceScope, StopEvidence } from "../contracts/index.ts";
import { PnpError } from "../core/errors.ts";
import { bounded } from "./deadline.ts";

/** A cleanup registry exists before startup, not only after a channel has opened. */
export class OwnedResourceScope implements ResourceScope {
  private readonly stops = new Map<string, {
    stop: () => Promise<StopEvidence>;
    quiescent: boolean;
    attempt?: Promise<StopEvidence>;
  }>();
  closed = false;
  register(id: string, stop: () => Promise<StopEvidence>): void {
    if (this.closed) throw new PnpError("RESOURCE_SCOPE_CLOSED", "Resource acquisition after cancellation is forbidden.", 503);
    if (this.stops.has(id)) throw new PnpError("RESOURCE_DUPLICATE", "Resource identity already registered.", 500);
    this.stops.set(id, { stop, quiescent: false });
  }
  retire(id: string, evidence: StopEvidence): void {
    const entry = this.stops.get(id);
    if (entry === undefined) throw new PnpError("RESOURCE_UNKNOWN", "Resource identity is not registered.", 500);
    if (!evidence.quiescent) throw new PnpError("RESOURCE_UNPROVEN", "Resource stop is not proven.", 503);
    if (entry.attempt !== undefined) throw new PnpError("RESOURCE_STOPPING", "Resource cleanup is still in progress.", 503);
    this.stops.delete(id);
  }
  stop(timeoutMs: number): Promise<StopEvidence> {
    this.closed = true;
    return Promise.all([...this.stops.entries()].reverse().map(([id, entry]) => {
      if (entry.quiescent) return Promise.resolve({ quiescent: true, method: "process-tree" as const });
      if (entry.attempt === undefined) {
        const attempt = Promise.resolve().then(entry.stop);
        entry.attempt = attempt;
        void attempt.then((result) => {
          if (result.quiescent) {
            entry.quiescent = true;
            if (this.stops.get(id) === entry) this.stops.delete(id);
          }
          if (entry.attempt === attempt) entry.attempt = undefined;
        }, () => {
          if (entry.attempt === attempt) entry.attempt = undefined;
        });
      }
      return bounded(entry.attempt, timeoutMs).catch(() => ({ quiescent: false, method: "process-tree" as const }));
    })).then((results) => ({ quiescent: results.every((result) => result.quiescent), method: "process-tree" as const }));
  }
}
