import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, rm } from "node:fs/promises";
import path from "node:path";
import type {
  DriverEvent, EnginePack, EngineResult, EngineSessionChannel, IntegrationProvider, IntegrationContext,
  Json, Message, MessageFinish, PromptRequest, PublicEvent, Run, Session, StopReason, TerminalState,
} from "../contracts/index.ts";
import type { ProcessHost } from "../contracts/host.ts";
import type { RecoverySummary } from "../runtime/recovery.ts";
import { LocalProcessHost } from "../runtime/process-host.ts";
import { StateStore } from "../storage/store.ts";
import { EventJournal } from "./journal.ts";
import { InteractionBroker } from "./interactions.ts";
import { PnpError, asPnpError } from "./errors.ts";
import { bounded, deferred } from "../runtime/deadline.ts";
import { OwnedResourceScope } from "../runtime/resource-scope.ts";
import { normalizeWorkspace } from "../security/workspace.ts";
import { Redactor } from "../security/redaction.ts";

interface ActiveRun {
  controller: AbortController;
  stop: ReturnType<typeof deferred<StopReason>>;
  done: ReturnType<typeof deferred<void>>;
  runId: string;
  reason?: StopReason;
}
export interface CoreOptions {
  processHost?: ProcessHost;
  dataDirectory: string;
  runTimeoutMs?: number;
  openTimeoutMs?: number;
  cancelGraceMs?: number;
  interactionTimeoutMs?: number;
  maxResidentSessions?: number;
}
const makeMessage = (role: Message["role"], content: string): Message => ({
  id: randomUUID(), role, content, created_at: new Date().toISOString(),
});
const owns = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key);
/** Both spellings are emitted: assessment clients read either `content` or `text`. */
const textPart = (value: string): Json => ({ type: "text", content: value, text: value });

/** Owns run truth and event ordering; adapters cannot mutate storage or HTTP state. */
export class GatewayCore {
  readonly journal: EventJournal;
  readonly interactions: InteractionBroker;
  private readonly store: StateStore;
  private readonly engine: EnginePack;
  private readonly integration: IntegrationProvider;
  private readonly options: Required<Omit<CoreOptions, "processHost">>;
  private readonly processHost: ProcessHost;
  private readonly channels = new Map<string, EngineSessionChannel>();
  private readonly scopes = new Map<string, OwnedResourceScope>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly deleting = new Set<string>();
  private readonly lastUsedAt = new Map<string, number>();
  /**
   * Sessions whose execution stop could not be proven. The fence is per session because an
   * unverifiable stop is evidence about one native channel, never about the gateway process.
   */
  private readonly fenced = new Map<string, { reason: string; at: string }>();
  private recovery: {
    at: string; interrupted: number; confirmedSessions: number; blockedSessions: number;
    invalidRecords: number; unverifiedRecords: number; quarantinedRecords: number; archivedRecords: number;
    issues: RecoverySummary["issues"];
  } | null = null;
  private reserved = false;
  private draining = false;
  private healthy = true;

  private observeFailure(error: unknown): PnpError {
    const failure = asPnpError(error);
    // `healthy` expresses storage availability only. A single failed operation is not unavailability,
    // otherwise one busy-timeout would remove the gateway for the rest of the round.
    if (failure.code.startsWith("STORAGE_") && !this.store.available) this.healthy = false;
    return failure;
  }
  /** Blocks one session until its stop is proven; the gateway stays available for every other session. */
  private fence(sessionId: string, reason: string): void {
    this.fenced.set(sessionId, { reason, at: new Date().toISOString() });
  }
  /** Proof of stop is the only thing that lifts a fence, and it also clears the persisted block. */
  private async liftFence(sessionId: string): Promise<void> {
    if (!this.fenced.delete(sessionId)) return;
    try { await this.store.call("confirmStopped", { sessionId }); }
    catch (error) { this.observeFailure(error); }
  }

  private async disposeSessionResources(id: string, operation: "terminate" | "close"): Promise<boolean> {
    let quiescent = true;
    const channel = this.channels.get(id);
    if (channel !== undefined) {
      try { quiescent = (await bounded(channel[operation](), this.options.cancelGraceMs)).quiescent; }
      catch { quiescent = false; }
      finally { this.channels.delete(id); this.lastUsedAt.delete(id); }
    }
    const scope = this.scopes.get(id);
    if (scope !== undefined) {
      let scopeQuiescent = false;
      try { scopeQuiescent = (await scope.stop(this.options.cancelGraceMs)).quiescent; }
      catch { scopeQuiescent = false; }
      if (scopeQuiescent) this.scopes.delete(id);
      quiescent = scopeQuiescent && quiescent;
    }
    return quiescent;
  }
  /**
   * Frees a resident slot instead of failing the ninth case of a round. `close` keeps native history,
   * and the confirmed stop tells the next turn to reattach rather than assume a warm channel.
   */
  private async evictResidentChannel(exclude: string): Promise<void> {
    const candidates = [...this.channels.keys()]
      .filter((id) => id !== exclude && !this.active.has(id) && !this.deleting.has(id))
      .sort((a, b) => (this.lastUsedAt.get(a) ?? 0) - (this.lastUsedAt.get(b) ?? 0));
    for (const victim of candidates) {
      if (await this.disposeSessionResources(victim, "close")) {
        try { await this.store.call("confirmStopped", { sessionId: victim }); }
        catch (error) { throw this.observeFailure(error); }
      } else {
        this.fence(victim, "EVICTION_STOP_UNVERIFIED");
      }
      if (this.channels.size < this.options.maxResidentSessions) return;
    }
    throw new PnpError("HOST_CAPACITY", "Resident session capacity reached and no channel could be released.", 503);
  }

