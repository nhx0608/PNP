import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTextOnlyPayload } from "../../../src/drivers/pi-rpc/extension/pnp-bridge.ts";

test("OpenAI-compatible pure text user content preserves exact Chinese and whitespace in string form", () => {
  const original = { model: "deployment-model", messages: [
    { role: "system", content: "instructions" },
    { role: "user", content: [{ type: "text", text: "写入 中文路径\n" }, { type: "text", text: " value " }] },
    { role: "assistant", content: null, tool_calls: [{ id: "call-1" }] },
    { role: "tool", content: "actual result", tool_call_id: "call-1" },
  ] };
  const snapshot = JSON.stringify(original);
  assert.deepEqual(normalizeTextOnlyPayload(original, "openai-completions"), {
    ...original, messages: original.messages.map((message) => message.role === "user"
      ? { ...message, content: "写入 中文路径\n value " } : message),
  });
  assert.equal(JSON.stringify(original), snapshot);
});

test("media, metadata, empty content, strings and other APIs keep their native representation", () => {
  for (const content of [
    [{ type: "image_url", image_url: { url: "data:image/png;base64,eA==" } }, { type: "text", text: "describe" }],
    [{ type: "text", text: "cached", cache_control: { type: "ephemeral" } }],
    [], "already text", [{ type: "text", text: 12 }],
  ]) assert.equal(normalizeTextOnlyPayload({ messages: [{ role: "user", content }] }, "openai-completions"), undefined);
  for (const api of ["anthropic-messages", "openai-responses", undefined]) {
    assert.equal(normalizeTextOnlyPayload({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, api), undefined);
  }
});
