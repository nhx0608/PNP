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

/**
 * How an unattended deployment answers a `question`. `ask` is the interactive behaviour: the request
 * is published and the run waits for a client reply. `auto` is for an evaluation nobody is watching,
 * where a waiting question costs the whole case: the request is still recorded and still published,
 * so the trajectory shows what the engine asked, and the gateway then answers it immediately.
 */
export type QuestionPolicy = "auto" | "ask";
/**
 * The answer an unattended gateway gives: the first offered option, because an engine that offers
 * options treats the first as its own default, and an empty string when it offered none. Nothing is
 * invented about the subject of the question, and one answer array is produced per question so the
 * shape matches what the reply endpoint would have submitted.
 */
export function automaticAnswers(payload: Json): string[][] {
  const questions = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? payload["questions"] : undefined;
  if (!Array.isArray(questions)) return [[""]];
  return questions.map((question) => {
    const options = question !== null && typeof question === "object" && !Array.isArray(question)
      ? question["options"] : undefined;
    const first = Array.isArray(options) ? options[0] : undefined;
    if (typeof first === "string") return [first];
    if (first !== null && typeof first === "object" && !Array.isArray(first) && typeof first["label"] === "string") {
      return [first["label"]];
    }
    return [""];
  });
}
/** Questions and approvals are run-scoped; permission answers cannot override policy denial. */
export class InteractionBroker {
  private readonly liveRuns = new Set<string>();
  private readonly pending = new Map<string, {
    sessionId: string;
    operation: string;
    runId: string;
    kind: "permission" | "question";
    state: "waiting" | "replying";
    resolve(value: InteractionResponse): void;
    settlement?: Promise<void>;
  }>();
  /**
   * `(sessionId, operation)` pairs a user allowed with `always`. Contract section 7 forbids turning
   * `always` into a cross-session or organisational grant, so it is remembered here — in the gateway,
   * for this session and this operation only — and never handed to an engine as a native
   * allow-always. An organisational `deny` is checked first and is not affected by it.
   */
  private readonly remembered = new Set<string>();
  private readonly store: StateStore;
  private readonly journal: EventJournal;
  private readonly timeoutMs: number;
  private readonly questionPolicy: QuestionPolicy;
  constructor(store: StateStore, journal: EventJournal, timeoutMs = 45_000, questionPolicy: QuestionPolicy = "auto") {
    this.store = store; this.journal = journal; this.timeoutMs = timeoutMs; this.questionPolicy = questionPolicy;
  }
  private static rememberKey(sessionId: string, operation: string): string {
    return `${sessionId}\0${operation}`;
  }
  /** The memory belongs to the session; when the session is gone, so is it. */
  forgetSession(sessionId: string): void {
    const prefix = `${sessionId}\0`;
    for (const key of this.remembered) if (key.startsWith(prefix)) this.remembered.delete(key);
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
    this.pending.set(id, {
      sessionId: input.sessionId, operation: request.operation, runId: input.runId,
      kind: request.kind, state: "waiting", resolve: choice.resolve,
    });
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
      // Only `ask` reaches here, so this is the operation the user was already asked about once and
      // answered with `always`. It is resolved without publishing a request nobody has to answer;
      // the resolution is still recorded and published, so the trajectory shows why it was allowed.
      if (request.kind === "permission" && this.remembered.has(InteractionBroker.rememberKey(input.sessionId, request.operation))) {
        const response: InteractionResponse = {
          decision: "allow", source: "remembered", reasonCode: "USER_ALLOWED_ALWAYS",
        };
        await this.store.call("resolveInteraction", { id, response: response as unknown as Json });
        await this.journal.publish("permission.resolved", {
          sessionID: input.sessionId, runID: input.runId, id, decision: "allow",
          reasonCode: "USER_ALLOWED_ALWAYS", source: "remembered",
        });
        return response;
      }
      // Listener registration precedes publishing; an immediate reply is safe.
      const body = payload !== null && !Array.isArray(payload) && typeof payload === "object" ? payload : {};
      await this.journal.publish(`${request.kind}.asked`, {
        ...body, sessionID: input.sessionId, runID: input.runId, id,
        ...(request.kind === "permission" ? { permission: request.operation, patterns: patternsOf(body) } : {}),
      });
      // An unattended deployment answers its own questions: the request above was recorded and
      // published first, so the trajectory carries the question exactly as an interactive run would,
      // and everything below -- storage, the resolution event, the waiting driver -- runs unchanged.
      if (request.kind === "question" && this.questionPolicy === "auto") {
        choice.resolve({
          decision: "answer", answers: automaticAnswers(payload), source: "auto",
          reasonCode: "QUESTION_AUTO_ANSWERED",
        });
      }
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
  /**
   * A client reply. `remember` is the `always` form of a permission approval: it is kept for this
   * session and this operation only (see `remembered`), and it changes nothing about THIS response,
   * which stays an ordinary one-off allow as far as the engine is concerned.
   */
  async reply(id: string, kind: "permission" | "question", response: InteractionResponse,
    options: { remember?: boolean } = {}): Promise<void> {
    const waiter = this.pending.get(id);
    if (waiter === undefined || waiter.kind !== kind) throw new PnpError("NOT_FOUND", "No pending interaction.", 404);
    if (!this.liveRuns.has(waiter.runId) || waiter.state !== "waiting") {
      throw new PnpError("INTERACTION_RESOLVED", "Interaction has already been resolved.", 409);
    }
    if (kind === "question" && response.decision === "allow") throw new PnpError("VALIDATION_ERROR", "Question requires an answer.", 400);
    await this.settle(id, waiter, { ...response, source: "user" });
    // Recorded only once the approval itself is settled, so a reply that lost a race remembers nothing.
    if (options.remember === true && kind === "permission" && response.decision === "allow") {
      this.remembered.add(InteractionBroker.rememberKey(waiter.sessionId, waiter.operation));
    }
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
