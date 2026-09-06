import { randomUUID } from "node:crypto";
import type { AuthorizationDecision, InteractionRequest, InteractionResponse, Json } from "../contracts/index.ts";
import { StateStore } from "../storage/store.ts";
import { EventJournal } from "./journal.ts";
import { PnpError } from "./errors.ts";
import { deferred, bounded } from "../runtime/deadline.ts";
import { Redactor } from "../security/redaction.ts";

/**
 * The specification's permission object always carries `patterns`, so the gateway states the field
 * whether or not the driver could name a path. A driver that observed none contributes an empty list;
 * the gateway never fills one in on its behalf.
 */
function patternsOf(payload: Json): Json[] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return [];
  const named = payload["patterns"];
  return Array.isArray(named) ? named : [];
}

/** Questions and approvals are run-scoped; permission answers cannot override policy denial. */
export class InteractionBroker {
  private readonly liveRuns = new Set<string>();
  private readonly pending = new Map<string, {
    runId: string;
    kind: "permission" | "question";
    state: "waiting" | "replying";
    resolve(value: InteractionResponse): void;
    settlement?: Promise<void>;
  }>();
  private readonly store: StateStore;
  private readonly journal: EventJournal;
  private readonly timeoutMs: number;
  constructor(store: StateStore, journal: EventJournal, timeoutMs = 45_000) {
    this.store = store; this.journal = journal; this.timeoutMs = timeoutMs;
  }
  beginRun(runId: string): void {
    if (this.liveRuns.has(runId)) throw new PnpError("INTERACTION_RUN_EXISTS", "Run interaction scope already exists.", 500);
    this.liveRuns.add(runId);
  }
  async endRun(runId: string): Promise<void> {
    this.liveRuns.delete(runId); // Close admission synchronously before waiting for claimed replies.
    const claimed: Promise<void>[] = [];
    for (const [id, waiter] of this.pending) {
      if (waiter.runId !== runId) continue;
      if (waiter.state === "replying") {
        if (waiter.settlement !== undefined) claimed.push(waiter.settlement);
        continue;
      }
      this.pending.delete(id);
      waiter.resolve({ decision: "deny", source: "cancelled", reasonCode: "RUN_ENDED" });
    }
    await Promise.all(claimed);
    await this.store.call("expireInteractions", { runId });
  }
  async request(input: {
    sessionId: string; runId: string; request: InteractionRequest; policy: AuthorizationDecision;
    signal: AbortSignal; redactor: Redactor;
  }): Promise<InteractionResponse> {
    const { request, policy, signal } = input;
    if (signal.aborted || !this.liveRuns.has(input.runId)) {
      return { decision: "deny", source: "cancelled", reasonCode: "RUN_NOT_ACTIVE" };
    }
    const id = `interaction_${randomUUID()}`;
    const payload = input.redactor.json(request.payload);
    await this.store.call("createInteraction", {
      id, sessionId: input.sessionId, runId: input.runId, kind: request.kind, payload,
      operation: request.operation, state: "pending", createdAt: new Date().toISOString(),
    });
    if (signal.aborted || !this.liveRuns.has(input.runId)) {
      await this.store.call("expireInteractions", { runId: input.runId });
      return { decision: "deny", source: "cancelled", reasonCode: "RUN_NOT_ACTIVE" };
    }
    const choice = deferred<InteractionResponse>();
    this.pending.set(id, { runId: input.runId, kind: request.kind, state: "waiting", resolve: choice.resolve });
    const onAbort = () => choice.resolve({ decision: "deny", source: "cancelled", reasonCode: "RUN_CANCELLED" });
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (policy.effect === "deny" || (request.kind === "permission" && policy.effect === "allow")) {
        // An organisation decision is final: it is never published as an overridable pending request.
        const response: InteractionResponse = {
          decision: policy.effect === "allow" ? "allow" : "deny", source: "policy", reasonCode: policy.reasonCode,
        };
        await this.store.call("resolveInteraction", { id, response: response as unknown as Json });
        await this.journal.publish(`${request.kind}.resolved`, {
          sessionID: input.sessionId, runID: input.runId, id, decision: response.decision,
          reasonCode: policy.reasonCode, source: "policy",
        });
        return response;
      }
      // Listener registration precedes publishing; an immediate reply is safe.
      const body = payload !== null && !Array.isArray(payload) && typeof payload === "object" ? payload : {};
      await this.journal.publish(`${request.kind}.asked`, {
        ...body, sessionID: input.sessionId, runID: input.runId, id,
        ...(request.kind === "permission" ? { permission: request.operation, patterns: patternsOf(body) } : {}),
      });
      if (signal.aborted) choice.resolve({ decision: "deny", source: "cancelled", reasonCode: "RUN_CANCELLED" });
      let answer: InteractionResponse;
      try { answer = await bounded(choice.promise, this.timeoutMs); }
      catch { answer = { decision: "deny", source: "timeout", reasonCode: "INTERACTION_TIMEOUT" }; }
      const waiter = this.pending.get(id);
      if (waiter?.state === "waiting") await this.settle(id, waiter, answer);
      // Every asked request gets a matching resolution event, so a subscriber never stops at `asked`.
      await this.journal.publish(`${request.kind}.resolved`, {
        sessionID: input.sessionId, runID: input.runId, id, decision: answer.decision,
        ...(answer.source === undefined ? {} : { source: answer.source }),
        ...(answer.reasonCode === undefined ? {} : { reasonCode: answer.reasonCode }),
      });
      return answer;
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.pending.delete(id);
    }
  }
  async list(kind: "permission" | "question") {
    return (await this.store.call("listInteractions", { kind })).filter((row) => this.pending.has(row.id)).map((row) => ({
      ...(typeof row.payload === "object" && row.payload !== null && !Array.isArray(row.payload) ? row.payload : {}),
      ...(kind === "permission" ? { permission: row.operation, patterns: patternsOf(row.payload) } : {}),
      // Gateway identity comes last: an engine payload carrying its own id must not replace the
      // identifier a client has to send back, which is the same order the published event uses.
      id: row.id, sessionID: row.sessionId, created_at: row.createdAt,
    }));
  }
  async reply(id: string, kind: "permission" | "question", response: InteractionResponse): Promise<void> {
    const waiter = this.pending.get(id);
    if (waiter === undefined || waiter.kind !== kind) throw new PnpError("NOT_FOUND", "No pending interaction.", 404);
    if (!this.liveRuns.has(waiter.runId) || waiter.state !== "waiting") {
      throw new PnpError("INTERACTION_RESOLVED", "Interaction has already been resolved.", 409);
    }
    if (kind === "question" && response.decision === "allow") throw new PnpError("VALIDATION_ERROR", "Question requires an answer.", 400);
    await this.settle(id, waiter, { ...response, source: "user" });
  }
  private settle(id: string, waiter: NonNullable<ReturnType<InteractionBroker["pending"]["get"]>>,
    response: InteractionResponse): Promise<void> {
    waiter.state = "replying"; // Claim before the first await so concurrent replies cannot both win.
    const settlement = this.store.call("resolveInteraction", { id, response: response as unknown as Json }).then((changed) => {
      if (!changed) throw new PnpError("INTERACTION_RESOLVED", "Interaction has already been resolved.", 409);
      this.pending.delete(id);
      waiter.resolve(response);
    }).catch((error: unknown) => {
      this.pending.delete(id);
      // The decision could not be recorded, so it cannot be honoured as an approval.
      waiter.resolve({ decision: "deny", reasonCode: "INTERACTION_NOT_RECORDED" });
      throw error;
    });
    waiter.settlement = settlement;
    return settlement;
  }
}
