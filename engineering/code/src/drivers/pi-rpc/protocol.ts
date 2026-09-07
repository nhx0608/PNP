import type { Json } from "../../contracts/index.ts";
import { PnpError } from "../../core/errors.ts";

/**
 * Wire types for `pi --mode rpc` (strict LF-delimited JSONL, one JSON object per line).
 *
 * Field names here follow `docs/research/T02-pi-harness.md` §"2. `--mode rpc`" (grep of
 * `packages/coding-agent/src/modes/rpc/rpc-types.ts` against pi 0.84.x). That report is a
 * preserved research input, not a first-party protocol spec shipped in this repository, so
 * every shape below is `declared` evidence until it is exercised against the exact locked
 * `pi` release recorded in `code/config/engines/pi.json`. Unknown/forward event types decode
 * to `{ type: "unknown" }` instead of throwing, so a future pi release cannot silently corrupt
 * an in-flight run merely by adding a new event.
 */

/** Commands this driver actually sends. The full RPC surface has ~36 command types; only the
 * subset needed for B01-B06 is implemented, matching the honesty rule against fabricated coverage. */
export type PiCommandType =
  | "prompt"
  | "abort"
  | "steer"
  | "follow_up"
  | "clear_queue"
  | "set_model"
  | "set_thinking_level"
  | "set_auto_compaction"
  | "new_session"
  | "switch_session"
  | "get_state"
  | "get_entries"
  | "get_available_models"
  | "extension_ui_response";

export interface PiCommand {
  readonly id: string;
  readonly type: PiCommandType;
  readonly [key: string]: Json | string | undefined;
}

export function encodeCommand(id: string, type: PiCommandType, payload: Readonly<Record<string, Json>> = {}): string {
  return JSON.stringify({ id, type, ...payload });
}

interface AssistantMessageEvent {
  readonly type: string;
  readonly contentIndex?: number;
  readonly delta?: string;
}
export type PiEvent =
  | { readonly type: "response"; readonly id: string; readonly command: string; readonly success: boolean; readonly data?: Json; readonly error?: string }
  | { readonly type: "session"; readonly version: number; readonly id: string; readonly cwd?: string; readonly parentSession?: string }
  | { readonly type: "agent_start" }
  | { readonly type: "agent_end"; readonly willRetry: boolean; readonly stopReason?: string }
  | { readonly type: "agent_settled" }
  | { readonly type: "turn_start" }
  | { readonly type: "turn_end" }
  | { readonly type: "message_start"; readonly role?: string }
  | { readonly type: "message_update"; readonly assistantMessageEvent?: AssistantMessageEvent; readonly usage?: Json }
  | { readonly type: "message_end" }
  | { readonly type: "tool_execution_start"; readonly toolCallId: string; readonly toolName: string; readonly args?: Json }
  | { readonly type: "tool_execution_update"; readonly toolCallId: string; readonly title?: string }
  | { readonly type: "tool_execution_end"; readonly toolCallId: string; readonly toolName: string; readonly result?: Json; readonly isError: boolean }
  | { readonly type: "queue_update"; readonly steering?: Json; readonly followUp?: Json }
  | { readonly type: "compaction_start"; readonly reason?: string }
  | { readonly type: "compaction_end"; readonly result?: Json }
  | { readonly type: "auto_retry_start" }
  | { readonly type: "auto_retry_end" }
  | { readonly type: "session_compact_failed"; readonly error?: string }
  | { readonly type: "extension_error"; readonly extensionPath?: string; readonly event?: string; readonly error?: string }
  | { readonly type: "bash_execution_update"; readonly id: string; readonly delta?: string }
  | { readonly type: "extension_ui_request"; readonly id: string; readonly method: string; readonly title?: string; readonly message?: string; readonly options?: Json; readonly timeout?: number }
  | { readonly type: "unknown"; readonly raw: Json };

