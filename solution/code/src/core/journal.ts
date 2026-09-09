import type { Json, PublicEvent } from "../contracts/index.ts";
import { StateStore } from "../storage/store.ts";

export class EventJournal {
  private readonly listeners = new Set<(event: PublicEvent) => void>();
  private readonly store: StateStore;
  constructor(store: StateStore) { this.store = store; }
  subscribe(listener: (event: PublicEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Committed events after a sequence number, so a reconnecting subscriber can resume without a gap. */
  async since(afterSequence: number, limit?: number): Promise<PublicEvent[]> {
    return this.store.call("eventsSince", { afterSequence, ...(limit === undefined ? {} : { limit }) });
  }
  /** Committed events of ONE session after a sequence number, so "what happened in session X" is a
   *  query rather than a full replay of the global journal filtered client-side. Read-only, and it
   *  returns nothing for a session that never existed or whose rows were deleted. */
  async forSession(sessionId: string, afterSequence: number, limit?: number): Promise<PublicEvent[]> {
    return this.store.call("eventsForSession", { sessionId, afterSequence, ...(limit === undefined ? {} : { limit }) });
  }
  async publish(type: string, properties: { [key: string]: Json }): Promise<void> {
    const event = await this.store.call("appendEvent", { type, properties });
    for (const listener of this.listeners) {
      try { listener(event); }
      catch { this.listeners.delete(listener); } // An observer cannot roll back committed state.
    }
  }
}
