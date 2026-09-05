import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GatewayCore } from "../../src/core/gateway-core.ts";
import { StateStore } from "../../src/storage/store.ts";
import { MockPack } from "../../src/engines/mock/pack.ts";
import { MockIntegration } from "../../src/integration/mock/provider.ts";
import { OwnedResourceScope } from "../../src/runtime/resource-scope.ts";
import { LocalProcessHost, baseEnvironment } from "../../src/runtime/process-host.ts";
import { Redactor } from "../../src/security/redaction.ts";
import type { CoreOptions } from "../../src/core/gateway-core.ts";
import type { EnginePack, IntegrationProvider, PromptRequest, Json } from "../../src/contracts/index.ts";
const request: PromptRequest = { parts: [{ type: "text", text: "test" }], model: { providerID: "test", modelID: "test" } };
async function create(pack: EnginePack = new MockPack(), provider: IntegrationProvider = new MockIntegration(), options: Partial<CoreOptions> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-contract-"));
  const store = new StateStore(path.join(dir, "pnp.db"));
  const core = new GatewayCore(store, pack, provider, { dataDirectory: dir, cancelGraceMs: 30, ...options });
  const session = await core.createSession(dir);
  return { dir, store, core, session, async clean(uncertain = false) {
    if (uncertain) await assert.rejects(core.close()); else await core.close();
    await store.close(); await rm(dir, { recursive: true, force: true });
  } };
}
async function waitFor(fn: () => Promise<boolean>) { for (let i=0;i<100;i++) { if (await fn()) return; await sleep(5); } assert.fail("condition not reached"); }

