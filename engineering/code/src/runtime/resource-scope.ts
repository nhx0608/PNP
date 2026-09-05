import type { ResourceScope, StopEvidence } from "../contracts/index.ts";
import { PnpError } from "../core/errors.ts";
import { bounded } from "./deadline.ts";

/** A cleanup registry exists before startup, not only after a channel has opened. */
export class OwnedResourceScope implements ResourceScope {
  private readonly stops = new Map<string, () => Promise<StopEvidence>>();
  private stopping?: Promise<StopEvidence>;
  closed = false;
  register(id: string, stop: () => Promise<StopEvidence>): void {
    if (this.closed) throw new PnpError("RESOURCE_SCOPE_CLOSED", "Resource acquisition after cancellation is forbidden.", 503);
    if (this.stops.has(id)) throw new PnpError("RESOURCE_DUPLICATE", "Resource identity already registered.", 500);
    this.stops.set(id, stop);
  }
  stop(timeoutMs: number): Promise<StopEvidence> {
    this.closed = true;
    this.stopping ??= Promise.all([...this.stops.values()].reverse().map(async (stop) => {
      try { return await bounded(stop(), timeoutMs); }
      catch { return { quiescent: false, method: "process-tree" as const }; }
    })).then((results) => ({ quiescent: results.every((r) => r.quiescent), method: "process-tree" as const }));
    return this.stopping;
  }
}
