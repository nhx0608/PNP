import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { StateStore } from "../../src/storage/store.ts";
import { GatewayCore } from "../../src/core/gateway-core.ts";
import { MockPack } from "../../src/engines/mock/pack.ts";
import type { MockOptions } from "../../src/engines/mock/pack.ts";
import { MockIntegration } from "../../src/integration/mock/provider.ts";
import type { PromptRequest } from "../../src/contracts/index.ts";

const prompt: PromptRequest = {
  parts: [{ type: "text", text: "inspect the workspace" }],
  model: { providerID: "test", modelID: "test" },
};
async function fixture(options: MockOptions = {}, timeout = 1000) {
  const directory = await mkdtemp(path.join(tmpdir(), "pnp-"));
  const dbPath = path.join(directory, "pnp.db");
  const store = new StateStore(dbPath);
  const pack = new MockPack(options);
  const core = new GatewayCore(store, pack, new MockIntegration(), {
    dataDirectory: directory, runTimeoutMs: timeout, cancelGraceMs: 30,
  });
  const session = await core.createSession(directory);
  return {
    directory, dbPath, store, pack, core, session,
    // The store's worker thread is closed even when the core reports uncertainty, so a failing test
    // still lets its process exit and the runner prints the failure instead of waiting on the file.
    async close() {
      try { await core.close(); }
      finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
    },
  };
}
async function waitBusy(f: Awaited<ReturnType<typeof fixture>>) {
  for (let i = 0; i < 100; i++) {
    if ((await f.core.getSession(f.session.id)).status === "busy") return;
    await sleep(5);
  }
  assert.fail("run did not enter busy");
}
test("normal execution commits final message before idle is visible", async () => {
  const f = await fixture();
  try {
    const types: string[] = [];
    f.core.journal.subscribe((e) => types.push(e.type));
    await f.core.run(f.session.id, prompt);
    const messages = await f.core.messages(f.session.id);
    assert.equal(messages[0]?.role, "user");
    assert.equal(messages.at(-1)?.info?.finish, "stop");
    assert.ok(messages.at(-1)?.parts?.some((p) => typeof p === "object" && p !== null && !Array.isArray(p) && p.type === "step-finish"));
    assert.ok(messages.some((m) => m.role === "tool"));
    assert.equal((await f.core.getSession(f.session.id)).status, "idle");
    assert.equal(types.at(-1), "session.idle");
    assert.equal(messages.filter((m) => m.role === "assistant" && m.content.includes("Mock turn 1")).length, 1);
  } finally { await f.close(); }
});
test("one global slot and per-session busy cannot run two prompts", async () => {
  const f = await fixture({ delayMs: 100 });
  try {
    const first = f.core.run(f.session.id, prompt);
    await waitBusy(f);
    await assert.rejects(f.core.run(f.session.id, prompt), { code: "GATEWAY_BUSY" });
    await first;
    assert.equal(f.pack.executions, 1);
  } finally { await f.close(); }
});
test("idempotency reuses completed result but rejects a different payload", async () => {
  const f = await fixture();
  try {
    await f.core.run(f.session.id, prompt, "same");
    await f.core.run(f.session.id, prompt, "same");
    assert.equal(f.pack.executions, 1);
    await assert.rejects(f.core.run(f.session.id, { ...prompt, parts: [{ type: "text", text: "different" }] }, "same"), { code: "IDEMPOTENCY_CONFLICT" });
  } finally { await f.close(); }
});
test("abort never produces a normal stop marker", async () => {
  const f = await fixture({ delayMs: 500 });
  try {
    const run = f.core.run(f.session.id, prompt).catch((e: unknown) => e);
    await waitBusy(f);
    await f.core.abort(f.session.id);
    await run;
    assert.equal((await f.core.messages(f.session.id)).at(-1)?.info?.finish, "cancelled");
    assert.equal((await f.core.getSession(f.session.id)).status, "idle");
  } finally { await f.close(); }
});
test("deadline settles the HTTP-facing run and does not fabricate success", async () => {
  const f = await fixture({ delayMs: 500 }, 60);
  try {
    await assert.rejects(f.core.run(f.session.id, prompt));
    assert.notEqual((await f.core.messages(f.session.id)).at(-1)?.info?.finish, "stop");
  } finally { await f.close(); }
});
test("failed engine leaves a queryable error trajectory", async () => {
  const f = await fixture({ fail: true });
  try {
    await assert.rejects(f.core.run(f.session.id, prompt));
    assert.equal((await f.core.messages(f.session.id)).at(-1)?.info?.finish, "error");
    assert.equal((await f.core.getSession(f.session.id)).status, "idle");
  } finally { await f.close(); }
});
test("unproven process termination fences its own session and leaves the gateway serving", async () => {
  const f = await fixture({ stuck: true, terminateQuiescent: false }, 60);
  try {
    await assert.rejects(f.core.run(f.session.id, prompt));
    // Uncertainty is a property of this session, not of the process.
    assert.equal(f.core.readiness, true);
    await assert.rejects(f.core.run(f.session.id, prompt), { code: "SESSION_UNAVAILABLE" });
    const diagnostics = await f.core.diagnostics();
    assert.equal(diagnostics.degraded, true);
    assert.deepEqual(diagnostics.fencedSessions.map((entry) => entry.id), [f.session.id]);
    assert.equal((await f.core.getSession(f.session.id)).status, "busy");
    assert.equal((await f.core.getSession(f.session.id)).recovery, "blocked");
    assert.equal((await f.core.messages(f.session.id)).at(-1)?.info?.finish, "interrupted");
    await assert.rejects(f.core.close(), { code: "EXECUTION_UNCERTAIN" });
    // Shutdown still refuses to claim a clean stop it cannot prove.
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("two session channels preserve distinct native histories", async () => {
  const f = await fixture();
  try {
    const second = await f.core.createSession(f.directory);
    await f.core.run(f.session.id, prompt);
    await f.core.run(second.id, prompt);
    await f.core.run(f.session.id, prompt);
    assert.match((await f.core.messages(f.session.id)).at(-1)!.content, /Mock turn 2/);
    assert.match((await f.core.messages(second.id)).at(-1)!.content, /Mock turn 1/);
  } finally { await f.close(); }
});
test("SQLite and native session survive a clean process lifecycle", async () => {
  const f = await fixture();
  await f.core.run(f.session.id, prompt);
  await f.core.close();
  await f.store.close();
  const store2 = new StateStore(f.dbPath);
  const core2 = new GatewayCore(store2, new MockPack(), new MockIntegration(), { dataDirectory: f.directory });
  try {
    assert.equal((await core2.getSession(f.session.id)).id, f.session.id);
    assert.ok((await core2.messages(f.session.id)).length > 1);
    await core2.run(f.session.id, prompt);
    assert.match((await core2.messages(f.session.id)).at(-1)!.content, /Mock turn 2/);
  } finally {
    await core2.close(); await store2.close(); await rm(f.directory, { recursive: true, force: true });
  }
});
test("recovery records interruption and does not automatically clear busy", async () => {
  const f = await fixture();
  try {
    await f.store.call("startRun", {
      run: { id: "stale", sessionId: f.session.id, state: "running", requestHash: "x", startedAt: new Date().toISOString() },
      message: { id: "stale-user", role: "user", content: "do not replay", created_at: new Date().toISOString() },
    });
    assert.equal(await f.store.call("recover", null), 1);
    assert.equal((await f.store.call("getRun", { runId: "stale" }))?.state, "interrupted");
    assert.equal((await f.core.getSession(f.session.id)).recovery, "blocked");
    await assert.rejects(f.core.run(f.session.id, prompt), { code: "SESSION_UNAVAILABLE" });
    assert.equal(f.pack.executions, 0);
  } finally { await f.close(); }
});
test("session deletion removes gateway history", async () => {
  const f = await fixture();
  try {
    await f.core.run(f.session.id, prompt);
    await f.core.deleteSession(f.session.id);
    await assert.rejects(f.core.getSession(f.session.id), { code: "NOT_FOUND" });
    assert.deepEqual(await f.store.call("messages", { sessionId: f.session.id }), []);
  } finally { await f.close(); }
});
test("unknown session fails without invoking a harness", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.core.run("missing", prompt), { code: "NOT_FOUND" });
    assert.equal(f.pack.executions, 0);
  } finally { await f.close(); }
});

