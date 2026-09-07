import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeCommand, parsePiFrame } from "../../../src/drivers/pi-rpc/protocol.ts";

test("encodeCommand produces a single JSON line with id and type merged with the payload", () => {
  const line = encodeCommand("req-1", "prompt", { message: "hi" });
  assert.deepEqual(JSON.parse(line), { id: "req-1", type: "prompt", message: "hi" });
  assert.equal(line.includes("\n"), false);
});

test("parsePiFrame decodes a response envelope", () => {
  const event = parsePiFrame(JSON.stringify({ id: "req-1", type: "response", command: "prompt", success: true, data: { ok: true } }));
  assert.deepEqual(event, { type: "response", id: "req-1", command: "prompt", success: true, data: { ok: true } });
});

test("parsePiFrame decodes the documented agent lifecycle and tool events", () => {
  assert.deepEqual(parsePiFrame(JSON.stringify({ type: "agent_end", willRetry: false, stopReason: "end_turn" })),
    { type: "agent_end", willRetry: false, stopReason: "end_turn" });
  assert.deepEqual(parsePiFrame(JSON.stringify({ type: "agent_settled" })), { type: "agent_settled" });
  assert.deepEqual(parsePiFrame(JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } })),
    { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
  assert.deepEqual(parsePiFrame(JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { code: 0 }, isError: false })),
    { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { code: 0 }, isError: false });
});

test("parsePiFrame degrades an unrecognized type to unknown instead of throwing", () => {
  const raw = { type: "some_future_event", detail: "x" };
  assert.deepEqual(parsePiFrame(JSON.stringify(raw)), { type: "unknown", raw });
});

test("parsePiFrame rejects non-JSON and non-object frames as protocol errors", () => {
  assert.throws(() => parsePiFrame("not json"), { code: "ENGINE_PROTOCOL_ERROR" });
  assert.throws(() => parsePiFrame(JSON.stringify([1, 2, 3])), { code: "ENGINE_PROTOCOL_ERROR" });
  assert.throws(() => parsePiFrame(JSON.stringify({ no_type: true })), { code: "ENGINE_PROTOCOL_ERROR" });
});

test("parsePiFrame rejects tool events that are missing required identifiers", () => {
  assert.throws(() => parsePiFrame(JSON.stringify({ type: "tool_execution_start", toolName: "bash" })), { code: "ENGINE_PROTOCOL_ERROR" });
  assert.throws(() => parsePiFrame(JSON.stringify({ type: "tool_execution_end", toolCallId: "c1" })), { code: "ENGINE_PROTOCOL_ERROR" });
});
