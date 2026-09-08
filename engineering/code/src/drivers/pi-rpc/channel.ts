import { createHash, randomUUID } from "node:crypto";
import type { HostedProcess } from "../../contracts/host.ts";
import type {
  DriverServices, EngineCapabilities, EngineOpenInput, EngineResult, EngineSessionChannel,
  InteractionRequest, Json, MessageFinish, NativeSessionRef, ResolvedModel, StopEvidence,
  StopReason, ToolBinding,
} from "../../contracts/index.ts";
import { PnpError } from "../../core/errors.ts";
import { deferred } from "../../runtime/deadline.ts";
import { PiRpcClient } from "./client.ts";
import type { PiEvent } from "./protocol.ts";
import {
  buildLaunchSpec, fingerprintPiModel, readInstructionText, resolveBridgeExtensionPath,
  resolvePiLaunchConfig, resolveSessionPaths, writePiModelsConfig, writePiSettings,
} from "./launch.ts";
import type { PiSessionPaths } from "./launch.ts";
import { projectPiTools, writeToolBridge } from "./tool-bridge.ts";
import type { DroppedPiToolBinding } from "./tool-bridge.ts";

/** Probed, not merely declared: every wire shape this driver depends on was exercised against a
 * real `@earendil-works/pi-coding-agent` 0.85.1 process (`docs/engines/pi.md` B08 records the
 * commands). Update alongside `code/config/engines/pi.json` when a new release is locked. */
const DECLARED_PROTOCOL_VERSION = "pi-rpc (@earendil-works/pi-coding-agent 0.85.1, probed)";

function canonicalize(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key]!)]));
  }
  return value;
}
function compareKeys([left]: readonly [string, string], [right]: readonly [string, string]): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Hash every field that can alter routing, authorization, execution, or credentials. The digest
 * is safe to retain for session comparison; the canonical material (which includes secret values)
 * is never stored or logged. */
export function fingerprintPiTools(tools: readonly ToolBinding[]): string {
  const canonicalTools: Json[] = tools.map((tool) => {
    const common = {
      id: tool.id, transport: tool.transport, sideEffect: tool.sideEffect,
      timeoutMs: tool.timeoutMs ?? null, inputSchema: canonicalize(tool.inputSchema ?? null),
    };
    if (tool.transport === "mcp-http") {
      return { ...common, url: tool.url, headers: Object.entries(tool.headers).sort(compareKeys) };
    }
    return {
      ...common, command: tool.command, args: [...tool.args],
      env: Object.entries(tool.env).sort(compareKeys),
    };
  });
  return createHash("sha256").update(JSON.stringify(canonicalize(canonicalTools))).digest("hex");
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
  /** Serializes async event handling so `services.events.emit()` is always awaited in arrival
   * order (contracts.md §2: "事件回调必须返回并等待 emit()；不得 fire-and-forget"); a rejection
   * here fails the run instead of being silently dropped. */
  queue: Promise<void>;
}

export async function openPiSession(input: EngineOpenInput): Promise<EngineSessionChannel> {
  const config = resolvePiLaunchConfig();
  const paths = resolveSessionPaths(input.nativeDataDirectory);
  // Order matters: everything pi reads at startup must exist before the process is started. The
  // three writes below produce no credential on disk -- models.json and the tool sidecar carry
  // generated variable NAMES, and the values they refer to travel only in `LaunchSpec.env`.
  const bridge = await writeToolBridge(paths, input.integration.tools);
  const modelEnv = await writePiModelsConfig(paths, input.integration.model);
  await writePiSettings(paths);
  const spec = buildLaunchSpec(config, {
    sessionId: input.session.id,
    // The gateway Session id is public (it is in every client URL); an ownership record's holder
    // token must not be guessable from it (docs/engineering-review-3.md section 16 E3).
    ownerToken: randomUUID(),
    cwd: input.session.directory,
    paths,
    // Always loaded: even with no MCP server the extension carries the `tool_call` policy hook
    // that puts pi's own built-ins under the gateway's permission policy (section 16 A).
    extensionPath: resolveBridgeExtensionPath(),
    ...(bridge.bridgeFile === undefined ? {} : { bridgeFile: bridge.bridgeFile }),
    model: input.integration.model,
    modelEnv,
    toolEnv: bridge.env,
    ...await appendSystemPromptOption(input),
  });
  const process = await input.host.start(spec, input.signal, input.resources);
  const channel = new PiSessionChannel(process, paths, input.integration.tools, input.integration.model);
  try { await channel.handshake(); }
  catch (error) { await process.terminate().catch(() => undefined); throw error; }
  return channel;
}
async function appendSystemPromptOption(input: EngineOpenInput): Promise<{ appendSystemPrompt?: string }> {
  const text = await readInstructionText(input.integration.assets);
  return text === undefined ? {} : { appendSystemPrompt: text };
}

