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
interface ToolIdentity {
  name: string;
  source: "name" | "announced-title";
}
interface TrackedTool {
  /** Resolved once, when the call is first observed, and never changed by a later update. */
  identity?: ToolIdentity;
  title: string;
  /** True until the engine itself reports a terminal status. */
  open: boolean;
}
interface ToolObservation {
  name?: string | null;
  kind?: string | null;
  status?: ToolCallStatus | null;
  title?: string | null;
  rawInput?: unknown;
  content?: unknown;
  locations?: unknown;
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
/**
 * How the engine named this call, resolved once from the announcement and used for both the transcript and
 * the policy label. ACP's programmatic `name` is preferred; without it the title the call was announced
 * under is the engine's own label for the call, which is an observation rather than an invention (opencode
 * announces `title: "write"` and supplies no `name` at all). A call announced with neither has no identity:
 * a display `kind` is a category, not a call, and a later title never renames a call that already started.
 */
function identityOf(name: string | null | undefined, title: string | null | undefined): ToolIdentity | undefined {
  const programmatic = nonEmptyText(name);
  if (programmatic !== undefined) return { name: programmatic, source: "name" };
  const announced = nonEmptyText(title);
  return announced === undefined ? undefined : { name: announced, source: "announced-title" };
}
/**
 * Whether an update actually carries arguments. ACP lets an engine announce a call before the model has
 * bound them, and opencode does exactly that: the announcing `tool_call` carries `rawInput: {}`.
 */
function ownsValue(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key) && value[key as keyof typeof value] !== undefined;
}
function publicStatus(status: ToolCallStatus | null | undefined): "pending" | "running" | "completed" | "failed" | undefined {
  if (status === "in_progress") return "running";
  return status ?? undefined;
}
function arrayValue(value: unknown): Json[] {
  const projected = toJson(value);
  return Array.isArray(projected) ? projected : [];
}

/**
 * Translates ACP session updates into public driver events.
 *
 * The mapper owns the tool-call table so late updates cannot reopen a terminal identity, and it resolves one
 * identity per call (the programmatic `name`, else the announcing title, with `nameSource` recording which)
 * that both the transcript and the permission layer use. Every ACP tool update is emitted as `tool.observed`:
 * name, input, output, content and locations retain patch semantics, and Core alone decides when enough real
 * evidence exists for a canonical call/result. This avoids letting a renamed title rename a call, or a
 * missing terminal result become a fabricated failed result.
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
        if (existing !== undefined) return this.mapToolProgress(update.toolCallId, existing, update, "tool_call.duplicate");
        const identity = identityOf(update.name, update.title);
        const tracked: TrackedTool = {
          ...(identity === undefined ? {} : { identity }),
          title: update.title,
          open: true,
        };
        this.tools.set(update.toolCallId, tracked);
        return { events: [this.observation(update.toolCallId, "created", tracked, update)], text: "" };
      }
      case "tool_call_update": {
        let tracked = this.tools.get(update.toolCallId);
        if (tracked === undefined) {
          // This update is the first the engine ever showed of this call, so it is what announced it.
          const identity = identityOf(update.name, update.title);
          tracked = {
            ...(identity === undefined ? {} : { identity }),
            title: nonEmptyText(update.title) ?? nonEmptyText(update.kind) ?? "tool",
            open: true,
          };
          this.tools.set(update.toolCallId, tracked);
        }
        return this.mapToolProgress(update.toolCallId, tracked, update, "tool_call_update.late");
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
   * The name locked when the call was announced, or undefined for a call this mapper never saw and for one
   * the engine announced with no label at all.
   *
   * A permission request identifies its call by id and may carry nothing else the policy layer can key on:
   * opencode's `session/request_permission` sends no `name` and puts the target file path in `title`. The
   * announcing `tool_call` did carry the label, so it is read from here instead of from the request. This is
   * the same identity the transcript records: policy and trajectory must not disagree about what ran.
   */
  nameOf(callId: string): string | undefined {
    return this.tools.get(callId)?.identity?.name;
  }

  /** Every call the engine has not finished, including one still held for its arguments. */
  openCallIds(): string[] {
    return [...this.tools.entries()].filter(([, tool]) => tool.open).map(([callId]) => callId);
  }

  /**
   * Closes every call the engine left open, so a late update cannot reopen this turn's table. The engine
   * omitted the terminal state, so nothing terminal is emitted here: Core appends the gateway observation
   * (`result_unknown`) for the calls the engine never closed, and the turn keeps the engine's own stop
   * reason. An unclosed call is reported, never fabricated as a failed tool result and never a verdict on
   * the turn the engine itself finished.
   */
  closeOpenCalls(_errorCode: string, _detail: string): DriverEvent[] {
    for (const tool of this.tools.values()) {
      if (!tool.open) continue;
      tool.open = false;
    }
    // The engine supplied no terminal fact. Core owns the gateway-observation that closes the
    // persisted trajectory; the adapter must not manufacture a failed engine result.
    return [];
  }

  private observation(callId: string, phase: "created" | "updated", tracked: TrackedTool,
    raw: ToolObservation): Extract<DriverEvent, { type: "tool.observed" }> {
    // A call announced with nothing to name it can still gain a programmatic identity later; an identity
    // already resolved is never replaced, so a rewritten title cannot rename the call.
    if (tracked.identity === undefined) {
      const late = identityOf(raw.name, phase === "created" ? raw.title : undefined);
      if (late !== undefined) tracked.identity = late;
    }
    const title = nonEmptyText(raw.title);
    if (title !== undefined) tracked.title = title;
    const status = publicStatus(raw.status);
    if (status === "completed" || status === "failed") tracked.open = false;
    return {
      type: "tool.observed", source: "engine", callId, phase,
      ...(status === undefined ? {} : { status }),
      ...(tracked.identity === undefined ? {} : { name: tracked.identity.name, nameSource: tracked.identity.source }),
      ...(title === undefined ? {} : { title }),
      ...(ownsValue(raw, "rawInput") ? { input: toJson(raw.rawInput) } : {}),
      ...(ownsValue(raw, "rawOutput") ? { output: toJson(raw.rawOutput) } : {}),
      ...(ownsValue(raw, "content") ? { content: arrayValue(raw.content) } : {}),
      ...(ownsValue(raw, "locations") ? { locations: arrayValue(raw.locations) } : {}),
      ...(nonEmptyText(raw.kind) === undefined ? {} : { nativeType: nonEmptyText(raw.kind) }),
      ...(raw.status === null || raw.status === undefined ? {} : { nativeStatus: raw.status }),
    };
  }

  private mapToolProgress(callId: string, tracked: TrackedTool, raw: ToolObservation, lateEvent: string): MappedUpdate {
    if (!tracked.open) return { events: [nativeEvent(lateEvent, raw)], text: "" };
    this.sawStreamedContent = true;
    return { events: [this.observation(callId, "updated", tracked, raw)], text: "" };
  }
}
