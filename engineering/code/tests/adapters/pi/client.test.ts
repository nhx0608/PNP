import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { PiRpcClient } from "../../../src/drivers/pi-rpc/client.ts";
import { createFakeHostedProcess } from "./fixtures/fake-process.ts";

function lastWrite(process: ReturnType<typeof createFakeHostedProcess>): { id: string; type: string } {
  return JSON.parse(process.writes.at(-1)!) as { id: string; type: string };
}

test("send() correlates a response to its request id even when other frames interleave", async () => {
  const process = createFakeHostedProcess();
  const events: string[] = [];
  const client = new PiRpcClient(process, { onEvent: (e) => events.push(e.type) });
  const pending = client.send("get_state", {});
  const id = lastWrite(process).id;
  process.push(JSON.stringify({ type: "agent_start" })); // Unrelated event arrives first.
  process.push(JSON.stringify({ type: "response", id, command: "get_state", success: true, data: { version: "fixture-1" } }));
  assert.deepEqual(await pending, { version: "fixture-1" });
  assert.deepEqual(events, ["agent_start", "response"]);
});

test("send() rejects when the response reports failure", async () => {
  const process = createFakeHostedProcess();
  const client = new PiRpcClient(process);
  const pending = client.send("set_model", { provider: "x", model: "y" });
  const id = lastWrite(process).id;
  process.push(JSON.stringify({ type: "response", id, command: "set_model", success: false, error: "unknown model" }));
  await assert.rejects(pending, { code: "ENGINE_PROTOCOL_ERROR", message: "unknown model" });
});

test("a malformed frame is isolated and does not break correlation of the next real frame", async () => {
  const process = createFakeHostedProcess();
  const warnings: string[] = [];
  const client = new PiRpcClient(process, { onProtocolWarning: (line) => warnings.push(line) });
  const pending = client.send("get_state", {});
  const id = lastWrite(process).id;
  process.push("{not valid json");
  process.push(JSON.stringify({ type: "response", id, command: "get_state", success: true, data: {} }));
  await pending;
  assert.deepEqual(warnings, ["{not valid json"]);
});

test("process exit rejects every pending request instead of hanging forever", async () => {
  const process = createFakeHostedProcess();
  const client = new PiRpcClient(process);
  const first = client.send("get_state", {});
  const second = client.send("get_available_models", {});
  process.exit(1, null);
  await assert.rejects(first, { code: "ENGINE_UNAVAILABLE" });
  await assert.rejects(second, { code: "ENGINE_UNAVAILABLE" });
  await assert.rejects(client.send("get_state", {}), { code: "ENGINE_UNAVAILABLE" });
});

test("post() writes a fire-and-forget command without waiting for a response", async () => {
  const process = createFakeHostedProcess();
  const client = new PiRpcClient(process);
  await client.post("abort");
  assert.equal(JSON.parse(process.writes.at(-1)!).type, "abort");
});

test("dispose() rejects outstanding requests and stops reacting to further frames", async () => {
  const process = createFakeHostedProcess();
  const client = new PiRpcClient(process);
  const pending = client.send("get_state", {});
  client.dispose();
  await assert.rejects(pending, { code: "EXECUTION_CANCELLED" });
  await sleep(1); // No further frame delivery should throw synchronously if it leaked a listener.
  process.push(JSON.stringify({ type: "agent_start" }));
});
