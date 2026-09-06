import type { ContentBlock, SessionUpdate, StopReason as AcpStopReason, ToolCallStatus, Usage } from "@agentclientprotocol/sdk";
import type { DriverEvent, Json, MessageFinish } from "../../contracts/index.ts";
import { toJson } from "./json.ts";

export const ACP_NAMESPACE = "acp";

/** ACP stop reasons are the channel's completion evidence; the raw value is always preserved separately. */
const finishByStopReason: Record<AcpStopReason, Exclude<MessageFinish, "tool-calls" | "interrupted">> = {
  end_turn: "stop",
  max_tokens: "length",
  max_turn_requests: "unknown",
  refusal: "content-filter",
  cancelled: "cancelled",
};
export function finishFor(stopReason: AcpStopReason): Exclude<MessageFinish, "tool-calls" | "interrupted"> {
  return finishByStopReason[stopReason] ?? "unknown";
}
export function isTerminalToolStatus(status: ToolCallStatus | null | undefined): boolean {
  return status === "completed" || status === "failed";
}

export interface MappedUpdate {
  events: DriverEvent[];
  /** Assistant text contributed to the final message. Thought chunks are excluded. */
  text: string;
}
interface TrackedTool {
  /** Read once, from the update that announced the call: engines rewrite the title while the call runs. */
  name: string;
  title: string;
  /** The most complete arguments the engine has shown for this call. */
  input: Json;
  /** True once the engine has shown non-empty arguments for the call. */
  bound: boolean;
  /** True once `tool.started` was emitted; the core knows the call only from that event on. */
  started: boolean;
  /** True until a terminal event was emitted for the call. */
  open: boolean;
}
/** Everything a terminal update contributes to the recorded result. */
interface ToolOutcome {
  content?: unknown;
  rawOutput?: unknown;
}
function nativeEvent(eventName: string, payload: unknown): DriverEvent {
  return { type: "native", namespace: ACP_NAMESPACE, eventName, payload: toJson(payload) };
}
function textOf(content: ContentBlock): string | undefined {
  return content.type === "text" ? content.text : undefined;
}
function positiveDelta(current: number, previous: number): number {
  return Number.isFinite(current) && current > previous ? current - previous : 0;
}
function nonEmptyText(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value === "" ? undefined : value;
}
/** The public tool name, resolved once so a later title never renames a call that already started. */
function toolName(name: string | null | undefined, title: string | null | undefined,
  kind: string | null | undefined): string {
  return nonEmptyText(name) ?? nonEmptyText(title) ?? nonEmptyText(kind) ?? "tool";
}
/**
 * Whether an update actually carries arguments. ACP lets an engine announce a call before the model has
 * bound them, and opencode does exactly that: the announcing `tool_call` carries `rawInput: {}`.
 */
function hasArguments(rawInput: unknown): boolean {
  if (rawInput === null || rawInput === undefined) return false;
  if (typeof rawInput !== "object") return true;
  if (Array.isArray(rawInput)) return rawInput.length > 0;
  return Object.keys(rawInput).length > 0;
}

/**
 * Translates ACP session updates into public driver events.
 *
 * The mapper owns the tool-call table because the public core rejects a tool update that has no open call
 * (UNMATCHED_TOOL_UPDATE / UNMATCHED_TOOL_RESULT) and rejects a completed run that still has open calls
 * (ENGINE_PROTOCOL_ERROR). Unmatched engine updates therefore become native observations, never fabricated calls.
 *
 * The core also records a call's arguments once, from `tool.started`, and accepts only a title afterwards. An
 * engine that announces a call before the model has bound its arguments (opencode sends `rawInput: {}` and the
 * real arguments one update later) would therefore leave `{}` in the transcript for good. Such a call is held
 * instead: it is tracked but not started, and the first update carrying arguments — or, failing that, the
 * terminal update or `closeOpenCalls` — starts it. A held call is never dropped.
 */
export class SessionUpdateMapper {
  private readonly tools = new Map<string, TrackedTool>();
  private contextUsed = 0;
  private turnInput = 0;
  private turnOutput = 0;
  sawStreamedContent = false;

