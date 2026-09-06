import { randomUUID } from "node:crypto";
import { AGENT_METHODS, CLIENT_METHODS, PROTOCOL_VERSION, RequestError, client } from "@agentclientprotocol/sdk";
import type {
  ClientConnection, InitializeResponse, McpServer, PromptResponse, RequestPermissionRequest,
  RequestPermissionResponse, SessionConfigOption, SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  AssetBinding, DriverEvent, EngineCapabilities, EngineOpenInput, EngineResult, EngineSessionChannel,
  IntegrationContext, InteractionResponse, Json, ModelSelection, NativeSessionRef, Session, StopEvidence,
  StopReason, ToolBinding,
} from "../../contracts/index.ts";
import type { HostedProcess, LaunchSpec } from "../../contracts/host.ts";
import { PnpError } from "../../core/errors.ts";
import { bounded, deferred } from "../../runtime/deadline.ts";
import { AcpCapabilityLedger } from "./capabilities.ts";
import { jsonObject, toJson } from "./json.ts";
import { createHostedStream, type HostedStream } from "./transport.ts";
import { ACP_NAMESPACE, SessionUpdateMapper, finishFor } from "./updates.ts";

/** Process shape supplied by the Engine Pack. The driver fills ownership fields and never spawns directly. */
export interface AcpLaunchRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}
/**
 * How the requested model reaches the engine. ACP prompts carry no model field, so either the session exposes a
 * model configuration option, or the Pack pinned the model when it built the launch request.
 */
export type AcpModelPolicy =
  | { kind: "session-config" }
  | { kind: "launch"; modelID: string };
export interface AcpTimeouts {
  /** Bound for initialize, session and configuration requests. */
  requestMs?: number;
  /** Time the driver waits for the engine's prompt response after a local cancellation. */
  cancelGraceMs?: number;
  /** Bound for writing the session/cancel notification. The write is an ACK, never stop evidence. */
  cancelAckMs?: number;
}
export interface AcpEngineDefinition {
  engineId: string;
  channelId: string;
  /** Locked engine version from the Pack. The engine's own agentInfo takes precedence when reported. */
  engineVersion: string;
  client?: { name: string; version: string };
  model: AcpModelPolicy;
  launch(input: EngineOpenInput): AcpLaunchRequest | Promise<AcpLaunchRequest>;
  /** Native asset projection. Without it the channel refuses to open when a required asset exists. */
  projectAssets?(input: { assets: readonly AssetBinding[]; session: Session; nativeDataDirectory: string }): Promise<Json>;
  timeouts?: AcpTimeouts;
  maxQueuedMessages?: number;
}

const DEFAULT_TIMEOUTS = { requestMs: 30_000, cancelGraceMs: 2_000, cancelAckMs: 1_000 };
const KNOWN_UPDATE_KINDS = new Set([
  "user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update",
  "plan", "plan_update", "plan_removed", "available_commands_update", "current_mode_update",
  "config_option_update", "session_info_update", "usage_update", "compaction_update", "compaction_summary_chunk",
]);
const CANCELLED_OUTCOME: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

interface Observations {
  outOfTurn: number;
  foreign: number;
  droppedKinds: string[];
}
interface OpenNotice {
  eventName: string;
  payload: Json;
}
type PromptOutcome = { ok: PromptResponse } | { error: unknown };