  constructor(store: StateStore, engine: EnginePack, integration: IntegrationProvider, options: CoreOptions) {
    this.store = store;
    this.engine = engine;
    this.integration = integration;
    this.processHost = options.processHost ?? new LocalProcessHost(options.dataDirectory);
    this.options = {
      dataDirectory: options.dataDirectory,
      runTimeoutMs: options.runTimeoutMs ?? 900_000,
      openTimeoutMs: options.openTimeoutMs ?? 60_000,
      cancelGraceMs: options.cancelGraceMs ?? 15_000,
      interactionTimeoutMs: options.interactionTimeoutMs ?? 45_000,
      maxResidentSessions: options.maxResidentSessions ?? 16,
    };
    this.journal = new EventJournal(store);
    this.interactions = new InteractionBroker(store, this.journal, this.options.interactionTimeoutMs);
  }
  async initialize(): Promise<void> {
    await this.store.call("recover", null);
    // History that could not prove a stop fences its own session. It does not remove readiness:
    // a restart with a clean new session must be able to run.
    for (const session of await this.store.call("listSessions", null)) {
      if (session.recovery === "blocked") this.fence(session.id, "STARTUP_STOP_UNVERIFIED");
    }
  }
  /** Ownership verification narrows to the sessions it names; sessions created since then are untouched. */
  applyRecovery(summary: RecoverySummary): void {
    this.recovery = {
      at: new Date().toISOString(), interrupted: summary.interrupted,
      confirmedSessions: summary.confirmedSessions, blockedSessions: summary.blockedSessions,
      invalidRecords: summary.invalidRecords, unverifiedRecords: summary.unverifiedRecords,
      quarantinedRecords: summary.quarantinedRecords, archivedRecords: summary.archivedRecords,
      issues: summary.issues,
    };
    for (const id of summary.clearedSessions) if (!this.active.has(id)) this.fenced.delete(id);
    for (const id of summary.fencedSessions) if (!this.active.has(id)) this.fence(id, "RECOVERY_STOP_UNVERIFIED");
  }
  /** Records why verification itself could not run; it never becomes an admission gate. */
  noteRecoveryFailure(code: string): void {
    this.recovery = {
      at: new Date().toISOString(), interrupted: 0, confirmedSessions: 0, blockedSessions: 0,
      invalidRecords: 0, unverifiedRecords: 0, quarantinedRecords: 0, archivedRecords: 0,
      issues: [{ file: "", reason: "verification-failed", detail: code }],
    };
  }
  get readiness(): boolean { return this.healthy && !this.draining && this.store.available; }
  get engineId(): string { return this.engine.descriptor.id; }
  get channelId(): string { return this.engine.descriptor.channelId; }
  async diagnostics() {
    let persisted: { sessions: number | null; runs: number | null; interrupted: number | null; blocked: number | null };
    let storageError: string | undefined;
    try { persisted = await this.store.call("diagnostics", null); }
    catch (error) {
      // A failed diagnostics read is reported, never latched: reading state must not remove readiness.
      storageError = asPnpError(error).code;
      persisted = { sessions: null, runs: null, interrupted: null, blocked: null };
    }
    return { ...persisted, ready: this.readiness, storage: this.store.diagnosticsSnapshot(),
      ...(storageError === undefined ? {} : { storageError }),
      degraded: this.fenced.size > 0,
      fencedSessions: [...this.fenced].map(([id, entry]) => ({ id, reason: entry.reason, at: entry.at })),
      recovery: this.recovery,
      activeRuns: this.active.size, residentChannels: this.channels.size, engine: this.engineId, channel: this.channelId };
  }
  async createSession(directory: string, title?: string): Promise<Session> {
    if (!this.readiness) throw new PnpError("SERVICE_UNAVAILABLE", "Gateway is not ready.", 503);
    const now = new Date().toISOString();
    return this.store.call("createSession", {
      id: `ses_${randomUUID()}`, title: title ?? "PNP session",
      directory: await normalizeWorkspace(directory), engineId: this.engineId, channelId: this.channelId,
      lifecycle: "active", status: "idle", recovery: "ready", createdAt: now, updatedAt: now,
    });
  }
  async getSession(id: string): Promise<Session> {
    const session = await this.store.call("getSession", { id });
    if (session === null) throw new PnpError("NOT_FOUND", "Session not found.", 404);
    return session;
  }
  async messages(id: string): Promise<Message[]> {
    await this.getSession(id);
    return this.store.call("messages", { sessionId: id });
  }
  /** Committed events after a sequence number, for a subscriber that reconnected. */
  async eventsSince(afterSequence: number, limit?: number): Promise<PublicEvent[]> {
    return this.journal.since(afterSequence, limit);
  }
  async status(): Promise<Record<string, { type: "idle" | "busy" }>> {
    return Object.fromEntries((await this.store.call("listSessions", null))
      .filter((s) => s.lifecycle === "active").map((s) => [s.id, { type: s.status }]));
  }
  private nativeDirectory(id: string): string {
    if (!/^ses_[a-f0-9-]{36}$/.test(id)) throw new PnpError("VALIDATION_ERROR", "Invalid session identifier.", 400);
    return path.join(this.options.dataDirectory, "native", this.engineId, this.channelId, id);
  }
  async run(sessionId: string, request: PromptRequest, idempotencyKey?: string): Promise<void> {
    const hash = createHash("sha256").update(JSON.stringify({
      parts: request.parts, model: request.model, agent: request.agent ?? "assistant",
    })).digest("hex");
    if (idempotencyKey !== undefined) {
      const previous = await this.store.call("findRunByKey", { sessionId, key: idempotencyKey });
      if (previous !== null) {
        if (previous.requestHash !== hash) throw new PnpError("IDEMPOTENCY_CONFLICT", "Key was used for another request.", 409);
        if (previous.state === "completed") return;
        // `failed` and `cancelled` are proven terminal states, so the key is released and a retry may
        // start a new run. `running`, `cancelling` and `interrupted` keep it: an unproven stop is never replayed.
        if (previous.state !== "failed" && previous.state !== "cancelled") {
          throw new PnpError("RUN_ALREADY_EXISTS", "The recorded run must not be replayed.", 409);
        }
        await this.store.call("releaseIdempotencyKey", { runId: previous.id });
      }
    }
    if (!this.readiness) throw new PnpError("SERVICE_UNAVAILABLE", "Gateway is not ready.", 503);
    if (this.reserved) throw new PnpError("GATEWAY_BUSY", "Execution slot is occupied.", 409);
    if (this.deleting.has(sessionId)) throw new PnpError("SESSION_UNAVAILABLE", "Session is being deleted.", 409);
    if (this.fenced.has(sessionId)) throw new PnpError("SESSION_UNAVAILABLE", "Session is fenced until its execution stop is proven.", 409);
    this.reserved = true;
    const ctx: ActiveRun = { controller: new AbortController(), stop: deferred<StopReason>(), done: deferred<void>(), runId: `run_${randomUUID()}` };
    this.active.set(sessionId, ctx);
    const timer = setTimeout(() => this.requestStop(sessionId, "deadline"), this.options.runTimeoutMs);
    let started = false;
    let quiescent = true;
    let terminated = false;
    let channel: EngineSessionChannel | undefined;
    let scope = this.scopes.get(sessionId);
    let integration: IntegrationContext | undefined;
    let opening: Promise<EngineSessionChannel> | undefined;
    let openSettled = true;
    let discardOpening = false;
    let state: TerminalState = "failed";
    let finish: MessageFinish = "error";
    let nativeStopReason: string | undefined;
    let taskOutcome: "unknown" | "succeeded" | "failed" = "unknown";
    let text = "";
    let rawText = "";
    let rawBytes = 0;
    let failure: PnpError | undefined;
    let acceptingEvents = true;
    let eventTail = Promise.resolve();
    let eventFailure: PnpError | undefined;
    const tools = new Map<string, {
      family: "legacy" | "observed";
      name?: string;
      /** Where the canonical name came from; a driver may name a call by the title it announced it under. */
      nameSource?: "name" | "announced-title";
      input?: Json;
      inputObserved: boolean;
      message: Message;
      canonical: boolean;
      terminal: boolean;
      terminalOutputObserved: boolean;
      outputPersisted: boolean;
      status?: "pending" | "running" | "completed" | "failed";
    }>();
    const finalId = randomUUID();
    let redactor = new Redactor();
    let lastTextCheckpoint = 0;
    let checkpointBytes = 0;
    try {
      const session = await this.getSession(sessionId);
      if (session.engineId !== this.engineId || session.channelId !== this.channelId) {
        throw new PnpError("ENGINE_SESSION_MISMATCH", "Session belongs to another engine channel.", 409);
      }
      if (session.status !== "idle" || session.recovery === "blocked" || session.lifecycle !== "active") {
        throw new PnpError("SESSION_UNAVAILABLE", "Session cannot accept execution.", 409);
      }
      const preparing = this.integration.prepare({ session, request, signal: ctx.controller.signal });
      try { integration = await bounded(preparing, this.options.openTimeoutMs); }
      catch (error) {
        // A provider may ignore cancellation and resolve after the caller has timed out. Observe and release it.
        void preparing.then(async (late) => {
          if (this.integration.release === undefined) return;
          try { await bounded(this.integration.release(late), this.options.cancelGraceMs); }
          catch { this.fence(sessionId, "INTEGRATION_RELEASE_UNVERIFIED"); }
        }, () => undefined);
        throw error;
      }
      const secrets = [...Object.values(integration.model.headers), ...integration.tools.flatMap((t) => Object.values(t.env))];
      redactor = new Redactor(secrets);
      if (ctx.controller.signal.aborted) throw new PnpError("EXECUTION_CANCELLED", "Cancelled before execution.", 409);
      const run: Run = { id: ctx.runId, sessionId, state: "running", requestHash: hash, startedAt: new Date().toISOString(),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }) };
      await this.store.call("startRun", { run, message: makeMessage("user", redactor.text(request.parts.map((p) => p.text).join("\n"))) });
      this.interactions.beginRun(run.id);
      started = true;
      await this.journal.publish("session.status", { sessionID: sessionId, runID: run.id, status: { type: "busy" } });
      channel = this.channels.get(sessionId);
      if (channel === undefined) {
        if (this.channels.size >= this.options.maxResidentSessions) await this.evictResidentChannel(sessionId);
        const directory = this.nativeDirectory(sessionId);
        await mkdir(directory, { recursive: true });
        scope = new OwnedResourceScope();
        const openScope = scope;
        this.scopes.set(sessionId, scope);
        quiescent = false;
        openSettled = false;
        opening = this.engine.open({ host: this.processHost, session, nativeDataDirectory: directory, integration, resources: scope, signal: ctx.controller.signal });
        // Every resolution is observed, including a channel returned after cancellation.
        void opening.then(async (late) => {
          openSettled = true;
          if (!discardOpening) return;
          let stopped = false;
          try { stopped = (await bounded(late.terminate(), this.options.cancelGraceMs)).quiescent; }
          catch { stopped = false; }
          if (stopped && !openScope.closed) {
            try { stopped = (await openScope.stop(this.options.cancelGraceMs)).quiescent; }
            catch { stopped = false; }
          }
          if (stopped && this.scopes.get(sessionId) === openScope) this.scopes.delete(sessionId);
          // A late channel that proved it stopped is exactly the evidence the fence was waiting for.
          if (stopped && !this.active.has(sessionId)) await this.liftFence(sessionId);
        }, () => { openSettled = true; }).catch(() => undefined);
        channel = await bounded(Promise.race([
          opening,
          ctx.stop.promise.then(() => { throw new PnpError("EXECUTION_CANCELLED", "Cancelled during engine startup.", 409); }),
        ]), this.options.openTimeoutMs);
        this.channels.set(sessionId, channel);
        if (channel.native.channelId !== this.channelId) throw new PnpError("CHANNEL_MISMATCH", "Engine returned a different channel.", 502);
        await this.store.call("bindNative", { id: sessionId, native: channel.native });
        quiescent = true;
      }
      this.lastUsedAt.set(sessionId, Date.now());
      const resolved = integration;
      const services = {
        events: { emit: (event: DriverEvent): Promise<void> => {
          // One rejected event is a statement about that event. Only afterwards is the channel closed,
          // so a driver can tell "this event was invalid" from "the channel is gone".
          if (eventFailure !== undefined) {
            return Promise.reject(new PnpError("EVENT_CHANNEL_CLOSED", "The event channel closed after an earlier rejected event.", 409));
          }
          const delivery = eventTail.then(async () => {
            if (!acceptingEvents) return;
            if (Buffer.byteLength(JSON.stringify(event)) > 1024 * 1024) throw new PnpError("EVENT_TOO_LARGE", "Use an artifact reference.", 502);
            const properties: { [key: string]: Json } = { sessionID: sessionId, runID: run.id, messageID: finalId };
            if (event.type === "text.delta") {
              rawText += event.text;
              rawBytes += Buffer.byteLength(event.text);
              if (rawBytes > 8 * 1024 * 1024) throw new PnpError("OUTPUT_TOO_LARGE", "Output exceeds the configured limit.", 502);
              // Amortized checkpoints: a checkpoint must add a quarter of what is already stored, so a long
              // answer costs O(total) rewritten bytes instead of O(total^2). Redaction runs after this
              // decision, so it is not a second quadratic pass over the accumulated text.
              const now = Date.now();
              if (now - lastTextCheckpoint < 100) return;
              if (rawBytes - checkpointBytes < Math.max(4096, Math.floor(checkpointBytes / 4))) return;
              lastTextCheckpoint = now;
              checkpointBytes = rawBytes;
              text = redactor.streamText(rawText);
              await this.store.call("appendMessage", { sessionId, runId: run.id,
                message: { ...makeMessage("assistant", text), id: finalId, parts: [textPart(text)] } });
              properties.part = textPart(text);
            } else if (event.type === "tool.started") {
              const existing = tools.get(event.callId);
              if (existing?.family === "observed") throw new PnpError("ENGINE_PROTOCOL_ERROR", "Tool event families cannot be mixed.", 502);
              if (existing !== undefined) throw new PnpError("DUPLICATE_TOOL", "Duplicate tool identity.", 502);
              const item = makeMessage("assistant", "");
              const args = redactor.json(event.input);
              item.tool_calls = [{ id: event.callId, name: event.name, arguments: args }];
              item.info = { role: "assistant", finish: "tool-calls" };
              item.parts = [{ type: "tool", tool: event.name, callID: event.callId, input: args,
                state: { status: "running", title: event.name } }];
              tools.set(event.callId, { family: "legacy", name: event.name, input: args, inputObserved: true,
                message: item, canonical: true, terminal: false, terminalOutputObserved: false, outputPersisted: false,
                status: "running" });
              await this.store.call("appendMessage", { sessionId, runId: run.id, message: item });
              properties.messageID = item.id;
              properties.part = item.parts[0]!;
            } else if (event.type === "tool.updated") {
              const tool = tools.get(event.callId);
              if (tool?.family === "observed") throw new PnpError("ENGINE_PROTOCOL_ERROR", "Tool event families cannot be mixed.", 502);
              if (tool === undefined || tool.terminal || tool.name === undefined) throw new PnpError("UNMATCHED_TOOL_UPDATE", "Tool is not active.", 502);
              properties.messageID = tool.message.id;
              properties.part = { type: "tool", tool: tool.name, callID: event.callId, input: tool.input ?? null,
                state: { status: "running", title: redactor.text(event.title) } };
            } else if (event.type === "tool.finished") {
              const tool = tools.get(event.callId);
              if (tool?.family === "observed") throw new PnpError("ENGINE_PROTOCOL_ERROR", "Tool event families cannot be mixed.", 502);
              if (tool === undefined || tool.terminal || !tool.canonical || tool.name === undefined) throw new PnpError("UNMATCHED_TOOL_RESULT", "Tool result has no active call.", 502);
              tool.terminal = true;
              tool.status = event.failed ? "failed" : "completed";
              tool.outputPersisted = true;
              const output = redactor.json(event.output);
              const item = makeMessage("tool", JSON.stringify(output));
              item.tool_call_id = event.callId;
              item.tool_name = tool.name;
              const part: Json = { type: "tool", tool: tool.name, callID: event.callId, input: tool.input ?? null, output,
                state: { status: event.failed ? "error" : "completed", title: tool.name, source: "engine" } };
              tool.message.parts = [part];
              await this.store.call("appendMessage", { sessionId, runId: run.id, message: tool.message });
              await this.store.call("appendMessage", { sessionId, runId: run.id, message: item });
              properties.messageID = tool.message.id;
              properties.part = part;
            } else if (event.type === "tool.observed") {
              const name = event.name;
              const hasName = owns(event, "name") && typeof name === "string";
              const hasInput = owns(event, "input") && event.input !== undefined;
              const hasOutput = owns(event, "output") && event.output !== undefined;
              const hasContent = owns(event, "content") && event.content !== undefined;
              const hasLocations = owns(event, "locations") && event.locations !== undefined;
              let tool = tools.get(event.callId);
              if (tool === undefined) {
                tool = { family: "observed", message: makeMessage("assistant", ""), inputObserved: false, canonical: false,
                  terminal: false, terminalOutputObserved: false, outputPersisted: false };
                tools.set(event.callId, tool);
              }
              if (tool.family !== "observed") throw new PnpError("ENGINE_PROTOCOL_ERROR", "Tool event families cannot be mixed.", 502);
              if (hasName) {
                if (tool.name !== undefined && tool.name !== name) throw new PnpError("ENGINE_PROTOCOL_ERROR", "Tool identity changed during execution.", 502);
                tool.name = name;
                if (event.nameSource !== undefined) tool.nameSource = event.nameSource;
              }
              if (hasInput) {
                tool.input = redactor.json(event.input ?? null);
                tool.inputObserved = true;
              }
              if (!tool.canonical && tool.name !== undefined && tool.inputObserved) {
                tool.canonical = true;
                tool.message.tool_calls = [{ id: event.callId, name: tool.name, arguments: tool.input ?? null }];
                tool.message.info = { role: "assistant", finish: "tool-calls" };
              } else if (tool.canonical && hasInput && tool.message.tool_calls?.[0] !== undefined) {
                tool.message.tool_calls[0].arguments = tool.input ?? null;
              }
              const observedTerminal = event.status === "completed" || event.status === "failed";
              if (observedTerminal && hasOutput) tool.terminalOutputObserved = true;
              if (!tool.terminal && event.status !== undefined) tool.status = event.status;
              if (!tool.terminal && observedTerminal) tool.terminal = true;
              const status = tool.terminal ? (tool.status ?? "failed") : (event.status ?? tool.status ?? "pending");
              // The spec's tool part is {type, tool, state:{status, title}}; the observation keeps its own
              // fields and mirrors that shape, so a reader of the reference shape sees the call as well.
              const observedTitle = event.title === undefined ? undefined : redactor.text(event.title);
              const observation: { [key: string]: Json } = {
                type: "tool", callID: event.callId, source: event.source, phase: event.phase,
                state: {
                  status,
                  ...(observedTitle === undefined ? {} : { title: observedTitle }),
                  ...(tool.nameSource === undefined ? {} : { nameSource: tool.nameSource }),
                  ...(observedTerminal && !tool.terminalOutputObserved ? { terminalStatus: "result_unknown" } : {}),
                  ...(event.nativeStatus === undefined ? {} : { nativeStatus: redactor.text(event.nativeStatus) }),
                  ...(event.nativeType === undefined ? {} : { nativeType: redactor.text(event.nativeType) }),
                },
              };
              if (tool.name !== undefined) observation.tool = redactor.text(tool.name);
              if (observedTitle !== undefined) observation.title = observedTitle;
              if (hasInput) observation.input = redactor.json(event.input ?? null);
              if (hasOutput) observation.output = redactor.json(event.output ?? null);
              if (hasContent) observation.content = redactor.json(event.content ?? []);
              if (hasLocations) observation.locations = redactor.json(event.locations ?? []);
              if (event.nativeType !== undefined) observation.nativeType = redactor.text(event.nativeType);
              if (event.nativeStatus !== undefined) observation.nativeStatus = redactor.text(event.nativeStatus);
              tool.message.parts = [...(tool.message.parts ?? []), observation];
              await this.store.call("appendMessage", { sessionId, runId: run.id, message: tool.message });
              properties.messageID = tool.message.id;
              properties.part = observation;
              // An observation can carry native output without proving a canonical tool result.
              // Null is an observed output; only a missing property is missing output.
              if (observedTerminal && tool.canonical && tool.name !== undefined && hasOutput && !tool.outputPersisted) {
                tool.outputPersisted = true;
                const item = makeMessage("tool", JSON.stringify(redactor.json(event.output ?? null)));
                item.tool_call_id = event.callId;
                item.tool_name = tool.name;
                await this.store.call("appendMessage", { sessionId, runId: run.id, message: item });
              }
            } else if (event.type === "usage") {
              await this.journal.publish("run.usage", { ...properties, ...event });
              return;
            } else {
              await this.journal.publish("engine.extension", { ...properties, namespace: event.namespace,
                nativeType: event.eventName, payload: redactor.json(event.payload) });
              return;
            }
            await this.journal.publish("message.part.updated", properties);
          });
          // The chain records the first failure once and then stays usable for ordering; the driver
          // still receives this event's own rejection.
          eventTail = delivery.catch((error: unknown) => {
            if (eventFailure === undefined) eventFailure = this.observeFailure(error);
          });
          return delivery;
        } },
        interact: async (request: Parameters<IntegrationContext["authorize"]>[0]) => {
          const policy = await bounded(resolved.authorize(request), this.options.openTimeoutMs);
          return this.interactions.request({ sessionId, runId: run.id, request, policy, signal: ctx.controller.signal, redactor });
        },
      };
      quiescent = false;
      // The provider is the authority on the model this turn runs on: it resolved an omitted
      // selection to the default and validated an explicit one. The driver receives that binding,
      // never the caller's raw wish, so "use the default" is not mistaken for a model switch.
      const bound: PromptRequest = { ...request, model: integration.model.selection };
      const execution = channel.run({ runId: run.id, request: bound, integration, services, signal: ctx.controller.signal });
      const first = await Promise.race([
        execution.then((result) => ({ kind: "result" as const, result })),
        ctx.stop.promise.then((reason) => ({ kind: "stop" as const, reason })),
      ]);
      if (first.kind === "stop") {
        await this.store.call("cancelling", { runId: run.id });
        try { await bounded(channel.cancel(first.reason), this.options.cancelGraceMs); } catch { /* Escalate below. */ }
        let result: EngineResult | undefined;
        try { result = await bounded(execution, this.options.cancelGraceMs); } catch { /* Keep receiving available events. */ }
        quiescent = result?.quiescent === true;
        if (!quiescent) {
          terminated = true;
          quiescent = await this.disposeSessionResources(sessionId, "terminate");
        }
        nativeStopReason = result?.nativeStopReason;
        state = first.reason === "deadline" ? "failed" : "cancelled";
        finish = state === "cancelled" ? "cancelled" : "error";
        failure = this.stopError(first.reason);
      } else {
        state = first.result.state;
        finish = first.result.finish;
        nativeStopReason = first.result.nativeStopReason;
        taskOutcome = first.result.taskOutcome;
        const provided = redactor.text(first.result.finalText);
        // An empty final text must not erase what the engine already streamed.
        text = provided === "" ? redactor.text(rawText) : provided;
        quiescent = first.result.quiescent;
        if (!quiescent) {
          // A real terminal turn whose resources are unproven keeps its trajectory; process-level
          // evidence, not the driver's word, decides whether the session may take the next turn.
          terminated = true;
          quiescent = await this.disposeSessionResources(sessionId, "terminate");
        }
        if (ctx.reason !== undefined) {
          state = ctx.reason === "deadline" ? "failed" : "cancelled";
          finish = state === "cancelled" ? "cancelled" : "error";
          failure = this.stopError(ctx.reason);
        } else if (state !== "completed" || finish !== "stop") {
          state = state === "cancelled" ? "cancelled" : "failed";
          failure = new PnpError("BAD_GATEWAY", "Engine did not finish normally.", 502);
        }
      }
      await eventTail;
      acceptingEvents = false;
      if (eventFailure !== undefined) throw eventFailure;
      // A call the engine never closed is not a failed turn: the engine's own stop reason decides the
      // state, and the finally block records `result_unknown` for each call left non-terminal. Judging
      // the turn on it would replace a real final answer with an error the engine never gave.
    } catch (error) {
      failure = this.observeFailure(error);
      state = "failed";
      finish = "error";
      if (ctx.reason !== undefined) {
        state = ctx.reason === "deadline" ? "failed" : "cancelled";
        finish = state === "cancelled" ? "cancelled" : "error";
        failure = this.stopError(ctx.reason);
      }
      discardOpening = true;
      ctx.controller.abort(ctx.reason ?? "failure");
      if (channel !== undefined) {
        terminated = true;
        quiescent = await this.disposeSessionResources(sessionId, "terminate");
      } else if (opening !== undefined) {
        const evidence = await scope!.stop(this.options.cancelGraceMs);
        // Unsettled startup can still return a resource; the late handler above lifts the fence
        // once that channel proves it stopped.
        quiescent = openSettled && evidence.quiescent;
        if (quiescent) this.scopes.delete(sessionId);
      }
      acceptingEvents = false;
      await eventTail.catch(() => undefined);
    } finally {
      clearTimeout(timer);
      acceptingEvents = false;
      if (!quiescent) {
        state = "interrupted";
        finish = "interrupted";
        this.fence(sessionId, "RUN_STOP_UNVERIFIED");
      }
      try {
        if (started) {
          ctx.controller.abort(ctx.reason ?? "settled");
          await this.interactions.endRun(ctx.runId);
          // Record an observation, not a fabricated tool response or success. A turn the engine completed
          // takes this path too: its stop reason stands and each call it left open is recorded here as
          // `result_unknown`, so nothing is invented and nothing is silently dropped.
          for (const [callId, tool] of tools) {
            if (tool.terminal) continue;
            tool.message.parts = [...(tool.message.parts ?? []), { type: "tool",
              ...(tool.name === undefined ? {} : { tool: tool.name }),
              ...(tool.inputObserved ? { input: tool.input ?? null } : {}), callID: callId,
              state: { status: "error", terminalStatus: state === "cancelled" ? "cancelled" : "result_unknown",
                source: "gateway-observation", quiescent, title: "No complete engine tool result was received." } }];
            tool.terminal = true;
            await this.store.call("appendMessage", { sessionId, runId: ctx.runId, message: tool.message });
            await this.journal.publish("message.part.updated", { sessionID: sessionId, runID: ctx.runId,
              messageID: tool.message.id, part: tool.message.parts.at(-1)! });
          }
          const succeeded = state === "completed" && finish === "stop";
          const detail = failure === undefined ? "" : `Execution did not complete normally: ${failure.code}: ${failure.message}`;
          // A failed turn must not be represented by the engine's optimistic last words alone.
          const content = succeeded ? text : [text, detail].filter((part) => part !== "").join("\n\n");
          const message = { ...makeMessage("assistant", content), id: finalId };
          message.info = { role: "assistant", finish, ...(nativeStopReason === undefined ? {} : { nativeFinish: nativeStopReason }) };
          message.parts = [textPart(message.content)];
          if (succeeded) message.parts.push({ type: "step-finish" });
          await this.store.call("finishRun", { runId: ctx.runId, state, message, quiescent, taskOutcome,
            nativeResumeRequired: terminated,
            ...(nativeStopReason === undefined ? {} : { nativeStopReason }),
            ...(failure === undefined ? {} : { errorCode: failure.code }) });
          // Publication follows the commit: a subscriber must never see a terminal state that storage rejected.
          for (const part of message.parts) {
            await this.journal.publish("message.part.updated", { sessionID: sessionId, runID: ctx.runId, messageID: finalId, part });
          }
          if (failure !== undefined) await this.journal.publish("session.error", { sessionID: sessionId, runID: ctx.runId,
            error: { message: failure.message, code: failure.code } });
          if (quiescent) {
            await this.journal.publish("session.status", { sessionID: sessionId, runID: ctx.runId, status: { type: "idle" } });
            await this.journal.publish("session.idle", { sessionID: sessionId, runID: ctx.runId });
          }
        }
      } catch (error) {
        failure = this.observeFailure(error);
        this.fence(sessionId, "TERMINAL_PERSISTENCE_UNVERIFIED");
      }
      try {
        if (integration !== undefined && this.integration.release !== undefined) {
          await bounded(this.integration.release(integration), this.options.cancelGraceMs);
        }
      } catch (error) {
        this.fence(sessionId, "INTEGRATION_RELEASE_UNVERIFIED");
        if (failure === undefined) failure = this.observeFailure(error);
      }
      if (this.channels.has(sessionId)) this.lastUsedAt.set(sessionId, Date.now());
      this.active.delete(sessionId);
      // The execution slot belongs to one turn; the fence, not the slot, carries the uncertainty.
      this.reserved = false;
      ctx.done.resolve();
    }
    // An unproven stop is the more severe fact and must not be reported as a plain cancellation.
    if (!quiescent) throw new PnpError("EXECUTION_UNCERTAIN", "Execution stop is unverified.", 503);
    if (failure !== undefined) throw failure;
  }
  private stopError(reason: StopReason): PnpError {
    return new PnpError(reason === "deadline" ? "EXECUTION_TIMEOUT" : "EXECUTION_CANCELLED",
      "Execution was stopped.", reason === "deadline" ? 504 : 409);
  }
  private requestStop(id: string, reason: StopReason): void {
    const current = this.active.get(id);
    if (current === undefined || current.reason !== undefined) return;
    current.reason = reason;
    current.controller.abort(reason);
    current.stop.resolve(reason);
  }
  async abort(id: string): Promise<void> {
    const session = await this.getSession(id);
    const current = this.active.get(id);
    if (current === undefined) {
      if (session.status === "idle" && session.recovery !== "blocked" && !this.fenced.has(id)) return;
      // Nothing is in flight, so this reports the state of this session only. The gateway is unaffected.
      throw new PnpError("SESSION_UNAVAILABLE", "Session execution stop is unverified.", 409);
    }
    this.requestStop(id, "user");
    await bounded(current.done.promise, this.options.openTimeoutMs + this.options.cancelGraceMs * 4 + 15_000);
    if (this.fenced.has(id)) throw new PnpError("EXECUTION_UNCERTAIN", "Execution stop is unverified.", 503);
  }
  async deleteSession(id: string): Promise<void> {
    if (this.deleting.has(id)) throw new PnpError("SESSION_BUSY", "Session deletion is already active.", 409);
    this.deleting.add(id);
    try {
      const session = await this.getSession(id);
      if (session.engineId !== this.engineId || session.channelId !== this.channelId) throw new PnpError("ENGINE_SESSION_MISMATCH", "Use the session's engine channel to delete it.", 409);
      const current = this.active.get(id);
      if (current !== undefined) {
        this.requestStop(id, "user");
        await bounded(current.done.promise, this.options.openTimeoutMs + this.options.cancelGraceMs * 4 + 15_000);
      }
      // Deletion is the legitimate way out of a fence, but only with evidence: prove the owned
      // resources stopped, then clear the block before the gateway-side record goes away.
      if (!(await this.disposeSessionResources(id, "close"))) throw new PnpError("EXECUTION_UNCERTAIN", "Cannot delete active resources.", 503);
      this.fenced.delete(id);
      await this.store.call("confirmStopped", { sessionId: id });
      await this.store.call("beginDelete", { sessionId: id });
      const directory = this.nativeDirectory(id);
      if (this.engine.purge !== undefined) await bounded(this.engine.purge({ session, nativeDataDirectory: directory }), this.options.openTimeoutMs);
      try {
        if ((await lstat(directory)).isSymbolicLink()) throw new PnpError("UNSAFE_NATIVE_PATH", "Native data directory is a link.", 403);
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await this.store.call("deleteSession", { sessionId: id });
    } finally { this.deleting.delete(id); }
  }
  async close(): Promise<void> {
    this.draining = true;
    for (const id of this.active.keys()) this.requestStop(id, "shutdown");
    await Promise.all([...this.active.values()].map((ctx) => bounded(ctx.done.promise,
      this.options.openTimeoutMs + this.options.cancelGraceMs * 4 + 15_000)));
    let clean = true;
    const sessions = new Set([...this.channels.keys(), ...this.scopes.keys()]);
    for (const id of sessions) clean = await this.disposeSessionResources(id, "close") && clean;
    if (!this.healthy || !clean || this.fenced.size > 0) throw new PnpError("EXECUTION_UNCERTAIN", "Resource cleanup requires verification.", 503);
  }
}
