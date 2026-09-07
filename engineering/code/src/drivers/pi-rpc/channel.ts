import type { HostedProcess } from "../../contracts/host.ts";
import type {
  DriverServices, EngineCapabilities, EngineOpenInput, EngineResult, EngineSessionChannel,
  IntegrationContext, Json, MessageFinish, NativeSessionRef, StopEvidence, StopReason, ToolBinding,
} from "../../contracts/index.ts";
import { PnpError } from "../../core/errors.ts";
import { deferred } from "../../runtime/deadline.ts";
import { PiRpcClient } from "./client.ts";
import type { PiEvent } from "./protocol.ts";
import { buildLaunchSpec, resolvePiLaunchConfig, resolveSessionPaths } from "./launch.ts";
import type { PiSessionPaths } from "./launch.ts";
import { writeToolBridge } from "./tool-bridge.ts";

/** Declared target; update alongside `code/config/engines/pi.json` once a release is locked and
 * exercised, per contracts.md "declared/probed/verified" evidence tiers. */
const DECLARED_PROTOCOL_VERSION = "pi-rpc (docs/research/T02-pi-harness.md, ~0.84.x, unverified)";

function fingerprintTools(tools: readonly ToolBinding[]): string {
  return JSON.stringify(tools.map((tool) => ({
    id: tool.id, command: tool.command, args: tool.args, sideEffect: tool.sideEffect,
    inputSchema: tool.inputSchema ?? null, envKeys: Object.keys(tool.env).sort(),
  })));
}
function modelKey(context: IntegrationContext): string {
  return `${context.model.selection.providerID}::${context.model.selection.modelID}`;
}
/** `EngineResult.finish` is deliberately narrower than the full `MessageFinish` union (it excludes
 * "tool-calls"/"interrupted", which describe mid-turn/observation states, not a run's terminal
 * outcome); this driver's stop-reason mapping never produces either, so the return type says so. */
function mapFinish(stopReason: string | undefined): Exclude<MessageFinish, "tool-calls" | "interrupted"> {
  switch (stopReason) {
    case undefined: case "end_turn": case "stop": case "complete": return "stop";
    case "max_tokens": case "length": return "length";
    case "content_filter": return "content-filter";
    case "cancelled": case "aborted": case "abort": return "cancelled";
    case "error": return "error";
    default: return "unknown";
  }
}

interface ToolState { name: string; finished: boolean }
interface RunTracker {
  readonly settle: ReturnType<typeof deferred<{ finalText: string; nativeStopReason: string }>>;
  readonly tools: Map<string, ToolState>;
  finalText: string;
  lastStopReason?: string;
  fallbackTimer?: NodeJS.Timeout;
  /** Serializes async event handling so `services.events.emit()` is always awaited in arrival
   * order (contracts.md §2: "事件回调必须返回并等待 emit()；不得 fire-and-forget"); a rejection
   * here fails the run instead of being silently dropped. */
  queue: Promise<void>;
}

export async function openPiSession(input: EngineOpenInput): Promise<EngineSessionChannel> {
  const config = resolvePiLaunchConfig();
  const paths = resolveSessionPaths(input.nativeDataDirectory);
  const extensionPath = await writeToolBridge(paths, input.integration.tools);
  const spec = buildLaunchSpec(config, {
    sessionId: input.session.id, ownerToken: input.session.id, cwd: input.session.directory,
    paths, extensionPath, model: input.integration.model,
  });
  const process = await input.host.start(spec, input.signal, input.resources);
  const channel = new PiSessionChannel(process, paths, input.integration.tools, modelKey(input.integration));
  try { await channel.handshake(); }
  catch (error) { await process.terminate().catch(() => undefined); throw error; }
  return channel;
}

/** One PNP gateway Session = one long-lived `pi --mode rpc` process + one pi session file.
 * Reused across runs (contracts.md "一个 Channel 只归属一个 Gateway Session"); only one run is
 * active on a channel at a time, so a single mutable `active` slot (not a map) is sufficient and
 * mirrors how `GatewayCore` already serializes execution per session. */
