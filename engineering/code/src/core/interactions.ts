import { randomUUID } from "node:crypto";
import type { AuthorizationDecision, InteractionRequest, InteractionResponse, Json } from "../contracts/index.ts";
import { StateStore } from "../storage/store.ts";
import { EventJournal } from "./journal.ts";
import { PnpError } from "./errors.ts";
import { deferred, bounded } from "../runtime/deadline.ts";
import { Redactor } from "../security/redaction.ts";

/** Questions and approvals are run-scoped; permission answers cannot override policy denial. */
export class InteractionBroker {
  private readonly pending = new Map<string, { kind: "permission" | "question"; resolve(value: InteractionResponse): void }>();
  private readonly store: StateStore;
  private readonly journal: EventJournal;
  private readonly timeoutMs: number;
  constructor(store: StateStore, journal: EventJournal, timeoutMs = 120_000) {
    this.store = store; this.journal = journal; this.timeoutMs = timeoutMs;
  }
  async request(input: {
    sessionId: string; runId: string; request: InteractionRequest; policy: AuthorizationDecision;
    signal: AbortSignal; redactor: Redactor;
  }): Promise<InteractionResponse> {
    const { request, policy, signal } = input;
    if (signal.aborted) return { decision: "deny" };
    const id = `interaction_${randomUUID()}`;
    const payload = input.redactor.json(request.payload);
    await this.store.call("createInteraction", {
      id, sessionId: input.sessionId, runId: input.runId, kind: request.kind, payload,
      operation: request.operation, state: "pending", createdAt: new Date().toISOString(),
    });
    const choice = deferred<InteractionResponse>();
    this.pending.set(id, { kind: request.kind, resolve: choice.resolve });
    const onAbort = () => choice.resolve({ decision: "deny" });
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (policy.effect === "deny" || (request.kind === "permission" && policy.effect === "allow")) {
        const response: InteractionResponse = { decision: policy.effect === "allow" ? "allow" : "deny" };
        await this.store.call("resolveInteraction", { id, response: response as unknown as Json });
        await this.journal.publish("permission.resolved", {
          sessionID: input.sessionId, runID: input.runId, id, decision: response.decision,
          reasonCode: policy.reasonCode, source: "policy",
        });
        return response;
      }
      // Listener registration precedes publishing; an immediate reply is safe.
      const body = payload !== null && !Array.isArray(payload) && typeof payload === "object" ? payload : {};
      await this.journal.publish(`${request.kind}.asked`, {
        ...body, sessionID: input.sessionId, runID: input.runId, id,
        ...(request.kind === "permission" ? { permission: request.operation } : {}),
      });
      if (signal.aborted) choice.resolve({ decision: "deny" });
      let answer: InteractionResponse;
      try { answer = await bounded(choice.promise, this.timeoutMs); }
      catch { answer = { decision: "deny" }; }
      await this.store.call("resolveInteraction", { id, response: answer as unknown as Json });
      return answer;
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.pending.delete(id);
    }
  }
  async list(kind: "permission" | "question") {
    return (await this.store.call("listInteractions", { kind })).filter((row) => this.pending.has(row.id)).map((row) => ({
      id: row.id, sessionID: row.sessionId, created_at: row.createdAt,
      ...(typeof row.payload === "object" && row.payload !== null && !Array.isArray(row.payload) ? row.payload : {}),
      ...(kind === "permission" ? { permission: row.operation } : {}),
    }));
  }
  async reply(id: string, kind: "permission" | "question", response: InteractionResponse): Promise<void> {
    const waiter = this.pending.get(id);
    if (waiter === undefined || waiter.kind !== kind) throw new PnpError("NOT_FOUND", "No pending interaction.", 404);
    if (kind === "question" && response.decision === "allow") throw new PnpError("VALIDATION_ERROR", "Question requires an answer.", 400);
    const changed = await this.store.call("resolveInteraction", { id, response: response as unknown as Json });
    if (!changed) throw new PnpError("INTERACTION_RESOLVED", "Interaction has already been resolved.", 409);
    this.pending.delete(id);
    waiter.resolve(response);
  }
}