test("late channel after startup timeout is terminated and execution remains fenced", async () => {
  const pack = new MockPack(); const open = pack.open.bind(pack); let cleanup = 0;
  pack.open = async (input) => { await sleep(100); const channel = await open(input); channel.terminate = async () => { cleanup++; return { quiescent: true, method: "process-tree" }; }; return channel; };
  const f = await create(pack, new MockIntegration(), { openTimeoutMs: 20 });
  try {
    await assert.rejects(f.core.run(f.session.id, request));
    assert.equal(f.core.readiness, false);
    assert.equal((await f.core.getSession(f.session.id)).recovery, "blocked");
    await sleep(130); assert.equal(cleanup, 1);
    await assert.rejects(f.core.run(f.session.id, request), { code: "SERVICE_UNAVAILABLE" });
  } finally { await f.clean(true); }
});
test("cancelled tool has gateway observation without a fabricated tool result", async () => {
  const f = await create(new MockPack({ delayMs: 1000 }));
  try {
    const run = f.core.run(f.session.id, request).catch(() => undefined);
    await waitFor(async () => (await f.core.messages(f.session.id)).some((m) => m.tool_calls));
    await f.core.abort(f.session.id); await run;
    const messages = await f.core.messages(f.session.id);
    assert.equal(messages.filter((m) => m.role === "tool").length, 0);
    const tool = messages.find((m) => m.tool_calls)!;
    assert.match(JSON.stringify(tool.parts), /gateway-observation/);
    assert.match(JSON.stringify(tool.parts), /cancelled/);
    assert.equal(messages.at(-1)?.info?.finish, "cancelled");
  } finally { await f.clean(); }
});
test("channel mismatch rejects reuse even when the engine id matches", async () => {
  const f = await create();
  try {
    const other = new MockPack(); other.descriptor.channelId = "other";
    const core = new GatewayCore(f.store, other, new MockIntegration(), { dataDirectory: f.dir });
    await assert.rejects(core.run(f.session.id, request), { code: "ENGINE_SESSION_MISMATCH" });
    await core.close();
  } finally { await f.clean(); }
});
test("question reply is stored and resumes the waiting adapter", async () => {
  const pack = new MockPack(); const open = pack.open.bind(pack); let observed: unknown;
  pack.open = async (input) => { const channel = await open(input); const run = channel.run.bind(channel);
    channel.run = async (input) => { observed = await input.services.interact({ kind: "question", operation: "choose", payload: { questions: [{ question: "Select", options: [{ label: "A" }] }] } }); return run(input); }; return channel; };
  const provider = new MockIntegration(); const prepare = provider.prepare.bind(provider);
  provider.prepare = async (input) => ({ ...(await prepare(input)), authorize: async () => ({ effect: "ask", reasonCode: "ASK" }) });
  const f = await create(pack, provider);
  try {
    const running = f.core.run(f.session.id, request);
    await waitFor(async () => (await f.core.interactions.list("question")).length === 1);
    const pending = (await f.core.interactions.list("question"))[0]!;
    await f.core.interactions.reply(pending.id, "question", { decision: "answer", answers: [["A"]] });
    await running;
    assert.deepEqual(observed, { decision: "answer", answers: [["A"]] });
    await assert.rejects(f.core.interactions.reply(pending.id, "question", { decision: "answer", answers: [["A"]] }), { code: "NOT_FOUND" });
  } finally { await f.clean(); }
});
test("organization deny is final and exposes no overridable pending approval", async () => {
  const pack = new MockPack(); const open = pack.open.bind(pack); let observed: unknown;
  pack.open = async (input) => { const channel = await open(input); const run = channel.run.bind(channel);
    channel.run = async (input) => { observed = await input.services.interact({ kind: "permission", operation: "file.write", payload: { patterns: ["x"] } }); return run(input); }; return channel; };
  const f = await create(pack);
  try { await f.core.run(f.session.id, request); assert.deepEqual(observed, { decision: "deny" }); assert.deepEqual(await f.core.interactions.list("permission"), []); }
  finally { await f.clean(); }
});
test("deletion purges native data but retains workspace files", async () => {
  const f = await create();
  try {
    const output = path.join(f.dir, "user-output.txt"); await writeFile(output, "keep");
    await f.core.run(f.session.id, request);
    const native = (await f.core.getSession(f.session.id)).native!.resumeToken!;
    await f.core.deleteSession(f.session.id);
    await assert.rejects(access(native));
    assert.equal(await readFile(output, "utf8"), "keep");
  } finally { await f.clean(); }
});
test("resource scope closes registered resources and rejects later acquisition", async () => {
  const scope = new OwnedResourceScope(); let calls = 0;
  scope.register("x", async () => { calls++; return { quiescent: true, method: "not-running" }; });
  assert.equal((await scope.stop(50)).quiescent, true);
  await scope.stop(50); assert.equal(calls, 1);
  assert.throws(() => scope.register("y", async () => ({ quiescent: true, method: "not-running" })), { code: "RESOURCE_SCOPE_CLOSED" });
});
test("streaming known secret prefixes are held until they can be redacted", () => {
  const redactor = new Redactor(["secret-long-key"]);
  assert.equal(redactor.streamText("Output secret-long"), "Output ");
  assert.equal(redactor.streamText("Output secret-long-key!"), "Output [REDACTED]!");
});
test("host environment does not inherit arbitrary parent credentials", () => {
  process.env.PNP_TEST_SECRET = "do-not-inherit";
  try { assert.equal(baseEnvironment().PNP_TEST_SECRET, undefined); }
  finally { delete process.env.PNP_TEST_SECRET; }
});
test("real local process transport buffers early output and terminates owned group", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-host-"));
  const host = new LocalProcessHost(dir, 2000);
  const launchController = new AbortController();
  const scope = new OwnedResourceScope();
  let processHandle;
  try {
    processHandle = await host.start({ executable: process.execPath,
      args: ["-e", "process.stdout.write('ready\\n');process.stdin.on('data',b=>process.stdout.write(b))"],
      cwd: dir, env: {}, sessionId: "test", ownerToken: "test" }, launchController.signal, scope);
    launchController.abort(); // A completed acquisition must not bypass protocol-first run cancellation.
    const frames: string[] = []; processHandle.onFrame((line) => frames.push(line));
    await processHandle.write('{"echo":true}');
    await waitFor(async () => frames.some((f) => f.includes('"echo"')));
    assert.equal(frames[0], "ready");
    assert.equal((await processHandle.terminate()).quiescent, true);
  } finally { await scope.stop(2000); await rm(dir, { recursive: true, force: true }); }
});
test("runtime recovery fences admission until interrupted ownership is reconciled", async () => {
  const f = await create();
  try {
    await f.store.call("startRun", { run: { id: "interrupted", sessionId: f.session.id, state: "running", requestHash: "x", startedAt: new Date().toISOString() }, message: { id: "in", role: "user", content: "x", created_at: new Date().toISOString() } });
    await f.core.initialize(); assert.equal(f.core.readiness, false);
    await assert.rejects(f.core.run(f.session.id, request), { code: "SERVICE_UNAVAILABLE" });
  } finally { await f.clean(true); }
});

test("the same shared ProcessHost is injected into each native session open", async () => {
  const injected = { start: async () => { throw new Error("not called by mock"); }, reconcile: async () => ({ quiescent: true, method: "not-running" as const }) };
  const pack = new MockPack(); const original = pack.open.bind(pack); let seen: unknown;
  pack.open = async (input) => { seen = input.host; return original(input); };
  const f = await create(pack, new MockIntegration(), { processHost: injected });
  try { await f.core.run(f.session.id, request); assert.equal(seen, injected); }
  finally { await f.clean(); }
});