  map(update: SessionUpdate): MappedUpdate {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const thought = update.sessionUpdate === "agent_thought_chunk";
        const text = textOf(update.content);
        if (text === undefined) {
          // Images, audio and resources are not text; degrade to a native event instead of inventing text.
          return { events: [nativeEvent(`${update.sessionUpdate}.content`, update)], text: "" };
        }
        this.sawStreamedContent = true;
        return {
          events: [{ type: "text.delta", text, ...(thought ? { nativeType: update.sessionUpdate } : {}) }],
          text: thought ? "" : text,
        };
      }
      case "user_message_chunk":
        // Echoes of client input (also replayed by session/load) are never assistant output.
        return { events: [nativeEvent("user_message_chunk", update)], text: "" };
      case "tool_call": {
        this.sawStreamedContent = true;
        const existing = this.tools.get(update.toolCallId);
        if (existing !== undefined) {
          // A repeated identity would be rejected as a duplicate tool call; treat it as an update.
          return this.mapToolProgress(update.toolCallId, existing, update.title, update.status, update, "tool_call.duplicate");
        }
        const tracked: TrackedTool = {
          name: toolName(update.name, update.title, update.kind),
          title: update.title,
          input: toJson(update.rawInput ?? null),
          bound: hasArguments(update.rawInput),
          started: false,
          open: true,
        };
        this.tools.set(update.toolCallId, tracked);
        const terminal = isTerminalToolStatus(update.status);
        // Announcing a call is not progress, so this emits the start and, for a call that arrives already
        // terminal, its result. A call announced without arguments is held until they arrive.
        if (!tracked.bound && !terminal) return { events: [], text: "" };
        const events: DriverEvent[] = [this.startEvent(update.toolCallId, tracked)];
        if (terminal) events.push(this.finishEvent(update.toolCallId, tracked, update.status, update));
        return { events, text: "" };
      }
      case "tool_call_update": {
        const tracked = this.tools.get(update.toolCallId);
        if (tracked === undefined) {
          // An unknown identity is reported as an observation; the core would reject an unmatched update.
          return { events: [nativeEvent("tool_call_update.unknown", update)], text: "" };
        }
        return this.mapToolProgress(update.toolCallId, tracked, update.title, update.status, update, "tool_call_update.late");
      }
      case "usage_update": {
        // ACP reports session-cumulative context usage; the public event carries this turn's increment.
        const delta = positiveDelta(update.used, this.contextUsed);
        if (Number.isFinite(update.used)) {
          // A compaction legitimately shrinks the total. Ratcheting past it would silently swallow
          // every later increment until the old high-water mark was passed again, so follow it down
          // and make the regression visible instead of losing it.
          const regressed = update.used < this.contextUsed;
          this.contextUsed = update.used;
          if (regressed) {
            return { events: [{ type: "usage", inputTokens: delta, source: "engine" },
              nativeEvent("usage_update.context_reduced", update)], text: "" };
          }
        }
        return { events: [{ type: "usage", inputTokens: delta, source: "engine" }], text: "" };
      }
      default:
        return { events: [nativeEvent(update.sessionUpdate, update)], text: "" };
    }
  }

  /** Turns the cumulative session totals reported with a prompt response into this turn's increment. */
  usageFromResponse(usage: Usage | null | undefined): DriverEvent | undefined {
    if (usage === null || usage === undefined) return undefined;
    const input = positiveDelta(usage.inputTokens, this.turnInput);
    const output = positiveDelta(usage.outputTokens, this.turnOutput);
    this.turnInput = Math.max(this.turnInput, Number.isFinite(usage.inputTokens) ? usage.inputTokens : this.turnInput);
    this.turnOutput = Math.max(this.turnOutput, Number.isFinite(usage.outputTokens) ? usage.outputTokens : this.turnOutput);
    return { type: "usage", inputTokens: input, outputTokens: output, source: "engine" };
  }

  /**
   * The tool name locked when the call was announced, or undefined for a call this mapper never saw.
   *
   * A permission request identifies its call by id and may carry nothing else the policy layer can key on:
   * opencode's `session/request_permission` sends no `name` and puts the target file path in `title`. The
   * announcing `tool_call` did carry the name, so it is read from here instead of from the request.
   */
  nameOf(callId: string): string | undefined {
    return this.tools.get(callId)?.name;
  }

  /** Every call the engine has not finished, including one still held for its arguments. */
  openCallIds(): string[] {
    return [...this.tools.entries()].filter(([, tool]) => tool.open).map(([callId]) => callId);
  }

  /**
   * Closes every call the engine left open. The engine omitted the terminal state, so the call is recorded as
   * failed with an explicit source; this is an observation, never a fabricated tool result.
   *
   * A call still held for its arguments is started here first, with whatever the engine did show: the
   * transcript must carry every call the engine declared, and the core rejects a result for a call it never
   * saw begin.
   */
  closeOpenCalls(errorCode: string, detail: string): DriverEvent[] {
    const events: DriverEvent[] = [];
    for (const [callId, tool] of this.tools) {
      if (!tool.open) continue;
      if (!tool.started) events.push(this.startEvent(callId, tool));
      tool.open = false;
      events.push({
        type: "tool.finished", callId, name: tool.name, failed: true,
        output: toJson({ observed: "no-terminal-tool-state", source: "driver-observation", errorCode, detail }),
      });
    }
    return events;
  }

  private startEvent(callId: string, tracked: TrackedTool): DriverEvent {
    tracked.started = true;
    return { type: "tool.started", callId, name: tracked.name, input: tracked.input };
  }

  private finishEvent(callId: string, tracked: TrackedTool, status: ToolCallStatus | null | undefined,
    outcome: ToolOutcome): DriverEvent {
    tracked.open = false;
    return {
      type: "tool.finished", callId, name: tracked.name,
      output: toJson({ status: status ?? null, content: outcome.content ?? null, rawOutput: outcome.rawOutput ?? null }),
      failed: status === "failed",
    };
  }

  private mapToolProgress(callId: string, tracked: TrackedTool, title: string | null | undefined,
    status: ToolCallStatus | null | undefined, raw: unknown, lateEvent: string): MappedUpdate {
    if (!tracked.open) return { events: [nativeEvent(lateEvent, raw)], text: "" };
    this.sawStreamedContent = true;
    const payload = raw as ToolOutcome & { rawInput?: unknown };
    const renamed = nonEmptyText(title);
    if (renamed !== undefined) tracked.title = renamed;
    if (hasArguments(payload.rawInput)) {
      // The arguments the call was announced without arrive here; these are the ones the transcript needs.
      tracked.input = toJson(payload.rawInput);
      tracked.bound = true;
    }
    const terminal = isTerminalToolStatus(status);
    const events: DriverEvent[] = [];
    if (!tracked.started) {
      // Still nothing to record the call with: keep the title this update carried and wait. A terminal
      // update starts the call regardless, because losing the call outright is worse than empty arguments.
      if (!tracked.bound && !terminal) return { events, text: "" };
      events.push(this.startEvent(callId, tracked));
    }
    if (!terminal) {
      events.push({ type: "tool.updated", callId, title: tracked.title });
      return { events, text: "" };
    }
    events.push(this.finishEvent(callId, tracked, status, payload));
    return { events, text: "" };
  }
}