/** Real 0.85.1's `get_state` reply carries the session's model, thinking level and counters, but
 * no engine version at all (probed; `docs/engines/pi.md` B08 records the exact command). The
 * lookup stays because that reply is the only place a version could appear and reading one costs
 * nothing; when it is absent `engineVersion` honestly stays "unknown" rather than being guessed
 * from the configured package version, which is not proof of what is running. */
export function readEngineVersion(state: Json): string | undefined {
  if (state === null || typeof state !== "object" || Array.isArray(state)) return undefined;
  const record = state as Record<string, Json>;
  for (const key of ["version", "agentVersion", "piVersion"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Titles the in-pi bridge extension uses for a policy question, so a plain `ctx.ui.confirm` from
 * any other extension keeps the old generic behaviour instead of being read as an operation. */
export const POLICY_TITLE_PREFIX = "pnp:";
export function policyInteraction(title: string | undefined, message: string | undefined): InteractionRequest {
  const raw = title ?? "";
  const operation = raw.startsWith(POLICY_TITLE_PREFIX) ? raw.slice(POLICY_TITLE_PREFIX.length) : "";
  if (operation.length === 0) {
    return { kind: "permission", operation: "pi.extension.confirm", payload: { title: raw, message: message ?? "" } };
  }
  let tool = "";
  let patterns: string[] = [];
  try {
    const parsed: unknown = JSON.parse(message ?? "");
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as { tool?: unknown; patterns?: unknown };
      if (typeof record.tool === "string") tool = record.tool;
      if (Array.isArray(record.patterns)) patterns = record.patterns.filter((value): value is string => typeof value === "string");
    }
  } catch { /* A malformed message still authorizes: the operation from the title is what decides. */ }
  // `patterns` is the specification's field for the target; `title` and `locations` give an approver
  // the same picture the ACP driver publishes for an engine-side permission (tool + files named).
  const label: string = patterns.length > 0 ? `${tool || operation} ${patterns[0] ?? ""}` : (tool || operation);
  return { kind: "permission", operation, payload: { patterns, tool, title: label, locations: patterns.map((path) => ({ path })) } };
}

/** One PNP gateway Session = one long-lived `pi --mode rpc` process + one pi session file.
 * Reused across runs (contracts.md "一个 Channel 只归属一个 Gateway Session"); only one run is
 * active on a channel at a time, so a single mutable `active` slot (not a map) is sufficient and
 * mirrors how `GatewayCore` already serializes execution per session. */
export class PiSessionChannel implements EngineSessionChannel {
  readonly capabilities: EngineCapabilities = {
    sessionResume: true, streaming: true, cancellation: true, nativeDelete: false,
    extensions: [{
      // The in-pi MCP bridge plus its `tool_call` policy hook. "probed": a real 0.85.1 process
      // loaded `extension/pnp-bridge.ts` with `-e`, registered the fixture MCP server's tools,
      // and routed a built-in `bash` call through `pnp:shell` -> `extension_ui_request` -> block
      // (`docs/engines/pi.md` B08). Not "verified": no internal MCP server or model yet.
      id: "pi.mcp-bridge", available: true, configuration: "session", control: "extension",
      observation: "native", evidence: "probed",
    }],
  };
  private readonly client: PiRpcClient;
  private readonly process: HostedProcess;
  private readonly toolFingerprint: string;
  /** Identity of the model binding this process's fixed environment was built for. */
  private readonly modelFingerprint: string;
  private readonly droppedTools: readonly DroppedPiToolBinding[];
  private unsupportedNoticeSent = false;
  private exit: { code: number | null; signal: string | null } | undefined;
  private nativeSession: NativeSessionRef;
  private active: { tracker: RunTracker; services: DriverServices; cancelling: boolean; promptSubmitted: boolean } | undefined;
  constructor(process: HostedProcess, paths: PiSessionPaths, tools: readonly ToolBinding[], model: ResolvedModel) {
    this.process = process;
    this.toolFingerprint = fingerprintPiTools(tools);
    this.modelFingerprint = fingerprintPiModel(model);
    this.droppedTools = projectPiTools(tools).dropped;
    this.client = new PiRpcClient(process, {
      onEvent: (event) => this.dispatch(event),
      onProtocolWarning: () => { /* Isolated: a single malformed frame must not end the channel. */ },
    });
    // PiRpcClient.handleExit only rejects its own pending request/response correlations; an
    // in-flight run waiting on agent_settled needs its own, separate failure signal, or an
    // unexpected process death would leave run() hanging forever instead of failing loudly.
    process.onExit((exit) => {
      this.exit = exit;
      if (this.active === undefined) return;
      this.active.tracker.settle.reject(new PnpError("ENGINE_UNAVAILABLE",
        `Pi RPC process exited unexpectedly (code=${exit.code ?? "null"}, signal=${exit.signal ?? "null"}).`, 502));
    });
    this.nativeSession = { nativeId: paths.sessionFile, channelId: "rpc", engineVersion: "unknown", protocolVersion: DECLARED_PROTOCOL_VERSION, resumeToken: paths.sessionFile };
  }
  get native(): NativeSessionRef { return this.nativeSession; }
  /**
   * Separates the two failures `get_state` can report (docs/engineering-review-3.md section 16 E4).
   *
   * A pi process that died at startup (wrong entry path, an argument this build rejects) rejects
   * `send` immediately, and returning a "usable" channel then defers the real failure to the first
   * prompt, where it surfaces as "process is not running" and is attributed to the wrong thing. So
   * an exit during the handshake fails `open()` with `ENGINE_HANDSHAKE_FAILED`. A `get_state` that
   * merely fails or is unsupported stays tolerated: it is a diagnostic, not a precondition.
   *
   * The exit code and signal are all the detail available here -- `HostedProcess` exposes frames
   * and exit only, no stderr stream; the process's own startup output is captured (and redacted)
   * by `LocalProcessHost` in its own `HOST_*` diagnostics.
   */
  async handshake(): Promise<void> {
    let state: Json;
    try { state = await this.client.send("get_state", {}, 15_000); }
    catch (error) {
      const exit = this.exit;
      if (exit === undefined) return; // Unsupported/failed command on a live process: tolerated.
      throw new PnpError("ENGINE_HANDSHAKE_FAILED",
        `The Pi RPC process exited during the handshake (code=${exit.code ?? "null"}, signal=${exit.signal ?? "null"}); `
        + "the process's own startup output is in the process host's redacted diagnostics.", 502);
    }
    const version = readEngineVersion(state);
    if (version !== undefined) this.nativeSession = { ...this.nativeSession, engineVersion: version };
  }
  private dispatch(event: PiEvent): void {
    if (event.type === "extension_ui_request") { void this.bridgeInteraction(event); return; }
    if (event.type === "response" || event.type === "session") return; // Handled by PiRpcClient / handshake.
    const run = this.active;
    if (run === undefined || !run.promptSubmitted) return; // Preflight/startup events do not belong to a prompt yet.
    // Chain onto the run's own queue so events are handled (and emitted) strictly in arrival
    // order, and a rejection fails the run instead of vanishing as an unobserved async callback.
    run.tracker.queue = run.tracker.queue.then(() => this.handleRunEvent(event, run)).catch((error) => {
      run.tracker.settle.reject(error); // No-op if already settled; a Promise only settles once.
    });
  }
  private async handleRunEvent(event: PiEvent, run: { tracker: RunTracker; services: DriverServices; cancelling: boolean; promptSubmitted: boolean }): Promise<void> {
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
        // Real pi (0.85.1, verified) puts the terminal stop reason on the *last* message in
        // `messages`, not on a top-level `agent_end.stopReason` field — that field never
        // actually occurs on the wire. Reading a nonexistent top-level field previously left
        // `lastStopReason` permanently `undefined`, which `mapFinish` defaults to "stop": every
        // real run (including genuine upstream errors) was silently reported as a success.
        run.tracker.lastStopReason = event.messages.at(-1)?.stopReason;
        // No timer settles a run from `agent_end` (docs/engineering-review-3.md section 16 F). The
        // old 2-second fallback resolved the run as `completed` whenever `agent_settled` was
        // merely late -- and because `dispatch` only looks at the *current* active run, a late
        // `agent_settled` then landed on the NEXT run and settled it early with empty text. Real
        // 0.85.1 always emits `agent_settled` (probed); if a build ever did not, the run stays
        // pending until the process exits or `GatewayCore`'s own deadline fires, which is a
        // truthful timeout instead of a fabricated success.
        return;
      case "agent_settled":
        run.tracker.settle.resolve({ finalText: run.tracker.finalText, nativeStopReason: run.tracker.lastStopReason ?? "agent_settled" });
        return;
      default:
        await run.services.events.emit({ type: "native", namespace: "pi", eventName: event.type, payload: event as unknown as Json });
    }
  }
  private async bridgeInteraction(event: Extract<PiEvent, { type: "extension_ui_request" }>): Promise<void> {
    const run = this.active;
    if (run === undefined || !run.promptSubmitted) { await this.respondUi(event.id, { confirmed: false, cancelled: true }); return; }
    try {
      if (event.method === "confirm") {
        // A `pnp:<operation>` title is the in-pi policy hook asking the gateway to authorize one
        // tool call; anything else is an ordinary extension dialog and keeps the generic shape.
        const decision = await run.services.interact(policyInteraction(event.title, event.message));
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
    // Both bindings are fixed at `open()`: the tool sidecar and `models.json` are read once at pi
    // startup, and the values they name live in `LaunchSpec.env`, which cannot be changed on a
    // running process. Rebinding either one is refused with the same code the ACP driver uses
    // (docs/engineering-review-3.md section 16 B/E2), never silently served with the old binding.
    if (fingerprintPiTools(input.integration.tools) !== this.toolFingerprint) {
      throw new PnpError("ENGINE_BINDINGS_CHANGED", "This Pi RPC session was opened with a different tool set; open a new session to change tools.", 409);
    }
    if (fingerprintPiModel(input.integration.model) !== this.modelFingerprint) {
      throw new PnpError("ENGINE_BINDINGS_CHANGED", "This Pi RPC session was opened for a different model binding; open a new session to change the model.", 409);
    }
    const tracker: RunTracker = { settle: deferred(), tools: new Map(), finalText: "", queue: Promise.resolve() };
    // A process exit during preflight may reject this deferred before run() reaches its terminal
    // await. Attach a handler now to avoid an unhandled rejection; the later await still observes it.
    void tracker.settle.promise.catch(() => undefined);
    const activeRun = { tracker, services: input.services, cancelling: false, promptSubmitted: false };
    this.active = activeRun;
    const cancelledBeforePrompt = (): EngineResult | undefined =>
      activeRun.cancelling || input.signal.aborted
        ? { state: "cancelled", finish: "cancelled", quiescent: true, finalText: "", nativeStopReason: "cancelled-before-prompt", taskOutcome: "unknown" }
        : undefined;
    try {
      let cancelled = cancelledBeforePrompt();
      if (cancelled !== undefined) return cancelled;
      if (!this.unsupportedNoticeSent && this.droppedTools.length > 0) {
        await input.services.events.emit({
          type: "native", namespace: "pi", eventName: "tools.unsupported-transport",
          payload: this.droppedTools.map((tool) => ({ id: tool.id, transport: tool.transport, reason: tool.reason })),
        });
        this.unsupportedNoticeSent = true;
      }
      cancelled = cancelledBeforePrompt();
      if (cancelled !== undefined) return cancelled;
      const text = input.request.parts.map((part) => part.text).join("\n");
      // The `prompt` response is acceptance evidence only; completion is decided below by
      // `agent_settled` (contracts.md §4), never by this await resolving.
      activeRun.promptSubmitted = true;
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
      this.active = undefined;
    }
  }
  /** Acceptance of the abort command is not stop evidence (contracts.md §2); `run()` only returns
   * once `agent_settled` -- or the process exiting -- actually observes the stop. */
  async cancel(_reason: StopReason): Promise<void> {
    if (this.active !== undefined) this.active.cancelling = true;
    if (!this.client.running || this.active?.promptSubmitted !== true) return;
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