function asString(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function asBoolean(value: unknown): boolean { return value === true; }
function asJson(value: unknown): Json { return value === undefined ? null : (value as Json); }

/** Parses one already-LF-framed line. Throws only when the line is not a JSON object at all;
 * a recognized-but-unfamiliar `type` degrades to `unknown` instead of aborting the channel. */
export function parsePiFrame(line: string): PiEvent {
  let parsed: unknown;
  try { parsed = JSON.parse(line); }
  catch { throw new PnpError("ENGINE_PROTOCOL_ERROR", "Pi RPC frame is not valid JSON.", 502); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PnpError("ENGINE_PROTOCOL_ERROR", "Pi RPC frame must be a JSON object.", 502);
  }
  const record = parsed as Record<string, unknown>;
  const type = asString(record.type);
  if (type === undefined) throw new PnpError("ENGINE_PROTOCOL_ERROR", "Pi RPC frame is missing a type field.", 502);
  switch (type) {
    case "response": {
      const id = asString(record.id);
      if (id === undefined) throw new PnpError("ENGINE_PROTOCOL_ERROR", "Pi RPC response is missing an id.", 502);
      return { type, id, command: asString(record.command) ?? "", success: asBoolean(record.success),
        ...(record.data === undefined ? {} : { data: asJson(record.data) }),
        ...(record.error === undefined ? {} : { error: asString(record.error) }) };
    }
    case "agent_end": return { type, willRetry: asBoolean(record.willRetry), ...(record.stopReason === undefined ? {} : { stopReason: asString(record.stopReason) }) };
    case "tool_execution_start": {
      const toolCallId = asString(record.toolCallId); const toolName = asString(record.toolName);
      if (toolCallId === undefined || toolName === undefined) throw new PnpError("ENGINE_PROTOCOL_ERROR", "tool_execution_start is missing identifiers.", 502);
      return { type, toolCallId, toolName, args: asJson(record.args) };
    }
    case "tool_execution_update": {
      const toolCallId = asString(record.toolCallId);
      if (toolCallId === undefined) throw new PnpError("ENGINE_PROTOCOL_ERROR", "tool_execution_update is missing toolCallId.", 502);
      return { type, toolCallId, ...(record.title === undefined ? {} : { title: asString(record.title) }) };
    }
    case "tool_execution_end": {
      const toolCallId = asString(record.toolCallId); const toolName = asString(record.toolName);
      if (toolCallId === undefined || toolName === undefined) throw new PnpError("ENGINE_PROTOCOL_ERROR", "tool_execution_end is missing identifiers.", 502);
      return { type, toolCallId, toolName, result: asJson(record.result), isError: asBoolean(record.isError) };
    }
    case "extension_ui_request": {
      const id = asString(record.id); const method = asString(record.method);
      if (id === undefined || method === undefined) throw new PnpError("ENGINE_PROTOCOL_ERROR", "extension_ui_request is missing identifiers.", 502);
      return { type, id, method, ...(record.title === undefined ? {} : { title: asString(record.title) }),
        ...(record.message === undefined ? {} : { message: asString(record.message) }),
        ...(record.options === undefined ? {} : { options: asJson(record.options) }),
        ...(record.timeout === undefined ? {} : { timeout: typeof record.timeout === "number" ? record.timeout : undefined }) };
    }
    case "message_update": {
      const raw = record.assistantMessageEvent;
      const assistantMessageEvent = raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? { type: asString((raw as Record<string, unknown>).type) ?? "", contentIndex: typeof (raw as Record<string, unknown>).contentIndex === "number" ? (raw as Record<string, unknown>).contentIndex as number : undefined,
            delta: asString((raw as Record<string, unknown>).delta) } : undefined;
      return { type, ...(assistantMessageEvent === undefined ? {} : { assistantMessageEvent }), ...(record.usage === undefined ? {} : { usage: asJson(record.usage) }) };
    }
    case "session": {
      const id = asString(record.id); const version = typeof record.version === "number" ? record.version : undefined;
      if (id === undefined || version === undefined) throw new PnpError("ENGINE_PROTOCOL_ERROR", "session header is missing id/version.", 502);
      return { type, id, version, ...(record.cwd === undefined ? {} : { cwd: asString(record.cwd) }), ...(record.parentSession === undefined ? {} : { parentSession: asString(record.parentSession) }) };
    }
    case "agent_start": case "agent_settled": case "turn_start": case "turn_end": case "message_end":
    case "auto_retry_start": case "auto_retry_end":
      return { type } as PiEvent;
    case "message_start": return { type, ...(record.role === undefined ? {} : { role: asString(record.role) }) };
    case "queue_update": return { type, ...(record.steering === undefined ? {} : { steering: asJson(record.steering) }), ...(record.followUp === undefined ? {} : { followUp: asJson(record.followUp) }) };
    case "compaction_start": return { type, ...(record.reason === undefined ? {} : { reason: asString(record.reason) }) };
    case "compaction_end": return { type, ...(record.result === undefined ? {} : { result: asJson(record.result) }) };
    case "session_compact_failed": return { type, ...(record.error === undefined ? {} : { error: asString(record.error) }) };
    case "extension_error": return { type, ...(record.extensionPath === undefined ? {} : { extensionPath: asString(record.extensionPath) }),
      ...(record.event === undefined ? {} : { event: asString(record.event) }), ...(record.error === undefined ? {} : { error: asString(record.error) }) };
    case "bash_execution_update": {
      const id = asString(record.id);
      if (id === undefined) throw new PnpError("ENGINE_PROTOCOL_ERROR", "bash_execution_update is missing id.", 502);
      return { type, id, ...(record.delta === undefined ? {} : { delta: asString(record.delta) }) };
    }
    default: return { type: "unknown", raw: asJson(parsed) };
  }
}
