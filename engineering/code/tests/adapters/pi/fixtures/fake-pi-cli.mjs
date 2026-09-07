#!/usr/bin/env node
// Test-only fixture standing in for a real `pi --mode rpc` process. It speaks the wire format
// documented in docs/research/T02-pi-harness.md closely enough to exercise the real
// LocalProcessHost + PiRpcClient + PiSessionChannel path end to end (real OS process, real
// pipes, real Windows Job Object helper on win32) without depending on the actual proprietary
// `pi` binary. It is NOT evidence that the real `pi` engine has been verified; see
// docs/engines/pi.md "实现状态".
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let promptCount = 0;

function send(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
function respond(id, command, data = {}) {
  send({ type: "response", id, command, success: true, data });
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let command;
  try { command = JSON.parse(trimmed); }
  catch { return; } // Mirrors a real engine that would not crash on a stray malformed line either.
  const { id, type } = command;
  if (type === "prompt") {
    promptCount += 1;
    respond(id, "prompt", {});
    const message = typeof command.message === "string" ? command.message : "";
    setTimeout(() => {
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `Fixture turn ${promptCount}: ${message}` } });
      // Shape verified against a real installed pi 0.85.1 process (docs/engines/pi.md): the
      // stop reason lives on the last entry of `messages`, not on a top-level `stopReason`.
      send({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "stop" }] });
      send({ type: "agent_settled" });
    }, 5);
    return;
  }
  if (type === "abort") { respond(id, "abort", {}); return; }
  if (type === "get_state") { respond(id, "get_state", { version: "fixture-1.0.0" }); return; }
  // Every other documented command type is acknowledged generically; this fixture only needs to
  // exercise the driver's request/response framing and the prompt lifecycle above.
  respond(id, type, {});
});
rl.on("close", () => process.exit(0));