export class PiSessionChannel implements EngineSessionChannel {
  readonly native: NativeSessionRef;
  readonly capabilities: EngineCapabilities = {
    sessionResume: true, streaming: true, cancellation: true, nativeDelete: false,
    extensions: [{
      id: "pi.tool-bridge", available: true, configuration: "session", control: "extension",
      observation: "native", evidence: "declared",
    }],
  };
  private readonly client: PiRpcClient;
  private readonly process: HostedProcess;
  private readonly toolFingerprint: string;
  private currentModelKey: string;
  private active: { tracker: RunTracker; services: DriverServices; cancelling: boolean } | undefined;
  constructor(process: HostedProcess, paths: PiSessionPaths, tools: readonly ToolBinding[], initialModelKey: string) {
    this.process = process;
    this.toolFingerprint = fingerprintTools(tools);
    this.currentModelKey = initialModelKey;
    this.client = new PiRpcClient(process, {
      onEvent: (event) => this.dispatch(event),
      onProtocolWarning: () => { /* Isolated: a single malformed frame must not end the channel. */ },
    });
    // PiRpcClient.handleExit only rejects its own pending request/response correlations; an
    // in-flight run waiting on agent_settled needs its own, separate failure signal, or an
    // unexpected process death would leave run() hanging forever instead of failing loudly.
    process.onExit((exit) => {
      if (this.active === undefined) return;
      this.active.tracker.settle.reject(new PnpError("ENGINE_UNAVAILABLE",
        `Pi RPC process exited unexpectedly (code=${exit.code ?? "null"}, signal=${exit.signal ?? "null"}).`, 502));
    });
    this.native = { nativeId: paths.sessionFile, channelId: "rpc", engineVersion: "unknown", protocolVersion: DECLARED_PROTOCOL_VERSION, resumeToken: paths.sessionFile };
  }
  async handshake(): Promise<void> {
    // Best-effort only: an operator-visible diagnostic, not a precondition for a usable channel.
    try { await this.client.send("get_state", {}, 15_000); } catch { /* Version stays "unknown" until probed. */ }
  }
  private dispatch(event: PiEvent): void {
    if (event.type === "extension_ui_request") { void this.bridgeInteraction(event); return; }
    if (event.type === "response" || event.type === "session") return; // Handled by PiRpcClient / handshake.
    const run = this.active;
    if (run === undefined) return; // No active run: nothing owns this event's side effects yet.
    // Chain onto the run's own queue so events are handled (and emitted) strictly in arrival
    // order, and a rejection fails the run instead of vanishing as an unobserved async callback.
    run.tracker.queue = run.tracker.queue.then(() => this.handleRunEvent(event, run)).catch((error) => {
      run.tracker.settle.reject(error); // No-op if already settled; a Promise only settles once.
    });
  }
  private async handleRunEvent(event: PiEvent, run: { tracker: RunTracker; services: DriverServices; cancelling: boolean }): Promise<void> {
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent?.type === "text_delta" && event.assistantMessageEvent.delta !== undefined) {
          run.tracker.finalText += event.assistantMessageEvent.delta;
          await run.services.events.emit({ type: "text.delta", text: event.assistantMessageEvent.delta, nativeType: "message_update" });
        }
        return;
      case "tool_execution_start":
        if (run.tracker.tools.has(event.toolCallId)) {
          throw new PnpError("ENGINE_PROTOCOL_ERROR", "Pi RPC reused an active toolCallId.", 502);
        }
        run.tracker.tools.set(event.toolCallId, { name: event.toolName, finished: false });
        await run.services.events.emit({ type: "tool.started", callId: event.toolCallId, name: event.toolName, input: event.args ?? null });
        return;
      case "tool_execution_update":
        if (!run.tracker.tools.has(event.toolCallId)) {
          throw new PnpError("ENGINE_PROTOCOL_ERROR", "Pi RPC reported tool_execution_update for an unknown toolCallId.", 502);
        }
        await run.services.events.emit({ type: "tool.updated", callId: event.toolCallId, title: event.title ?? "" });
        return;
      case "tool_execution_end": {
        const state = run.tracker.tools.get(event.toolCallId);
        // Out-of-order/unknown ids are a genuine protocol violation, not something to paper over
        // with a fabricated tool.finished (contracts.md "禁止...伪造成功、tool result"); the run
        // fails with a clear, driver-attributed error instead.
        if (state === undefined || state.finished) {
          throw new PnpError("ENGINE_PROTOCOL_ERROR", "Pi RPC reported tool_execution_end for a toolCallId that was never started.", 502);
        }
        state.finished = true;
        await run.services.events.emit({ type: "tool.finished", callId: event.toolCallId, name: event.toolName, output: event.result ?? null, failed: event.isError });
        return;
      }
      case "agent_end":
        run.tracker.lastStopReason = event.stopReason;
        if (!event.willRetry) {
          // `agent_settled` should always follow (docs/research/T02-pi-harness.md), but an older
          // or divergent build might omit it; settle from `agent_end` after a short grace window
          // instead of hanging forever on an event that never arrives.
          clearTimeout(run.tracker.fallbackTimer);
          run.tracker.fallbackTimer = setTimeout(() => {
            if (this.active === run) run.tracker.settle.resolve({ finalText: run.tracker.finalText, nativeStopReason: event.stopReason ?? "agent_end" });
          }, 2_000);
        }
        return;
      case "agent_settled":
        clearTimeout(run.tracker.fallbackTimer);
        run.tracker.settle.resolve({ finalText: run.tracker.finalText, nativeStopReason: run.tracker.lastStopReason ?? "agent_settled" });
        return;
      default:
        await run.services.events.emit({ type: "native", namespace: "pi", eventName: event.type, payload: event as unknown as Json });
    }
  }
  private async bridgeInteraction(event: Extract<PiEvent, { type: "extension_ui_request" }>): Promise<void> {
    const run = this.active;
    if (run === undefined) { await this.respondUi(event.id, { confirmed: false, cancelled: true }); return; }
    try {
      if (event.method === "confirm") {
        const decision = await run.services.interact({ kind: "permission", operation: "pi.extension.confirm", payload: { title: event.title ?? "", message: event.message ?? "" } });
        await this.respondUi(event.id, { confirmed: decision.decision === "allow" });
      } else {
        const response = await run.services.interact({ kind: "question", operation: `pi.extension.${event.method}`,
          payload: { questions: [{ question: event.message ?? event.title ?? event.method, options: event.options ?? [] }] } });
        const value = response.decision === "answer" ? response.answers?.[0]?.[0] : undefined;
        await this.respondUi(event.id, value === undefined ? { cancelled: true } : { value });
      }
    } catch { await this.respondUi(event.id, { confirmed: false, cancelled: true }); }
  }
  private async respondUi(id: string, payload: Record<string, Json>): Promise<void> {
    try { await this.client.post("extension_ui_response", { id, ...payload }); }
    catch { /* The pi-side ctx.ui call already has its own timeout for a missing reply. */ }
  }
  async run(input: Parameters<EngineSessionChannel["run"]>[0]): Promise<EngineResult> {
    if (this.active !== undefined) throw new PnpError("SESSION_BUSY", "Pi RPC channel already has an active run.", 409);
    if (fingerprintTools(input.integration.tools) !== this.toolFingerprint) {
      throw new PnpError("ENGINE_TOOLS_IMMUTABLE", "This Pi RPC session was opened with different tools; open a new session to change tools.", 409);
    }
    const requestedModelKey = modelKey(input.integration);
    if (requestedModelKey !== this.currentModelKey) {
      await this.client.send("set_model", { provider: input.integration.model.selection.providerID, model: input.integration.model.selection.modelID });
      this.currentModelKey = requestedModelKey;
    }
    const tracker: RunTracker = { settle: deferred(), tools: new Map(), finalText: "", queue: Promise.resolve() };
    const activeRun = { tracker, services: input.services, cancelling: false };
    this.active = activeRun;
    try {
      const text = input.request.parts.map((part) => part.text).join("\n");
      // The `prompt` response is acceptance evidence only; completion is decided below by
      // `agent_settled` (contracts.md §4), never by this await resolving.
      await this.client.send("prompt", { message: text });
      const settled = await tracker.settle.promise;
      const finish = mapFinish(tracker.lastStopReason);
      if (activeRun.cancelling || input.signal.aborted) {
        return { state: "cancelled", finish: "cancelled", quiescent: true, finalText: settled.finalText, nativeStopReason: settled.nativeStopReason, taskOutcome: "unknown" };
      }
      if (finish === "stop") {
        return { state: "completed", finish: "stop", quiescent: true, finalText: settled.finalText, nativeStopReason: settled.nativeStopReason, taskOutcome: "unknown" };
      }
      return { state: "failed", finish, quiescent: true, finalText: settled.finalText, nativeStopReason: settled.nativeStopReason, taskOutcome: "unknown" };
    } finally {
      clearTimeout(tracker.fallbackTimer);
      this.active = undefined;
    }
  }
  /** Acceptance of the abort command is not stop evidence (contracts.md §2); `run()` only
   * returns once `agent_settled` (or the fallback above) actually observes the stop. */
  async cancel(_reason: StopReason): Promise<void> {
    if (this.active !== undefined) this.active.cancelling = true;
    if (!this.client.running) return;
    await this.client.post("abort");
  }
  async terminate(): Promise<StopEvidence> {
    this.client.dispose();
    return this.process.terminate();
  }
  async close(): Promise<StopEvidence> {
    // pi persists each turn to its JSONL session file as it goes; there is no separate flush
    // step, so close() and terminate() share the same underlying process shutdown.
    return this.terminate();
  }
}