function describe(error: unknown): string {
  if (error instanceof PnpError) return `${error.code}: ${error.message}`;
  if (error instanceof RequestError) return `jsonrpc ${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "Unknown driver failure.";
}
function nativeStopFor(error: unknown): string {
  return error instanceof RequestError ? `jsonrpc_error_${error.code}` : "engine_error";
}
/** Every settlement is observed so a late rejection cannot surface as an unhandled promise. */
function observe<T>(promise: Promise<T>): Promise<PromptOutcome> {
  return promise.then((ok) => ({ ok } as PromptOutcome), (error: unknown) => ({ error }));
}
async function boundedRequest<T>(request: Promise<T>, milliseconds: number): Promise<T> {
  void request.catch(() => undefined);
  return bounded(request, milliseconds);
}
async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), milliseconds); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
/** Cleanup that cannot prove itself becomes explicit uncertainty; it is never reported as a clean stop. */
async function settleEvidence(attempt: Promise<StopEvidence>): Promise<StopEvidence> {
  try { return await attempt; }
  catch { return { quiescent: false, method: "process-tree" }; }
}
export function mcpServersFor(tools: readonly ToolBinding[]): McpServer[] {
  return tools.filter((tool) => tool.transport === "mcp-stdio").map((tool) => ({
    name: tool.id, command: tool.command, args: [...tool.args],
    env: Object.entries(tool.env).map(([name, value]) => ({ name, value })),
  }));
}
function fingerprint(value: unknown): string {
  return JSON.stringify(toJson(value));
}
function integrationFingerprint(integration: IntegrationContext): string {
  return fingerprint({
    tools: mcpServersFor(integration.tools),
    assets: integration.assets.map((asset) => ({ id: asset.id, kind: asset.kind, sha256: asset.sha256, required: asset.required })),
  });
}
function modelCandidates(selection: ModelSelection): string[] {
  return [selection.modelID, `${selection.providerID}/${selection.modelID}`];
}
function selectValues(option: SessionConfigOption): string[] {
  if (option.type !== "select") return [];
  const entries = option.options;
  return entries.flatMap((entry) => "value" in entry ? [entry.value] : entry.options.map((child) => child.value));
}

class Turn {
  readonly runId: string;
  readonly services: EngineOpenInput["integration"] extends never ? never : DriverServicesLike;
  readonly cancelled = deferred<StopReason>();
  cancelReason: StopReason | undefined;
  cancelSent = false;
  cancelNotifyFailure: string | undefined;
  accepting = true;
  emitFailure: unknown;
  text = "";
  private tail: Promise<void> = Promise.resolve();
  constructor(runId: string, services: DriverServicesLike) {
    this.runId = runId;
    this.services = services;
  }
  /** Ordered, awaited delivery. A sink failure is recorded and rethrown when the turn settles. */
  enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.tail.then(async () => {
      try { await work(); }
      catch (error) { this.emitFailure ??= error; }
    });
    this.tail = next;
    return next;
  }
  emit(...events: DriverEvent[]): Promise<void> {
    return this.enqueue(async () => { for (const event of events) await this.services.events.emit(event); });
  }
  drain(): Promise<void> { return this.tail; }
  markCancelled(reason: StopReason): void {
    if (this.cancelReason !== undefined) return;
    this.cancelReason = reason;
    this.cancelled.resolve(reason);
  }
}
interface DriverServicesLike {
  events: { emit(event: DriverEvent): Promise<void> };
  interact(request: { kind: "permission" | "question"; operation: string; payload: Json }): Promise<InteractionResponse>;
}

interface ChannelParts {
  definition: AcpEngineDefinition;
  hosted: HostedProcess;
  stream: HostedStream;
  connection: ClientConnection;
  ledger: AcpCapabilityLedger;
  native: NativeSessionRef;
  configOptions: SessionConfigOption[];
  integrationFingerprint: string;
  notices: OpenNotice[];
  observations: Observations;
}

/**
 * One ACP session bound to one gateway Session.
 *
 * Cancellation follows the measured gateway behaviour: `cancel` acknowledges immediately, `run` resolves inside
 * the grace window with a cancelled result, and quiescence is reported truthfully. Rejecting or settling late
 * discards the driver's stop reason and destroys the channel, so both are reserved for an unusable channel.
 */
export class AcpSessionChannel implements EngineSessionChannel {
  readonly native: NativeSessionRef;
  private readonly parts: ChannelParts;
  private readonly mapper = new SessionUpdateMapper();
  private readonly timeouts: Required<AcpTimeouts>;
  private configOptions: SessionConfigOption[];
  private appliedModel: string | undefined;
  private turn: Turn | undefined;
  private disposed = false;
  private stopped: StopEvidence | undefined;
  private stopping: Promise<StopEvidence> | undefined;

  constructor(parts: ChannelParts) {
    this.parts = parts;
    this.native = parts.native;
    this.configOptions = parts.configOptions;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...parts.definition.timeouts };
    if (parts.definition.model.kind === "launch") this.appliedModel = parts.definition.model.modelID;
  }
  get capabilities(): EngineCapabilities { return this.parts.ledger.snapshot(); }

  async run(input: Parameters<EngineSessionChannel["run"]>[0]): Promise<EngineResult> {
    if (this.disposed) throw new PnpError("ENGINE_CHANNEL_CLOSED", "The ACP channel is closed.", 503);
    if (this.turn !== undefined) throw new PnpError("ENGINE_TURN_ACTIVE", "A session runs one turn at a time.", 409);
    const turn = new Turn(input.runId, input.services);
    this.turn = turn;
    const onAbort = (): void => { void this.signalCancel(turn, stopReasonOf(input.signal.reason)); };
    input.signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (input.signal.aborted) turn.markCancelled(stopReasonOf(input.signal.reason));
      return await this.execute(turn, input);
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      turn.accepting = false;
      this.turn = undefined;
    }
  }

  /** Request ACK only. Stop evidence comes from the prompt response observed by `run`. */
  async cancel(reason: StopReason): Promise<void> {
    const turn = this.turn;
    if (turn === undefined) return;
    await this.signalCancel(turn, reason);
  }
  terminate(): Promise<StopEvidence> { return this.stop(false); }
  close(): Promise<StopEvidence> { return this.stop(true); }

  /** Called by the connection dispatcher for `session/update`. */
  async handleUpdate(notification: SessionNotification): Promise<void> {
    if (notification.sessionId !== this.native.nativeId) {
      this.parts.observations.foreign += 1;
      return;
    }
    if (notification.update.sessionUpdate === "config_option_update") {
      this.setConfigOptions(notification.update.configOptions);
    }
    const turn = this.turn;
    if (turn === undefined || !turn.accepting) {
      this.parts.observations.outOfTurn += 1;
      return;
    }
    const mapped = this.mapper.map(notification.update);
    turn.text += mapped.text;
    if (mapped.events.length > 0) await turn.emit(...mapped.events);
  }

  /** Called by the connection dispatcher for `session/request_permission`. */
  async handlePermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const turn = this.turn;
    if (turn === undefined || !turn.accepting) return CANCELLED_OUTCOME;
    // ACP requires a cancelled outcome once the client has cancelled the turn.
    if (turn.cancelReason !== undefined) return CANCELLED_OUTCOME;
    const call = params.toolCall;
    let response: InteractionResponse;
    try {
      response = await turn.services.interact({
        kind: "permission",
        operation: call.name ?? call.title ?? call.toolCallId,
        payload: toJson({
          toolCallId: call.toolCallId, title: call.title ?? null, name: call.name ?? null, kind: call.kind ?? null,
          locations: call.locations ?? null, rawInput: call.rawInput ?? null,
          // OpenCode puts the proposed diff here (type "diff" with oldText/newText), not in rawInput;
          // an approver deciding on an edit needs it.
          content: call.content ?? null,
          options: params.options.map((option) => ({ optionId: option.optionId, name: option.name, kind: option.kind })),
        }),
      });
    } catch (error) {
      await turn.emit(this.native_("permission.unavailable", { toolCallId: call.toolCallId, detail: describe(error) }));
      return CANCELLED_OUTCOME;
    }
    // "allow" only ever selects the once-scoped option: widening an approval is a policy decision, not a driver one.
    const option = response.decision === "allow"
      ? params.options.find((candidate) => candidate.kind === "allow_once")
      : params.options.find((candidate) => candidate.kind === "reject_once")
        ?? params.options.find((candidate) => candidate.kind === "reject_always");
    await turn.emit(this.native_("permission.resolved", {
      toolCallId: call.toolCallId, decision: response.decision,
      source: response.source ?? null, reasonCode: response.reasonCode ?? null,
      optionId: option?.optionId ?? null, optionKind: option?.kind ?? null,
      selectable: params.options.map((candidate) => candidate.kind),
    }));
    if (option === undefined) return CANCELLED_OUTCOME;
    this.parts.ledger.observe("acp.session.permission", "verified");
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  }

  setConfigOptions(options: readonly SessionConfigOption[]): void {
    this.configOptions = [...options];
    this.parts.ledger.configOptions(this.configOptions);
    const model = this.modelOption();
    if (model !== undefined && this.appliedModel !== undefined && model.currentValue !== this.appliedModel) {
      // The engine moved the selector on its own; the next turn must set it again instead of assuming.
      this.appliedModel = undefined;
    }
  }

  private native_(eventName: string, payload: unknown): DriverEvent {
    return { type: "native", namespace: ACP_NAMESPACE, eventName, payload: toJson(payload) };
  }

  private async execute(turn: Turn, input: Parameters<EngineSessionChannel["run"]>[0]): Promise<EngineResult> {
    await this.emitNotices(turn);
    if (turn.cancelReason !== undefined) return this.finish(turn, true, "cancelled_before_prompt", true);
    this.assertIntegrationUnchanged(input.integration);
    await this.applyModel(turn, input.request.model);
    if (turn.cancelReason !== undefined) return this.finish(turn, true, "cancelled_before_prompt", true);
    const prompt = observe(this.parts.connection.agent.request(AGENT_METHODS.session_prompt, {
      sessionId: this.native.nativeId,
      prompt: input.request.parts.map((part) => ({ type: "text" as const, text: part.text })),
    }));
    const raced = await Promise.race([prompt, turn.cancelled.promise.then(() => undefined)]);
    const outcome = raced ?? await withTimeout(prompt, this.timeouts.cancelGraceMs);
    const cancelledLocally = turn.cancelReason !== undefined;
    if (outcome !== undefined && "ok" in outcome) {
      const usage = this.mapper.usageFromResponse(outcome.ok.usage);
      if (usage !== undefined && turn.accepting) await turn.emit(usage);
    }
    await turn.drain();
    turn.accepting = false;
    // Counted before closing: a call the engine never gave arguments to is closed with a start of its own,
    // so the event count is not the number of unresolved calls the operator needs to see.
    const unresolved = this.mapper.openCallIds().length;
    const leftovers = this.mapper.closeOpenCalls("ACP_TOOL_RESULT_MISSING",
      "The engine ended the turn without a terminal tool state.");
    if (leftovers.length > 0) await turn.emit(...leftovers);
    await this.emitTurnDiagnostics(turn, outcome, unresolved);
    await turn.drain();
    if (turn.emitFailure !== undefined) throw turn.emitFailure;
    if (outcome === undefined) {
      // Cancel grace expired. The turn is terminal for the gateway, but this turn's engine-side resources are
      // unproven, so quiescence is reported false and Core takes process-level evidence.
      return this.finish(turn, false, "cancelled_no_engine_response", true);
    }
    if ("error" in outcome) return this.finishError(turn, outcome.error, cancelledLocally);
    const stopReason = outcome.ok.stopReason;
    this.parts.ledger.observe("acp.session.update", this.mapper.sawStreamedContent ? "verified" : "probed");
    if (stopReason === "cancelled") this.parts.ledger.observe("acp.session.cancel", "verified");
    if (cancelledLocally) {
      // A local stop outranks the engine's self-report: interrupted turns report drifting completion fields.
      return this.finish(turn, true, stopReason, true);
    }
    return {
      state: stopReason === "cancelled" ? "cancelled" : "completed",
      finish: finishFor(stopReason),
      quiescent: true,
      finalText: turn.text,
      nativeStopReason: stopReason,
      taskOutcome: "unknown",
    };
  }

  private finishError(turn: Turn, error: unknown, cancelledLocally: boolean): EngineResult {
    const transport = this.parts.stream.failure;
    const usable = transport === undefined && !this.parts.connection.signal.aborted;
    if (!usable) {
      // The channel itself is gone. Rejecting is correct here: Core destroys the channel and takes evidence.
      if (!cancelledLocally) throw transport ?? new PnpError("ENGINE_PROTOCOL_ERROR", describe(error), 502);
      return this.finish(turn, false, "cancelled_connection_lost", true);
    }
    if (cancelledLocally) return this.finish(turn, true, nativeStopFor(error), true);
    return {
      state: "failed", finish: "error", quiescent: true, finalText: turn.text,
      nativeStopReason: nativeStopFor(error), taskOutcome: "unknown",
    };
  }

  private finish(turn: Turn, quiescent: boolean, nativeStopReason: string, cancelled: boolean): EngineResult {
    return {
      state: cancelled ? "cancelled" : "failed",
      finish: cancelled ? "cancelled" : "error",
      quiescent,
      finalText: turn.text,
      nativeStopReason,
      taskOutcome: "unknown",
    };
  }

  private async emitNotices(turn: Turn): Promise<void> {
    const notices = this.parts.notices.splice(0);
    for (const notice of notices) await turn.emit(this.native_(notice.eventName, notice.payload));
    const observations = this.parts.observations;
    if (observations.outOfTurn > 0 || observations.foreign > 0 || observations.droppedKinds.length > 0) {
      await turn.emit(this.native_("updates.unattributed", {
        outOfTurn: observations.outOfTurn, foreignSession: observations.foreign,
        schemaRejectedKinds: [...new Set(observations.droppedKinds)],
      }));
      observations.outOfTurn = 0;
      observations.foreign = 0;
      observations.droppedKinds.length = 0;
    }
  }

  private async emitTurnDiagnostics(turn: Turn, outcome: PromptOutcome | undefined, leftovers: number): Promise<void> {
    // The notify promise resolves when the SDK queues the frame, not when it reaches the engine, so
    // the channel is re-read here, at settle time, when the write has certainly been attempted.
    // Reporting an acknowledgement that never happened inverts the rule that a cancel ACK is not
    // stop evidence, which is the one thing an operator reads this diagnostic to find out.
    const lost = turn.cancelNotifyFailure ?? (this.parts.stream.failure === undefined
      ? undefined : describe(this.parts.stream.failure));
    if (turn.cancelSent && lost !== undefined) turn.cancelNotifyFailure = lost;
    if (turn.cancelReason === undefined && leftovers === 0 && lost === undefined) return;
    await turn.emit(this.native_("turn.settled", {
      cancelReason: turn.cancelReason ?? null,
      cancelAcknowledged: turn.cancelSent && lost === undefined,
      cancelNotifyFailure: turn.cancelNotifyFailure ?? null,
      enginePromptSettled: outcome !== undefined,
      unresolvedToolCalls: leftovers,
    }));
  }

  private assertIntegrationUnchanged(integration: IntegrationContext): void {
    const current = integrationFingerprint(integration);
    if (current === this.parts.integrationFingerprint) return;
    // ACP binds MCP servers and assets to the session; refuse before the prompt instead of silently
    // dropping the new binding or replacing the session and losing history.
    throw new PnpError("ENGINE_BINDINGS_CHANGED",
      "The ACP session cannot rebind tools or assets after creation.", 409);
  }

  private modelOption(): (SessionConfigOption & { type: "select" }) | undefined {
    for (const option of this.configOptions) {
      if (option.type === "select" && option.category === "model") return option;
    }
    return undefined;
  }

  private async applyModel(turn: Turn, selection: ModelSelection): Promise<void> {
    const candidates = modelCandidates(selection);
    if (this.parts.definition.model.kind === "launch") {
      const pinned = this.parts.definition.model.modelID;
      if (!candidates.includes(pinned)) {
        throw new PnpError("ENGINE_MODEL_SWITCH_UNSUPPORTED",
          "This engine binds the model at process start; the requested model needs a new session.", 409);
      }
      return;
    }
    if (this.appliedModel !== undefined && candidates.includes(this.appliedModel)) return;
    const option = this.modelOption();
    if (option === undefined) {
      throw new PnpError("ENGINE_MODEL_SWITCH_UNSUPPORTED",
        "The ACP session exposes no model configuration option; the requested model cannot be honoured.", 502);
    }
    const values = selectValues(option);
    const wanted = candidates.find((candidate) => values.includes(candidate));
    if (wanted === undefined) {
      throw new PnpError("ENGINE_MODEL_UNAVAILABLE", "The engine does not offer the requested model.", 409);
    }
    if (option.currentValue === wanted) {
      this.appliedModel = wanted;
      return;
    }
    let response;
    try {
      response = await boundedRequest(this.parts.connection.agent.request(AGENT_METHODS.session_set_config_option, {
        sessionId: this.native.nativeId, configId: option.id, value: wanted,
      }), this.timeouts.requestMs);
    } catch (error) {
      throw new PnpError("ENGINE_MODEL_REJECTED", `The engine refused the requested model. ${describe(error)}`, 502);
    }
    this.setConfigOptions(response.configOptions);
    if (this.modelOption()?.currentValue !== wanted) {
      throw new PnpError("ENGINE_MODEL_REJECTED", "The engine did not apply the requested model.", 502);
    }
    this.appliedModel = wanted;
    this.parts.ledger.observe("acp.session.config_option", "verified", true);
    await turn.emit(this.native_("model.applied", { configId: option.id, value: wanted }));
  }

  private async signalCancel(turn: Turn, reason: StopReason): Promise<void> {
    turn.markCancelled(reason);
    if (turn.cancelSent) return;
    turn.cancelSent = true;
    if (this.parts.stream.failure !== undefined || this.parts.connection.signal.aborted) {
      turn.cancelNotifyFailure = "channel is not available";
      return;
    }
    try {
      await boundedRequest(this.parts.connection.agent.notify(AGENT_METHODS.session_cancel, {
        sessionId: this.native.nativeId,
      }), this.timeouts.cancelAckMs);
      // Resolving means the SDK queued the notification, not that the frame reached the engine. A
      // write that failed inside the writer loop surfaces on the stream, so re-read it: reporting an
      // acknowledgement that never happened is the "cancel ACK is not stop evidence" rule inverted.
      const late = this.parts.stream.failure;
      if (late !== undefined) turn.cancelNotifyFailure = describe(late);
    } catch (error) {
      // The write is only an ACK. The failure is recorded and reported; quiescence still comes from the turn.
      turn.cancelNotifyFailure = describe(error);
    }
  }

  private stop(graceful: boolean): Promise<StopEvidence> {
    this.disposed = true;
    const settled = this.stopped;
    if (settled !== undefined) return Promise.resolve({ ...settled });
    const running = this.stopping;
    if (running !== undefined) return running;
    const attempt = this.runStop(graceful);
    this.stopping = attempt;
    void attempt.then((evidence) => {
      if (evidence.quiescent) this.stopped = evidence;
      if (this.stopping === attempt) this.stopping = undefined;
    }, () => {
      if (this.stopping === attempt) this.stopping = undefined;
    });
    return attempt;
  }

  private async runStop(graceful: boolean): Promise<StopEvidence> {
    const closeCapability = this.parts.ledger.get("acp.session.close");
    if (graceful && closeCapability?.available === true
      && this.parts.stream.failure === undefined && !this.parts.connection.signal.aborted) {
      try {
        await boundedRequest(this.parts.connection.agent.request(AGENT_METHODS.session_close, {
          sessionId: this.native.nativeId,
        }), this.timeouts.requestMs);
        this.parts.ledger.observe("acp.session.close", "verified");
      } catch {
        // A refused protocol close does not prove anything; process termination below supplies the evidence.
        this.parts.ledger.observe("acp.session.close", "probed", false);
      }
    }
    this.parts.stream.fail(new PnpError("ENGINE_CHANNEL_CLOSED", "The ACP channel was closed by the gateway.", 503));
    this.parts.connection.close();
    return settleEvidence(this.parts.hosted.terminate());
  }
}

function stopReasonOf(reason: unknown): StopReason {
  return reason === "deadline" || reason === "shutdown" ? reason : "user";
}

/**
 * Opens one ACP session on a process started through the shared ProcessHost.
 *
 * The adapter never constructs a host and never spawns. Ownership fields are filled here because the recovery
 * path matches launch records against gateway Sessions.
 */
export async function openAcpChannel(definition: AcpEngineDefinition, input: EngineOpenInput): Promise<EngineSessionChannel> {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...definition.timeouts };
  const notices: OpenNotice[] = [];
  const assets = input.integration.assets;
  if (definition.projectAssets === undefined) {
    const required = assets.filter((asset) => asset.required);
    if (required.length > 0) {
      throw new PnpError("ENGINE_ASSET_PROJECTION_UNSUPPORTED",
        "Required assets have no native projection on this ACP channel.", 502);
    }
    if (assets.length > 0) {
      notices.push({ eventName: "assets.skipped", payload: toJson(assets.map((asset) => asset.id)) });
    }
  } else {
    const projection = await definition.projectAssets({
      assets, session: input.session, nativeDataDirectory: input.nativeDataDirectory,
    });
    notices.push({ eventName: "assets.projected", payload: projection });
  }
  const unsupportedTools = input.integration.tools.filter((tool) => tool.transport !== "mcp-stdio");
  if (unsupportedTools.length > 0) {
    notices.push({ eventName: "tools.unsupported-transport", payload: toJson(unsupportedTools.map((tool) => ({ id: tool.id, transport: tool.transport }))) });
  }
  const request = await definition.launch(input);
  const spec: LaunchSpec = {
    executable: request.executable, args: [...request.args], cwd: request.cwd, env: { ...request.env },
    // The gateway Session identifier, never the native ACP session: ownership recovery reconciles on it.
    sessionId: input.session.id,
    // Non-empty by construction: an empty owner token invalidates the record on the next start.
    ownerToken: randomUUID(),
  };
  const hosted = await input.host.start(spec, input.signal, input.resources);
  const observations: Observations = { outOfTurn: 0, foreign: 0, droppedKinds: [] };
  const dispatch: { channel: AcpSessionChannel | undefined } = { channel: undefined };
  const stream = createHostedStream(hosted, {
    ...(definition.maxQueuedMessages === undefined ? {} : { maxQueuedMessages: definition.maxQueuedMessages }),
    observe: (message) => {
      // The SDK validates session updates against the locked schema and drops unknown kinds before any handler
      // runs. Counting them here keeps that loss visible instead of silent.
      if (!("method" in message) || message.method !== CLIENT_METHODS.session_update) return;
      const params = jsonObject((message as { params?: unknown }).params);
      const update = params["update"];
      const kind = update !== null && typeof update === "object" && !Array.isArray(update) ? update["sessionUpdate"] : undefined;
      if (typeof kind === "string" && !KNOWN_UPDATE_KINDS.has(kind)) observations.droppedKinds.push(kind);
    },
  });
  const app = client({ name: definition.client?.name ?? "pnp-gateway" })
    .onRequest(CLIENT_METHODS.session_request_permission, async (context) =>
      dispatch.channel === undefined ? CANCELLED_OUTCOME : dispatch.channel.handlePermission(context.params))
    .onNotification(CLIENT_METHODS.session_update, async (context) => {
      if (dispatch.channel === undefined) {
        observations.outOfTurn += 1;
        return;
      }
      await dispatch.channel.handleUpdate(context.params);
    });
  const connection = app.connect(stream.stream);
  try {
    const initialize = await boundedRequest(connection.agent.request(AGENT_METHODS.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: definition.client?.name ?? "pnp-gateway", version: definition.client?.version ?? "0.1.0" },
    }), timeouts.requestMs);
    if (!Number.isInteger(initialize.protocolVersion) || initialize.protocolVersion < 1 || initialize.protocolVersion > PROTOCOL_VERSION) {
      throw new PnpError("ENGINE_PROTOCOL_VERSION",
        `The engine negotiated ACP protocol version ${String(initialize.protocolVersion)}, which this driver does not implement.`, 502);
    }
    const ledger = new AcpCapabilityLedger(initialize);
    const mcpServers = mcpServersFor(input.integration.tools);
    const session = await establishSession(connection, ledger, input, initialize, mcpServers, timeouts.requestMs, notices);
    const channel = new AcpSessionChannel({
      definition, hosted, stream, connection, ledger, native: {
        nativeId: session.sessionId,
        channelId: definition.channelId,
        engineVersion: initialize.agentInfo?.version ?? definition.engineVersion,
        protocolVersion: String(initialize.protocolVersion),
        ...(ledger.get("acp.session.load")?.available === true ? { resumeToken: session.sessionId } : {}),
      },
      configOptions: session.configOptions,
      integrationFingerprint: integrationFingerprint(input.integration),
      notices, observations,
    });
    channel.setConfigOptions(session.configOptions);
    dispatch.channel = channel;
    return channel;
  } catch (error) {
    stream.fail(error instanceof PnpError ? error : new PnpError("ENGINE_HANDSHAKE_FAILED", describe(error), 502));
    connection.close();
    // The ownership record and the ResourceScope stop remain authoritative; a failed stop stays uncertain.
    await settleEvidence(hosted.terminate());
    throw error;
  }
}

async function establishSession(
  connection: ClientConnection, ledger: AcpCapabilityLedger, input: EngineOpenInput,
  initialize: InitializeResponse, mcpServers: McpServer[], requestMs: number, notices: OpenNotice[],
): Promise<{ sessionId: string; configOptions: SessionConfigOption[] }> {
  const previous = input.session.native?.nativeId;
  const cwd = input.session.directory;
  if (previous !== undefined && previous.length > 0) {
    if (initialize.agentCapabilities?.loadSession !== true) {
      // A native reference is not proof that the native session still exists: the process may have been killed.
      notices.push({ eventName: "session.context-lost", payload: toJson({ requested: previous, reason: "load-session-not-declared" }) });
    } else {
      try {
        const loaded = await boundedRequest(connection.agent.request(AGENT_METHODS.session_load, {
          sessionId: previous, cwd, mcpServers,
        }), requestMs);
        ledger.observe("acp.session.load", "verified");
        notices.push({ eventName: "session.restored", payload: toJson({ nativeId: previous }) });
        return { sessionId: previous, configOptions: [...(loaded.configOptions ?? [])] };
      } catch (error) {
        ledger.observe("acp.session.load", "probed");
        notices.push({ eventName: "session.context-lost", payload: toJson({ requested: previous, reason: describe(error) }) });
      }
    }
  }
  const created = await boundedRequest(connection.agent.request(AGENT_METHODS.session_new, { cwd, mcpServers }), requestMs);
  return { sessionId: created.sessionId, configOptions: [...(created.configOptions ?? [])] };
}
