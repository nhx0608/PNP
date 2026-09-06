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
    // The store's worker thread is closed whatever the core's close reports: a test that fails on the
    // core's uncertainty must still let its process exit, or the runner waits on the file instead of
    // printing the failure.
    try { if (uncertain) await assert.rejects(core.close()); else await core.close(); }
    finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
  } };
}
async function waitFor(fn: () => Promise<boolean>) { for (let i=0;i<100;i++) { if (await fn()) return; await sleep(5); } assert.fail("condition not reached"); }

test("late channel after startup timeout is terminated and its proof lifts the session fence", async () => {
  const pack = new MockPack(); const open = pack.open.bind(pack); let cleanup = 0;
  pack.open = async (input) => { await sleep(100); const channel = await open(input); channel.terminate = async () => { cleanup++; return { quiescent: true, method: "process-tree" }; }; return channel; };
  const f = await create(pack, new MockIntegration(), { openTimeoutMs: 20 });
  try {
    await assert.rejects(f.core.run(f.session.id, request));
    // The gateway itself is unharmed: only this session waits for evidence.
    assert.equal(f.core.readiness, true);
    await assert.rejects(f.core.run(f.session.id, request), { code: "SESSION_UNAVAILABLE" });
    assert.equal((await f.core.getSession(f.session.id)).recovery, "blocked");
    // The late channel arrives ~100 ms in, then its termination, the scope stop and the fence lift each
    // hit storage; on a loaded Windows runner that is more than a fixed 130 ms, so the evidence is
    // awaited rather than assumed to have landed by then.
    await waitFor(async () => cleanup === 1 && (await f.core.getSession(f.session.id)).recovery === "ready");
    assert.equal(cleanup, 1);
    assert.equal((await f.core.diagnostics()).degraded, false);
  } finally { await f.clean(); }
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
test("terminal tool observation preserves partial facts without inventing a tool result", async () => {
  const pack = new MockPack(); const open = pack.open.bind(pack);
  pack.open = async (input) => {
    const channel = await open(input); const run = channel.run.bind(channel);
    channel.run = async (runInput) => {
      await runInput.services.events.emit({ type: "tool.observed", source: "engine", callId: "partial", phase: "created", status: "completed",
        name: "workspace.inspect", input: null, content: [{ type: "text", text: "partial native fact" }], locations: [{ path: "C:/work/file.txt", line: 3 }],
        nativeType: "tool_call", nativeStatus: "done" });
      await runInput.services.events.emit({ type: "tool.observed", source: "engine", callId: "partial", phase: "updated", status: "running",
        title: "Late metadata", content: [{ type: "text", text: "still terminal" }] });
      await runInput.services.events.emit({ type: "tool.observed", source: "engine", callId: "undefined-fields", phase: "terminal",
        status: "completed", name: "not-canonical", input: undefined, output: undefined });
      return run(runInput);
    };
    return channel;
  };
  const f = await create(pack);
  try {
    await f.core.run(f.session.id, request);
    const messages = await f.core.messages(f.session.id);
    const observed = messages.find((message) => message.tool_calls?.[0]?.id === "partial")!;
    assert.deepEqual(observed.tool_calls?.[0], { id: "partial", name: "workspace.inspect", arguments: null });
    assert.equal(messages.some((message) => message.role === "tool" && message.tool_call_id === "partial"), false);
    assert.equal(messages.some((message) => message.tool_calls?.[0]?.id === "undefined-fields"), false);
    assert.match(JSON.stringify(observed.parts), /partial native fact/);
    assert.ok(JSON.stringify(observed.parts).includes("C:/work/file.txt"));
    assert.match(JSON.stringify(observed.parts), /result_unknown/);
    assert.match(JSON.stringify(observed.parts), /"status":"completed"/);
  } finally { await f.clean(); }
});
test("output observed before a canonical identity remains an observation, not an orphaned tool result", async () => {
  const pack = new MockPack(); const open = pack.open.bind(pack);
  pack.open = async (input) => {
    const channel = await open(input); const run = channel.run.bind(channel);
    channel.run = async (runInput) => {
      await runInput.services.events.emit({ type: "tool.observed", source: "engine", callId: "late-identity", phase: "created", status: "running",
        output: { partial: true }, content: [{ type: "text", text: "output came first" }] });
      await runInput.services.events.emit({ type: "tool.observed", source: "engine", callId: "late-identity", phase: "terminal", status: "completed",
        name: "late.tool", input: { value: 1 }, locations: [{ path: "C:/work/late.txt" }] });
      return run(runInput);
    };
    return channel;
  };
  const f = await create(pack);
  try {
    await f.core.run(f.session.id, request);
    const messages = await f.core.messages(f.session.id);
    const observed = messages.find((message) => message.tool_calls?.[0]?.id === "late-identity")!;
    assert.deepEqual(observed.tool_calls?.[0], { id: "late-identity", name: "late.tool", arguments: { value: 1 } });
    assert.match(JSON.stringify(observed.parts), /output came first/);
    assert.equal(messages.some((message) => message.role === "tool" && message.tool_call_id === "late-identity"), false);
  } finally { await f.clean(); }
});
test("split tool identity accumulates while only terminal output becomes the canonical result", async () => {
  const pack = new MockPack(); const open = pack.open.bind(pack);
  pack.open = async (input) => {
    const channel = await open(input); const run = channel.run.bind(channel);
    channel.run = async (runInput) => {
      await runInput.services.events.emit({ type: "tool.observed", source: "engine", callId: "split", phase: "created",
        status: "pending", name: "split.tool" });
      await runInput.services.events.emit({ type: "tool.observed", source: "engine", callId: "split", phase: "updated",
        status: "running", input: { value: 1 }, output: { partial: true } });
      await runInput.services.events.emit({ type: "tool.observed", source: "engine", callId: "split", phase: "terminal",
        status: "completed", output: { final: true } });
      return run(runInput);
    };
    return channel;
  };
  const f = await create(pack);
  try {
    await f.core.run(f.session.id, request);
    const messages = await f.core.messages(f.session.id);
    assert.deepEqual(messages.find((message) => message.tool_calls?.[0]?.id === "split")?.tool_calls?.[0],
      { id: "split", name: "split.tool", arguments: { value: 1 } });
    const result = messages.find((message) => message.role === "tool" && message.tool_call_id === "split");
    assert.deepEqual(JSON.parse(result?.content ?? "null"), { final: true });
  } finally { await f.clean(); }
});
test("a tool call cannot mix observed and legacy event families", async () => {
  const pack = new MockPack(); const open = pack.open.bind(pack);
  pack.open = async (input) => {
    const channel = await open(input);
    channel.run = async (runInput) => {
      await runInput.services.events.emit({ type: "tool.observed", source: "engine", callId: "mixed", phase: "created",
        status: "running", name: "mixed.tool", input: null });
      await runInput.services.events.emit({ type: "tool.finished", callId: "mixed", name: "mixed.tool", output: null, failed: false });
      throw new Error("unreachable");
    };
    return channel;
  };
  const f = await create(pack);
  try { await assert.rejects(f.core.run(f.session.id, request), { code: "ENGINE_PROTOCOL_ERROR" }); }
  finally { await f.clean(); }
});
test("normal completion rejects an observation whose actual status remains nonterminal", async () => {
  const pack = new MockPack(); const open = pack.open.bind(pack);
  pack.open = async (input) => {
    const channel = await open(input); const run = channel.run.bind(channel);
    channel.run = async (runInput) => {
      await runInput.services.events.emit({ type: "tool.observed", source: "engine", callId: "unfinished", phase: "created", status: "running",
        content: [{ type: "text", text: "no canonical identity" }], locations: [] });
      return run(runInput);
    };
    return channel;
  };
  const f = await create(pack);
  try {
    await assert.rejects(f.core.run(f.session.id, request), { code: "ENGINE_PROTOCOL_ERROR" });
    const observation = (await f.core.messages(f.session.id)).find((message) => JSON.stringify(message.parts ?? []).includes("no canonical identity"))!;
    assert.equal(observation.tool_calls, undefined);
    assert.equal((await f.core.messages(f.session.id)).some((message) => message.role === "tool" && message.tool_call_id === "unfinished"), false);
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
    assert.deepEqual(observed, { decision: "answer", answers: [["A"]], source: "user" });
    await assert.rejects(f.core.interactions.reply(pending.id, "question", { decision: "answer", answers: [["A"]] }), { code: "NOT_FOUND" });
  } finally { await f.clean(); }
});
test("run completion closes unanswered interactions before a late reply", async () => {
  const pack = new MockPack({ delayMs: 100 }); const open = pack.open.bind(pack);
  let interaction: Promise<unknown> | undefined;
  pack.open = async (input) => { const channel = await open(input); const run = channel.run.bind(channel);
    channel.run = async (runInput) => {
      interaction = runInput.services.interact({ kind: "question", operation: "choose", payload: { questions: [] } });
      return run(runInput);
    }; return channel; };
  const provider = new MockIntegration(); const prepare = provider.prepare.bind(provider);
  provider.prepare = async (input) => ({ ...(await prepare(input)), authorize: async () => ({ effect: "ask", reasonCode: "ASK" }) });
  const f = await create(pack, provider);
  try {
    const running = f.core.run(f.session.id, request);
    await waitFor(async () => (await f.core.interactions.list("question")).length === 1);
    const pending = (await f.core.interactions.list("question"))[0]!;
    await running;
    assert.deepEqual(await interaction, { decision: "deny", source: "cancelled", reasonCode: "RUN_CANCELLED" });
    assert.deepEqual(await f.core.interactions.list("question"), []);
    await assert.rejects(f.core.interactions.reply(pending.id, "question", { decision: "answer", answers: [["late"]] }), { code: "NOT_FOUND" });
  } finally { await f.clean(); }
});
test("concurrent interaction replies have exactly one persisted winner", async () => {
  const pack = new MockPack(); const open = pack.open.bind(pack);
  pack.open = async (input) => { const channel = await open(input); const run = channel.run.bind(channel);
    channel.run = async (runInput) => { await runInput.services.interact({ kind: "question", operation: "choose", payload: { questions: [] } }); return run(runInput); }; return channel; };
  const provider = new MockIntegration(); const prepare = provider.prepare.bind(provider);
  provider.prepare = async (input) => ({ ...(await prepare(input)), authorize: async () => ({ effect: "ask", reasonCode: "ASK" }) });
  const f = await create(pack, provider);
  try {
    const running = f.core.run(f.session.id, request);
    await waitFor(async () => (await f.core.interactions.list("question")).length === 1);
    const pending = (await f.core.interactions.list("question"))[0]!;
    const replies = await Promise.allSettled([
      f.core.interactions.reply(pending.id, "question", { decision: "answer", answers: [["A"]] }),
      f.core.interactions.reply(pending.id, "question", { decision: "answer", answers: [["B"]] }),
    ]);
    assert.equal(replies.filter((reply) => reply.status === "fulfilled").length, 1);
    assert.equal(replies.filter((reply) => reply.status === "rejected").length, 1);
    await running;
  } finally { await f.clean(); }
});
test("organization deny is final and exposes no overridable pending approval", async () => {
  const pack = new MockPack(); const open = pack.open.bind(pack); let observed: unknown;
  pack.open = async (input) => { const channel = await open(input); const run = channel.run.bind(channel);
    channel.run = async (input) => { observed = await input.services.interact({ kind: "permission", operation: "file.write", payload: { patterns: ["x"] } }); return run(input); }; return channel; };
  // The default policy is allow, so an organizational deny has to be stated explicitly here.
  const provider = new MockIntegration(); const prepare = provider.prepare.bind(provider);
  provider.prepare = async (input) => ({ ...(await prepare(input)), authorize: async () => ({ effect: "deny", reasonCode: "ORGANIZATION_DENY" }) });
  const f = await create(pack, provider);
  try {
    await f.core.run(f.session.id, request);
    assert.deepEqual(observed, { decision: "deny", source: "policy", reasonCode: "ORGANIZATION_DENY" });
    assert.deepEqual(await f.core.interactions.list("permission"), []);
  } finally { await f.clean(); }
});
test("question policy allow still asks and uses question event names", async () => {
  const pack = new MockPack(); const open = pack.open.bind(pack); let observed: unknown;
  pack.open = async (input) => { const channel = await open(input); const run = channel.run.bind(channel);
    channel.run = async (runInput) => { observed = await runInput.services.interact({ kind: "question", operation: "choose", payload: { questions: [] } }); return run(runInput); }; return channel; };
  const provider = new MockIntegration(); const prepare = provider.prepare.bind(provider);
  provider.prepare = async (input) => ({ ...(await prepare(input)), authorize: async () => ({ effect: "allow", reasonCode: "ALLOWED_TO_ASK" }) });
  const f = await create(pack, provider); const types: string[] = [];
  f.core.journal.subscribe((event) => types.push(event.type));
  try {
    const running = f.core.run(f.session.id, request);
    await waitFor(async () => (await f.core.interactions.list("question")).length === 1);
    const pending = (await f.core.interactions.list("question"))[0]!;
    await f.core.interactions.reply(pending.id, "question", { decision: "answer", answers: [["A"]] });
    await running;
    assert.deepEqual(observed, { decision: "answer", answers: [["A"]], source: "user" });
    assert.ok(types.includes("question.asked"));
    assert.ok(types.includes("question.resolved"));
    assert.equal(types.includes("permission.resolved"), false);
  } finally { await f.clean(); }
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
test("resource scope retires only a known resource with independently proven quiescence", async () => {
  const scope = new OwnedResourceScope(); let calls = 0;
  scope.register("x", async () => { calls++; return { quiescent: true, method: "not-running" }; });
  assert.throws(() => scope.retire("x", { quiescent: false, method: "not-running" }), { code: "RESOURCE_UNPROVEN" });
  assert.throws(() => scope.retire("missing", { quiescent: true, method: "not-running" }), { code: "RESOURCE_UNKNOWN" });
  scope.retire("x", { quiescent: true, method: "not-running" });
  assert.equal((await scope.stop(50)).quiescent, true);
  assert.equal(calls, 0);
  assert.throws(() => scope.retire("x", { quiescent: true, method: "not-running" }), { code: "RESOURCE_UNKNOWN" });
});
test("resource scope forbids retirement while a cleanup attempt remains unresolved", async () => {
  const scope = new OwnedResourceScope(); let release: (() => void) | undefined;
  scope.register("x", async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { quiescent: true, method: "not-running" };
  });
  const stopping = scope.stop(1000);
  await sleep(0);
  assert.throws(() => scope.retire("x", { quiescent: true, method: "not-running" }), { code: "RESOURCE_STOPPING" });
  release!();
  assert.equal((await stopping).quiescent, true);
  assert.throws(() => scope.retire("x", { quiescent: true, method: "not-running" }), { code: "RESOURCE_UNKNOWN" });
});
test("resource scope shares an active stop attempt and retries only unproven resources", async () => {
  const scope = new OwnedResourceScope(); let calls = 0; let release: (() => void) | undefined;
  scope.register("x", async () => {
    calls++;
    if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
    return { quiescent: calls > 1, method: "process-tree" };
  });
  const first = scope.stop(1000); const concurrent = scope.stop(1000);
  await sleep(0);
  release!();
  assert.equal((await first).quiescent, false);
  assert.equal((await concurrent).quiescent, false);
  assert.equal(calls, 1);
  assert.equal((await scope.stop(1000)).quiescent, true);
  assert.equal((await scope.stop(1000)).quiescent, true);
  assert.equal(calls, 2);
});
test("resource scope timeout does not start a second cleanup while the first is unresolved", async () => {
  const scope = new OwnedResourceScope(); let calls = 0; let release: (() => void) | undefined;
  scope.register("x", async () => {
    calls++;
    await new Promise<void>((resolve) => { release = resolve; });
    return { quiescent: true, method: "process-tree" };
  });
  assert.equal((await scope.stop(5)).quiescent, false);
  const retry = scope.stop(1000);
  await sleep(10);
  assert.equal(calls, 1);
  release!();
  assert.equal((await retry).quiescent, true);
  assert.equal(calls, 1);
});
test("engine failure stops all resources registered by the session scope exactly once", async () => {
  const pack = new MockPack({ fail: true });
  const open = pack.open.bind(pack);
  let stopped = 0;
  pack.open = async (input) => {
    input.resources.register("extra", async () => { stopped++; return { quiescent: true, method: "not-running" }; });
    return open(input);
  };
  const f = await create(pack);
  try {
    await assert.rejects(f.core.run(f.session.id, request));
    assert.equal(stopped, 1);
  } finally { await f.clean(); }
});
test("session deletion stops all resources registered by its channel", async () => {
  const pack = new MockPack();
  const open = pack.open.bind(pack);
  let stopped = 0;
  pack.open = async (input) => {
    input.resources.register("extra", async () => { stopped++; return { quiescent: true, method: "not-running" }; });
    return open(input);
  };
  const f = await create(pack);
  try {
    await f.core.run(f.session.id, request);
    await f.core.deleteSession(f.session.id);
    assert.equal(stopped, 1);
  } finally { await f.clean(); }
});
test("blocked persisted execution cannot return a successful abort without an active run", async () => {
  const f = await create();
  try {
    await f.store.call("startRun", { run: { id: "stale-abort", sessionId: f.session.id, state: "running", requestHash: "x", startedAt: new Date().toISOString() },
      message: { id: "stale-abort-user", role: "user", content: "x", created_at: new Date().toISOString() } });
    await f.core.initialize();
    // No run is in flight, so abort reports this session's own unresolved state and nothing global.
    await assert.rejects(f.core.abort(f.session.id), { code: "SESSION_UNAVAILABLE", status: 409 });
  } finally { await f.clean(true); }
});
test("a late integration context is observed and released after prepare timeout", async () => {
  const provider = new MockIntegration();
  const prepare = provider.prepare.bind(provider);
  let released = 0;
  provider.prepare = async (input) => { await sleep(60); return prepare(input); };
  provider.release = async () => { released++; };
  const f = await create(new MockPack(), provider, { openTimeoutMs: 15 });
  try {
    await assert.rejects(f.core.run(f.session.id, request));
    await waitFor(async () => released === 1);
  } finally { await f.clean(); }
});
test("integration release still runs when terminal persistence becomes unavailable", async () => {
  const provider = new MockIntegration();
  let released = 0;
  provider.release = async () => { released++; };
  const f = await create(new MockPack({ delayMs: 100 }), provider);
  try {
    const running = f.core.run(f.session.id, request).catch((error: unknown) => error);
    await waitFor(async () => (await f.core.getSession(f.session.id)).status === "busy");
    await f.store.close();
    await running;
    assert.equal(released, 1);
    assert.equal(f.core.readiness, false);
  } finally { await f.clean(true); }
});
test("start-run storage failure permanently removes gateway readiness", async () => {
  const provider = new MockIntegration();
  const prepare = provider.prepare.bind(provider);
  let storeToClose: StateStore | undefined;
  provider.prepare = async (input) => {
    await storeToClose!.close();
    return prepare(input);
  };
  const f = await create(new MockPack(), provider);
  storeToClose = f.store;
  try {
    await assert.rejects(f.core.run(f.session.id, request), { code: "STORAGE_UNAVAILABLE" });
    assert.equal(f.core.readiness, false);
  } finally { await f.clean(true); }
});
test("online diagnostics remain safely readable after storage becomes unavailable", async () => {
  const f = await create();
  await f.store.close();
  try {
    const diagnostics = await f.core.diagnostics();
    assert.equal(diagnostics.ready, false);
    assert.equal(diagnostics.sessions, null);
    assert.ok(Array.isArray(diagnostics.storage));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
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
    await f.core.initialize();
    // Interrupted ownership fences its own session; a different session must still be able to run.
    assert.equal(f.core.readiness, true);
    await assert.rejects(f.core.run(f.session.id, request), { code: "SESSION_UNAVAILABLE" });
    const other = await f.core.createSession(f.dir);
    await f.core.run(other.id, request);
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