test("cached native channel receives freshly resolved integration for every run", async () => {
  const f = await fixture();
  const observed: string[] = [];
  let revision = 0;
  const originalOpen = f.pack.open.bind(f.pack);
  f.pack.open = async (input) => {
    const channel = await originalOpen(input);
    const originalRun = channel.run.bind(channel);
    channel.run = async (run) => {
      observed.push(run.integration.model.headers["X-Test-Revision"] ?? "missing");
      return originalRun(run);
    };
    return channel;
  };
  const provider = new MockIntegration();
  const originalPrepare = provider.prepare.bind(provider);
  provider.prepare = async (input) => {
    const context = await originalPrepare(input);
    return { ...context, model: { ...context.model, headers: { "X-Test-Revision": String(++revision) } } };
  };
  const core = new GatewayCore(f.store, f.pack, provider, { dataDirectory: f.directory });
  try {
    await core.run(f.session.id, prompt);
    await core.run(f.session.id, prompt);
    assert.deepEqual(observed, ["1", "2"]);
    assert.equal(f.pack.opens, 1);
  } finally {
    await core.close();
    await f.close();
  }
});
test("the driver receives the provider-resolved model, not the caller's default sentinel", async () => {
  const f = await fixture();
  const observed: PromptRequest["model"][] = [];
  const originalOpen = f.pack.open.bind(f.pack);
  f.pack.open = async (input) => {
    const channel = await originalOpen(input);
    const originalRun = channel.run.bind(channel);
    channel.run = async (run) => {
      observed.push(run.request.model);
      return originalRun(run);
    };
    return channel;
  };
  // Mirrors the configured provider: an empty selection means "the default", which the provider
  // resolves to a concrete binding. A driver that compared the raw request against its launch-bound
  // model would report a model switch for a caller that asked for nothing at all.
  const provider = new MockIntegration();
  const originalPrepare = provider.prepare.bind(provider);
  provider.prepare = async (input) => {
    const context = await originalPrepare(input);
    const wantsDefault = input.request.model.providerID === "" && input.request.model.modelID === "";
    const selection = wantsDefault ? { providerID: "configured", modelID: "default-model" } : input.request.model;
    return { ...context, model: { ...context.model, selection } };
  };
  const core = new GatewayCore(f.store, f.pack, provider, { dataDirectory: f.directory });
  try {
    await core.run(f.session.id, { ...prompt, model: { providerID: "", modelID: "" } });
    await core.run(f.session.id, prompt);
    assert.deepEqual(observed, [{ providerID: "configured", modelID: "default-model" }, prompt.model]);
  } finally {
    await core.close();
    await f.close();
  }
});
