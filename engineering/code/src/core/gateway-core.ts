import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, rm } from "node:fs/promises";
import path from "node:path";
import type {
  DriverEvent, EnginePack, EngineResult, EngineSessionChannel, IntegrationProvider, IntegrationContext,
  Json, Message, MessageFinish, PromptRequest, Run, Session, StopReason, TerminalState,
} from "../contracts/index.ts";
import type { ProcessHost } from "../contracts/host.ts";
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
  private reserved = false;
  private draining = false;
  private healthy = true;

  private observeFailure(error: unknown): PnpError {
    const failure = asPnpError(error);
    if (failure.code.startsWith("STORAGE_")) this.healthy = false;
    return failure;
  }

  private async disposeSessionResources(id: string, operation: "terminate" | "close"): Promise<boolean> {
    let quiescent = true;
    const channel = this.channels.get(id);
    if (channel !== undefined) {
      try { quiescent = (await bounded(channel[operation](), this.options.cancelGraceMs)).quiescent; }
      catch { quiescent = false; }
      finally { this.channels.delete(id); }
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

  constructor(store: StateStore, engine: EnginePack, integration: IntegrationProvider, options: CoreOptions) {
    this.store = store;
    this.engine = engine;
    this.integration = integration;
    this.processHost = options.processHost ?? new LocalProcessHost(options.dataDirectory);
    this.options = {
      dataDirectory: options.dataDirectory,
      runTimeoutMs: options.runTimeoutMs ?? 900_000,
      openTimeoutMs: options.openTimeoutMs ?? 30_000,
      cancelGraceMs: options.cancelGraceMs ?? 5_000,
      interactionTimeoutMs: options.interactionTimeoutMs ?? 120_000,
      maxResidentSessions: options.maxResidentSessions ?? 8,
    };
    this.journal = new EventJournal(store);
    this.interactions = new InteractionBroker(store, this.journal, this.options.interactionTimeoutMs);
  }
  async initialize(): Promise<void> {
    const interrupted = await this.store.call("recover", null);
    const state = await this.store.call("diagnostics", null);
    if (interrupted > 0 || state.blocked > 0) this.healthy = false;
  }
  get readiness(): boolean { return this.healthy && !this.draining; }
  get engineId(): string { return this.engine.descriptor.id; }
  get channelId(): string { return this.engine.descriptor.channelId; }
  async diagnostics() {
    let persisted: { sessions: number | null; runs: number | null; interrupted: number | null; blocked: number | null };
    try { persisted = await this.store.call("diagnostics", null); }
    catch (error) {
      this.observeFailure(error);
      persisted = { sessions: null, runs: null, interrupted: null, blocked: null };
    }
    return { ...persisted, ready: this.readiness, storage: this.store.diagnosticsSnapshot(),
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
        throw new PnpError("RUN_ALREADY_EXISTS", "The recorded run must not be replayed.", 409);
      }
    }
    if (!this.readiness) throw new PnpError("SERVICE_UNAVAILABLE", "Gateway is not ready.", 503);
    if (this.reserved) throw new PnpError("GATEWAY_BUSY", "Execution slot is occupied.", 409);
    if (this.deleting.has(sessionId)) throw new PnpError("SESSION_UNAVAILABLE", "Session is being deleted.", 409);
    this.reserved = true;
    const ctx: ActiveRun = { controller: new AbortController(), stop: deferred<StopReason>(), done: deferred<void>(), runId: `run_${randomUUID()}` };
    this.active.set(sessionId, ctx);
    const timer = setTimeout(() => this.requestStop(sessionId, "deadline"), this.options.runTimeoutMs);
    let started = false;
    let quiescent = true;
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
    let failure: PnpError | undefined;
    let acceptingEvents = true;
    let eventTail = Promise.resolve();
    const tools = new Map<string, {
      family: "legacy" | "observed";
      name?: string;
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
          catch { this.healthy = false; }
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
        if (this.channels.size >= this.options.maxResidentSessions) throw new PnpError("HOST_CAPACITY", "Resident session capacity reached.", 503);
        const directory = this.nativeDirectory(sessionId);
        await mkdir(directory, { recursive: true });
        scope = new OwnedResourceScope();
        this.scopes.set(sessionId, scope);
        quiescent = false;
        openSettled = false;
        opening = this.engine.open({ host: this.processHost, session, nativeDataDirectory: directory, integration, resources: scope, signal: ctx.controller.signal });
        // Every resolution is observed, including a channel returned after cancellation.
        void opening.then(async (late) => {
          openSettled = true;
          if (discardOpening) {
            try { await bounded(late.terminate(), this.options.cancelGraceMs); }
            catch { /* The session remains fenced until explicit resource reconciliation. */ }
          }
        }, () => { openSettled = true; });
        channel = await bounded(Promise.race([
          opening,
          ctx.stop.promise.then(() => { throw new PnpError("EXECUTION_CANCELLED", "Cancelled during engine startup.", 409); }),
        ]), this.options.openTimeoutMs);
        this.channels.set(sessionId, channel);
        if (channel.native.channelId !== this.channelId) throw new PnpError("CHANNEL_MISMATCH", "Engine returned a different channel.", 502);
        await this.store.call("bindNative", { id: sessionId, native: channel.native });
        quiescent = true;
      }
      const resolved = integration;
      const services = {
        events: { emit: (event: DriverEvent): Promise<void> => {
          eventTail = eventTail.then(async () => {
            if (!acceptingEvents) return;
            if (Buffer.byteLength(JSON.stringify(event)) > 1024 * 1024) throw new PnpError("EVENT_TOO_LARGE", "Use an artifact reference.", 502);
            const properties: { [key: string]: Json } = { sessionID: sessionId, runID: run.id, messageID: finalId };
            if (event.type === "text.delta") {
              rawText += event.text;
              if (Buffer.byteLength(rawText) > 8 * 1024 * 1024) throw new PnpError("OUTPUT_TOO_LARGE", "Output exceeds the configured limit.", 502);
              text = redactor.streamText(rawText);
              const now = Date.now();
              if (now - lastTextCheckpoint < 100 && Buffer.byteLength(text) - checkpointBytes < 4096) return;
              lastTextCheckpoint = now;
              checkpointBytes = Buffer.byteLength(text);
              await this.store.call("appendMessage", { sessionId, runId: run.id,
                message: { ...makeMessage("assistant", text), id: finalId, parts: [{ type: "text", content: text }] } });
              properties.part = { type: "text", content: text };
            } else if (event.type === "tool.started") {
              const existing = tools.get(event.callId);
              if (existing?.family === "observed") throw new PnpError("ENGINE_PROTOCOL_ERROR", "Tool event families cannot be mixed.", 502);
              if (existing !== undefined) throw new PnpError("DUPLICATE_TOOL", "Duplicate tool identity.", 502);
              const item = makeMessage("assistant", "");
              item.tool_calls = [{ id: event.callId, name: event.name, arguments: redactor.json(event.input) }];
              item.info = { role: "assistant", finish: "tool-calls" };
              item.parts = [{ type: "tool", tool: event.name, callID: event.callId, state: { status: "running", title: event.name } }];
              tools.set(event.callId, { family: "legacy", name: event.name, input: redactor.json(event.input), inputObserved: true,
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
              properties.part = { type: "tool", tool: tool.name, callID: event.callId, state: { status: "running", title: redactor.text(event.title) } };
            } else if (event.type === "tool.finished") {
              const tool = tools.get(event.callId);
              if (tool?.family === "observed") throw new PnpError("ENGINE_PROTOCOL_ERROR", "Tool event families cannot be mixed.", 502);
              if (tool === undefined || tool.terminal || !tool.canonical || tool.name === undefined) throw new PnpError("UNMATCHED_TOOL_RESULT", "Tool result has no active call.", 502);
              tool.terminal = true;
              tool.status = event.failed ? "failed" : "completed";
              tool.outputPersisted = true;
              const item = makeMessage("tool", JSON.stringify(redactor.json(event.output)));
              item.tool_call_id = event.callId;
              item.tool_name = tool.name;
              tool.message.parts = [{ type: "tool", tool: tool.name, callID: event.callId,
                state: { status: event.failed ? "error" : "completed", title: tool.name, source: "engine" } }];
              await this.store.call("appendMessage", { sessionId, runId: run.id, message: tool.message });
              await this.store.call("appendMessage", { sessionId, runId: run.id, message: item });
              properties.messageID = tool.message.id;
              properties.part = tool.message.parts[0]!;
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
              const observation: { [key: string]: Json } = {
                type: "tool", callID: event.callId, source: event.source, phase: event.phase,
                state: {
                  status,
                  ...(observedTerminal && !tool.terminalOutputObserved ? { terminalStatus: "result_unknown" } : {}),
                  ...(event.nativeStatus === undefined ? {} : { nativeStatus: redactor.text(event.nativeStatus) }),
                  ...(event.nativeType === undefined ? {} : { nativeType: redactor.text(event.nativeType) }),
                },
              };
              if (hasName) observation.tool = redactor.text(event.name!);
              if (event.title !== undefined) observation.title = redactor.text(event.title);
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
          // A detached adapter emit must not produce an unhandled rejection.
          void eventTail.catch(() => undefined);
          return eventTail;
        } },
        interact: async (request: Parameters<IntegrationContext["authorize"]>[0]) => {
          const policy = await bounded(resolved.authorize(request), this.options.openTimeoutMs);
          return this.interactions.request({ sessionId, runId: run.id, request, policy, signal: ctx.controller.signal, redactor });
        },
      };
      quiescent = false;
      const execution = channel.run({ runId: run.id, request, integration, services, signal: ctx.controller.signal });
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
          quiescent = await this.disposeSessionResources(sessionId, "terminate");
        }
        nativeStopReason = result?.nativeStopReason;
        state = first.reason === "deadline" ? "failed" : "cancelled";
        finish = state === "cancelled" ? "cancelled" : "error";
        failure = this.stopError(first.reason);
      } else {
        quiescent = first.result.quiescent === true;
        state = first.result.state;
        finish = first.result.finish;
        nativeStopReason = first.result.nativeStopReason;
        taskOutcome = first.result.taskOutcome;
        text = redactor.text(first.result.finalText);
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
      if (state === "completed" && [...tools.values()].some((t) => !t.terminal)) {
        throw new PnpError("ENGINE_PROTOCOL_ERROR", "Engine ended with unresolved tool states.", 502);
      }
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
        quiescent = await this.disposeSessionResources(sessionId, "terminate");
      } else if (opening !== undefined) {
        const evidence = await scope!.stop(this.options.cancelGraceMs);
        // Unsettled startup can still return a resource; retain the execution fence.
        quiescent = openSettled && evidence.quiescent;
        if (quiescent) this.scopes.delete(sessionId);
      }
      acceptingEvents = false;
      await eventTail.catch(() => undefined);
    } finally {
      clearTimeout(timer);
      acceptingEvents = false;
      if (!quiescent) { state = "interrupted"; finish = "interrupted"; this.healthy = false; }
      try {
        if (started) {
          ctx.controller.abort(ctx.reason ?? "settled");
          await this.interactions.endRun(ctx.runId);
          // Record an observation, not a fabricated tool response or success.
          for (const [callId, tool] of tools) {
            if (tool.terminal) continue;
            tool.message.parts = [...(tool.message.parts ?? []), { type: "tool", ...(tool.name === undefined ? {} : { tool: tool.name }), callID: callId,
              state: { status: "error", terminalStatus: state === "cancelled" ? "cancelled" : "result_unknown",
                source: "gateway-observation", quiescent, title: "No complete engine tool result was received." } }];
            tool.terminal = true;
            await this.store.call("appendMessage", { sessionId, runId: ctx.runId, message: tool.message });
            await this.journal.publish("message.part.updated", { sessionID: sessionId, runID: ctx.runId,
              messageID: tool.message.id, part: tool.message.parts.at(-1)! });
          }
          const message = { ...makeMessage("assistant", text || failure?.message || ""), id: finalId };
          message.info = { role: "assistant", finish, ...(nativeStopReason === undefined ? {} : { nativeFinish: nativeStopReason }) };
          message.parts = [{ type: "text", content: message.content }];
          if (state === "completed" && finish === "stop") message.parts.push({ type: "step-finish" });
          await this.store.call("finishRun", { runId: ctx.runId, state, message, quiescent, taskOutcome,
            ...(nativeStopReason === undefined ? {} : { nativeStopReason }),
            ...(failure === undefined ? {} : { errorCode: failure.code }) });
          if (failure !== undefined) await this.journal.publish("session.error", { sessionID: sessionId, runID: ctx.runId,
            error: { message: failure.message, code: failure.code } });
          if (quiescent) {
            await this.journal.publish("session.status", { sessionID: sessionId, runID: ctx.runId, status: { type: "idle" } });
            await this.journal.publish("session.idle", { sessionID: sessionId, runID: ctx.runId });
          }
        }
      } catch (error) { this.healthy = false; failure = this.observeFailure(error); }
      try {
        if (integration !== undefined && this.integration.release !== undefined) {
          await bounded(this.integration.release(integration), this.options.cancelGraceMs);
        }
      } catch (error) {
        this.healthy = false;
        if (failure === undefined) failure = this.observeFailure(error);
      }
      this.active.delete(sessionId);
      this.reserved = !quiescent;
      ctx.done.resolve();
    }
    if (failure !== undefined) throw failure;
    if (!quiescent) throw new PnpError("EXECUTION_UNCERTAIN", "Execution stop is unverified.", 503);
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
      if (session.status === "idle" && session.recovery !== "blocked") return;
      this.healthy = false;
      throw new PnpError("EXECUTION_UNCERTAIN", "Execution stop is unverified.", 503);
    }
    this.requestStop(id, "user");
    await bounded(current.done.promise, this.options.openTimeoutMs + this.options.cancelGraceMs * 4 + 15_000);
    if (!this.healthy) throw new PnpError("EXECUTION_UNCERTAIN", "Execution stop is unverified.", 503);
  }
  async deleteSession(id: string): Promise<void> {
    if (this.deleting.has(id)) throw new PnpError("SESSION_BUSY", "Session deletion is already active.", 409);
    this.deleting.add(id);
    try {
      const session = await this.getSession(id);
      if (session.engineId !== this.engineId || session.channelId !== this.channelId) throw new PnpError("ENGINE_SESSION_MISMATCH", "Use the session's engine channel to delete it.", 409);
      await this.abort(id);
      if (!(await this.disposeSessionResources(id, "close"))) throw new PnpError("EXECUTION_UNCERTAIN", "Cannot delete active resources.", 503);
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
    if (!this.healthy || !clean) throw new PnpError("EXECUTION_UNCERTAIN", "Resource cleanup requires verification.", 503);
  }
}
