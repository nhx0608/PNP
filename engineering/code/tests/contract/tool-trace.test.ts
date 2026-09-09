import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateStore } from "../../src/storage/store.ts";
import { GatewayCore } from "../../src/core/gateway-core.ts";
import { MockPack } from "../../src/engines/mock/pack.ts";
import { MockIntegration } from "../../src/integration/mock/provider.ts";
import { buildApp } from "../../src/gateway/app.ts";
import type { DriverEvent, Json, Message } from "../../src/contracts/index.ts";
import { removeTree } from "../kit/fs.ts";

interface ToolState {
  status?: string;
  title?: string;
  nameSource?: string;
  terminalStatus?: string;
  source?: string;
  nativeStatus?: string;
  nativeType?: string;
}
interface TracePart {
  type?: string;
  callID?: string;
  tool?: string;
  title?: string;
  input?: Json;
  output?: Json;
  state?: ToolState;
}

/** A pack that replays a driver's own event sequence before the mock's normal turn. */
function scripted(events: DriverEvent[]): MockPack {
  const pack = new MockPack();
  const open = pack.open.bind(pack);
  pack.open = async (input) => {
    const channel = await open(input);
    const run = channel.run.bind(channel);
    channel.run = async (runInput) => {
      for (const event of events) await runInput.services.events.emit(event);
      return run(runInput);
    };
    return channel;
  };
  return pack;
}
function toolParts(messages: Message[], callId: string): TracePart[] {
  return messages.flatMap((message) => (message.parts ?? []) as TracePart[])
    .filter((part) => part.type === "tool" && part.callID === callId);
}

/**
 * The trajectory the judge reads is `GET /session/{id}/message`, and a tool call's state there has to be
 * the state the call actually reached. The scripted events are the shape a real ACP engine sends: the call
 * is announced with a title and no arguments, the arguments arrive with the running update, and the
 * terminal update repeats neither the title nor the input.
 */
test("the message trace advances a tool call to its terminal state and keeps the name it was announced under", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-tool-trace-"));
  const dir = path.join(root, "data");
  await mkdir(dir, { recursive: true });
  const store = new StateStore(path.join(dir, "pnp.db"));
  const callId = "call_office_csv_read_0";
  const pack = scripted([
    { type: "tool.observed", source: "engine", callId, phase: "created", status: "pending",
      name: "office_csv_read", nameSource: "announced-title", title: "office_csv_read", input: {},
      locations: [], nativeType: "other", nativeStatus: "pending" },
    { type: "tool.observed", source: "engine", callId, phase: "updated", status: "running",
      title: "office_csv_read", input: { path: "D:/work/task.csv" }, locations: [],
      nativeType: "other", nativeStatus: "in_progress" },
    { type: "tool.observed", source: "engine", callId, phase: "updated", status: "completed",
      output: { output: "csv_read: 200 rows, 9 columns" }, nativeStatus: "completed" },
  ]);
  const core = new GatewayCore(store, pack, new MockIntegration(), { dataDirectory: dir });
  const app = buildApp(core);
  try {
    const created = await app.inject({ method: "POST", url: "/session", payload: { directory: path.join(root, "workspace") } });
    const id = (created.json() as { id: string }).id;
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", text: "read the csv" }] } })).statusCode, 204);

    const messages = (await app.inject({ method: "GET", url: `/session/${id}/message` })).json() as Message[];
    const parts = toolParts(messages, callId);
    // One call is one tool part, updated in place - which is what `message.part.updated` announces.
    assert.equal(parts.length, 1, `the trace must hold one part for this call, saw ${JSON.stringify(parts)}`);
    const part = parts[0]!;
    assert.equal(part.state?.status, "completed");
    // A terminal update that repeats no title must not erase the identity the announcement established.
    assert.equal(part.state?.title, "office_csv_read");
    assert.equal(part.tool, "office_csv_read");
    assert.equal(part.state?.nameSource, "announced-title");
    assert.equal(part.state?.nativeStatus, "completed");
    assert.deepEqual(part.input, { path: "D:/work/task.csv" });
    assert.deepEqual(part.output, { output: "csv_read: 200 rows, 9 columns" });
    assert.equal(part.state?.terminalStatus, undefined);
    // The engine's own result still stands beside the call.
    const result = messages.find((message) => message.role === "tool" && message.tool_call_id === callId);
    assert.equal(result?.tool_name, "office_csv_read");
    // The superseded states are not lost: the journal keeps every published part, in order.
    const published = (await core.eventsSince(0))
      .filter((event) => event.type === "message.part.updated")
      .map((event) => event.properties.part as TracePart | undefined)
      .filter((value): value is TracePart => value !== undefined && value.callID === callId)
      .map((value) => value.state?.status);
    assert.deepEqual(published, ["pending", "running", "completed"]);
  } finally {
    await app.close(); await store.close(); await removeTree(root);
  }
});

/**
 * The other half of the same rule: a call the engine never closed must read as what was actually observed.
 * Advancing the stored state must never turn an unfinished call into a completed one.
 */
test("a call the engine never completes is reported as an observed unknown result, never as completed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-tool-open-"));
  const dir = path.join(root, "data");
  await mkdir(dir, { recursive: true });
  const store = new StateStore(path.join(dir, "pnp.db"));
  const callId = "call_office_docx_write_0";
  const pack = scripted([
    { type: "tool.observed", source: "engine", callId, phase: "created", status: "pending",
      name: "office_docx_write", nameSource: "announced-title", title: "office_docx_write", input: {} },
    { type: "tool.observed", source: "engine", callId, phase: "updated", status: "running",
      input: { path: "D:/work/out.docx" } },
  ]);
  const core = new GatewayCore(store, pack, new MockIntegration(), { dataDirectory: dir });
  const app = buildApp(core);
  try {
    const created = await app.inject({ method: "POST", url: "/session", payload: { directory: path.join(root, "workspace") } });
    const id = (created.json() as { id: string }).id;
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", text: "write the report" }] } })).statusCode, 204);

    const messages = (await app.inject({ method: "GET", url: `/session/${id}/message` })).json() as Message[];
    const parts = toolParts(messages, callId);
    assert.equal(parts.some((part) => part.state?.status === "completed"), false,
      "an unfinished call must never be reported as completed");
    // What the engine last showed, and then the gateway's own explicitly sourced closing observation.
    assert.equal(parts[0]?.state?.status, "running");
    assert.equal(parts[0]?.tool, "office_docx_write");
    const closing = parts.at(-1)!;
    assert.equal(closing.state?.status, "error");
    assert.equal(closing.state?.terminalStatus, "result_unknown");
    assert.equal(closing.state?.source, "gateway-observation");
    assert.equal(closing.tool, "office_docx_write");
    assert.equal(closing.title, "office_docx_write");
    assert.deepEqual(closing.input, { path: "D:/work/out.docx" });
    // Nothing was invented: no engine result message exists for a call the engine never finished.
    assert.equal(messages.some((message) => message.role === "tool" && message.tool_call_id === callId), false);
  } finally {
    await app.close(); await store.close(); await removeTree(root);
  }
});
