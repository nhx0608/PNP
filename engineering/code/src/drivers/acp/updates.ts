import type { ContentBlock, SessionUpdate, StopReason as AcpStopReason, ToolCallStatus, Usage } from "@agentclientprotocol/sdk";
import type { DriverEvent, MessageFinish } from "../../contracts/index.ts";
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
  name: string;
  title: string;
  open: boolean;
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

/**
 * Translates ACP session updates into public driver events.
 *
 * The mapper owns the tool-call table because the public core rejects a tool update that has no open call
 * (UNMATCHED_TOOL_UPDATE / UNMATCHED_TOOL_RESULT) and rejects a completed run that still has open calls
 * (ENGINE_PROTOCOL_ERROR). Unmatched engine updates therefore become native observations, never fabricated calls.
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
        const name = update.name ?? update.title;
        const existing = this.tools.get(update.toolCallId);
        if (existing !== undefined) {
          // A repeated identity would be rejected as a duplicate tool call; treat it as an update.
          return this.mapToolProgress(update.toolCallId, existing, update.title, update.status, update, "tool_call.duplicate");
        }
        this.tools.set(update.toolCallId, { name, title: update.title, open: true });
        const events: DriverEvent[] = [
          { type: "tool.started", callId: update.toolCallId, name, input: toJson(update.rawInput ?? null) },
        ];
        if (isTerminalToolStatus(update.status)) {
          this.tools.set(update.toolCallId, { name, title: update.title, open: false });
          events.push({
            type: "tool.finished", callId: update.toolCallId, name,
            output: toJson({ status: update.status, content: update.content ?? null, rawOutput: update.rawOutput ?? null }),
            failed: update.status === "failed",
          });
        }
        return { events, text: "" };
      }
      case "tool_call_update": {
        const tracked = this.tools.get(update.toolCallId);
        if (tracked === undefined) {
          // An unknown identity is reported as an observation; the core would reject an unmatched update.
          return { events: [nativeEvent("tool_call_update.unknown", update)], text: "" };
        }
        return this.mapToolProgress(update.toolCallId, tracked, update.title ?? undefined, update.status ?? undefined, update, "tool_call_update.late");
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

  openCallIds(): string[] {
    return [...this.tools.entries()].filter(([, tool]) => tool.open).map(([callId]) => callId);
  }

  /**
   * Closes every call the engine left open. The engine omitted the terminal state, so the call is recorded as
   * failed with an explicit source; this is an observation, never a fabricated tool result.
   */
  closeOpenCalls(errorCode: string, detail: string): DriverEvent[] {
    const events: DriverEvent[] = [];
    for (const [callId, tool] of this.tools) {
      if (!tool.open) continue;
      tool.open = false;
      events.push({
        type: "tool.finished", callId, name: tool.name, failed: true,
        output: toJson({ observed: "no-terminal-tool-state", source: "driver-observation", errorCode, detail }),
      });
    }
    return events;
  }

  private mapToolProgress(callId: string, tracked: TrackedTool, title: string | undefined,
    status: ToolCallStatus | null | undefined, raw: unknown, lateEvent: string): MappedUpdate {
    if (!tracked.open) return { events: [nativeEvent(lateEvent, raw)], text: "" };
    this.sawStreamedContent = true;
    if (title !== undefined) tracked.title = title;
    if (!isTerminalToolStatus(status)) {
      return { events: [{ type: "tool.updated", callId, title: tracked.title }], text: "" };
    }
    tracked.open = false;
    const payload = raw as { content?: unknown; rawOutput?: unknown };
    return {
      events: [{
        type: "tool.finished", callId, name: tracked.name,
        output: toJson({ status, content: payload.content ?? null, rawOutput: payload.rawOutput ?? null }),
        failed: status === "failed",
      }],
      text: "",
    };
  }
}
