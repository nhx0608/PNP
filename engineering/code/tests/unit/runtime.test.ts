import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { JsonlDecoder } from "../../src/runtime/jsonl.ts";
import { LocalProcessHost, supervisorEngineExit } from "../../src/runtime/process-host.ts";
import { OwnedResourceScope } from "../../src/runtime/resource-scope.ts";
import { Redactor } from "../../src/security/redaction.ts";
import { acquireInstanceLock } from "../../src/runtime/instance-lock.ts";
import { bounded } from "../../src/runtime/deadline.ts";
import { isWithin } from "../../src/security/workspace.ts";
import { WindowsJobHost } from "../../src/runtime/windows-host.ts";
import { recoverOwnedState } from "../../src/runtime/recovery.ts";
import { StateStore } from "../../src/storage/store.ts";
import { MockPack } from "../../src/engines/mock/pack.ts";
import { MockIntegration } from "../../src/integration/mock/provider.ts";
import { GatewayCore } from "../../src/core/gateway-core.ts";

test("JSONL preserves unicode separators and splits only on LF", () => {
  const decoder = new JsonlDecoder();
  const frame = JSON.stringify({ text: "A\u2028B\u2029C" });
  assert.deepEqual(decoder.push(Buffer.from(frame + "\r\n")), [frame]);
  decoder.end();
});
test("JSONL handles split UTF-8 multibyte text", () => {
  const decoder = new JsonlDecoder();
  const bytes = Buffer.from(JSON.stringify({ text: "\u6d4b\u8bd5" }) + "\n");
  const results: string[] = [];
  for (const b of bytes) results.push(...decoder.push(Buffer.from([b])));
  assert.equal(JSON.parse(results[0]!).text, "\u6d4b\u8bd5");
  decoder.end();
});
test("JSONL rejects unbounded and truncated records", () => {
  assert.throws(() => new JsonlDecoder(2).push(Buffer.from("abcd")), { code: "ENGINE_PROTOCOL_ERROR" });
  const decoder = new JsonlDecoder();
  decoder.push(Buffer.from('{"x":1}'));
  assert.throws(() => decoder.end(), { code: "ENGINE_PROTOCOL_ERROR" });
});
test("redaction covers structured secrets and raw output", () => {
  const redactor = new Redactor(["test-secret-value"]);
  assert.equal(redactor.text("x test-secret-value y"), "x [REDACTED] y");
  assert.equal(redactor.text("Bearer abcdefghi"), "Bearer [REDACTED]");
  assert.deepEqual(redactor.json({ authorization: "anything", output: "test-secret-value" }), {
    authorization: "[REDACTED]", output: "[REDACTED]",
  });
});
test("data-directory lock rejects concurrent ownership", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-lock-"));
  try {
    const unlock = await acquireInstanceLock(path.join(dir, "gateway.lock"));
    await assert.rejects(acquireInstanceLock(path.join(dir, "gateway.lock")), { code: "INSTANCE_LOCKED" });
    await unlock();
    await (await acquireInstanceLock(path.join(dir, "gateway.lock")))();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("SQLite write diagnostics preserve sanitized identity and unknown outcome", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-sqlite-diagnostic-"));
  const store = new StateStore(path.join(dir, "pnp.db"));
  const now = new Date().toISOString();
  const session = { id: "duplicate", title: "duplicate", directory: dir, engineId: "mock", channelId: "mock-jsonl-v1",
    lifecycle: "active" as const, status: "idle" as const, recovery: "ready" as const, createdAt: now, updatedAt: now };
  try {
    await store.call("createSession", session);
    await assert.rejects(store.call("createSession", session), { code: "STORAGE_ERROR" });
    const [diagnostic] = store.diagnosticsSnapshot();
    assert.equal(diagnostic?.category, "sqlite");
    assert.match(diagnostic?.code ?? "", /^(?:ERR_)?SQLITE_/);
    assert.equal(diagnostic?.outcome, "unknown");
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});
test("deadline ends a never-resolving operation", async () => {
  await assert.rejects(bounded(new Promise<never>(() => undefined), 5), { code: "DEADLINE_EXCEEDED" });
});
test("lexical containment does not allow prefix lookalikes", () => {
  assert.equal(isWithin(path.resolve("allowed"), path.resolve("allowed", "inside")), true);
  assert.equal(isWithin(path.resolve("allowed"), path.resolve("allowed2")), false);
});
test("Windows-specific host rejects unsupported platforms", async () => {
  assert.equal((await new WindowsJobHost().reconcile({})).quiescent, false);
});
test("Windows supervisor exit frames preserve the real engine exit code", () => {
  assert.deepEqual(supervisorEngineExit({ type: "exit", code: 7, quiescent: true }), { code: 7, signal: null });
  assert.equal(supervisorEngineExit({ type: "ready", code: 0 }), undefined);
  assert.equal(supervisorEngineExit({ type: "exit", code: "0" }), undefined);
});
test("durable quiescent host evidence survives pre-spawn cancellation and PID reuse", async () => {
  const record = {
    hostId: randomUUID(), sessionId: randomUUID(), ownerToken: randomUUID(), parentPid: process.pid,
    generation: Date.now(), jobName: "unused-on-this-platform", platform: process.platform,
    helperPid: process.pid, windowsSessionId: process.platform === "win32" ? 1 : null, quiescent: true,
  };
  if (process.platform === "win32") record.jobName = `Local\\PNP-${record.hostId}`;
  const host = new LocalProcessHost(path.join(tmpdir(), randomUUID()));
  assert.equal((await host.reconcile(record)).quiescent, true);
  assert.equal((await host.reconcile({ ...record, helperPid: 0 })).quiescent, true);
  assert.equal((await host.reconcile({ ...record, ownerToken: "" })).quiescent, false);
});
test("Windows Job host reports the owned engine exit instead of the supervisor exit", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pnp-win-host-"));
  const scope = new OwnedResourceScope();
  try {
    const hosted = await new WindowsJobHost(directory).start({
      executable: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(7), 50)"],
      cwd: directory,
      env: {},
      sessionId: "windows-host-test",
      ownerToken: "windows-host-test",
    }, new AbortController().signal, scope);
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => hosted.onExit(resolve));
    assert.deepEqual(exit, { code: 7, signal: null });
    assert.equal((await scope.stop(5_000)).quiescent, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows launch failure records recoverable namespace and stop evidence", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pnp-win-failed-launch-"));
  const host = new LocalProcessHost(directory);
  try {
    await assert.rejects(host.start({
      executable: path.join(directory, "missing.exe"), args: [], cwd: directory, env: {},
      sessionId: "failed-launch", ownerToken: "failed-launch",
    }, new AbortController().signal, new OwnedResourceScope()), { code: "HOST_FAILURE" });
    const files = (await readdir(path.join(directory, "hosts"))).filter((file) => file.endsWith(".json"));
    assert.equal(files.length, 1);
    const record = JSON.parse(await readFile(path.join(directory, "hosts", files[0]!), "utf8"));
    assert.equal(Number.isInteger(record.windowsSessionId), true);
    assert.equal(record.quiescent, true);
    assert.equal((await host.reconcile(record)).quiescent, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("recovery confirms a blocked session only when every retained host is quiescent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pnp-recovery-"));
  const store = new StateStore(path.join(directory, "pnp.db"));
  const core = new GatewayCore(store, new MockPack(), new MockIntegration(), { dataDirectory: directory });
  const session = await core.createSession(directory);
  try {
    await store.call("startRun", { run: { id: "interrupted", sessionId: session.id, state: "running", requestHash: "x", startedAt: new Date().toISOString() },
      message: { id: "user", role: "user", content: "do not replay", created_at: new Date().toISOString() } });
    await mkdir(path.join(directory, "hosts"));
    await writeFile(path.join(directory, "hosts", "owned.json"), JSON.stringify({ sessionId: session.id, quiescent: true }));
    const summary = await recoverOwnedState(store, { start: async () => { throw new Error("not used"); },
      reconcile: async () => ({ quiescent: true, method: "process-tree" }) }, directory);
    assert.equal(summary.interrupted, 1);
    assert.equal(summary.confirmedSessions, 1);
    assert.equal((await store.call("getRun", { runId: "interrupted" }))?.state, "interrupted");
    assert.equal((await core.getSession(session.id)).status, "idle");
  } finally { await core.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("recovery remains globally fenced by an unverified retained host from another session", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pnp-recovery-global-"));
  const store = new StateStore(path.join(directory, "pnp.db"));
  const core = new GatewayCore(store, new MockPack(), new MockIntegration(), { dataDirectory: directory });
  const session = await core.createSession(directory);
  try {
    await store.call("startRun", { run: { id: "interrupted-global", sessionId: session.id, state: "running", requestHash: "x", startedAt: new Date().toISOString() },
      message: { id: "user-global", role: "user", content: "do not replay", created_at: new Date().toISOString() } });
    await mkdir(path.join(directory, "hosts"));
    await writeFile(path.join(directory, "hosts", "owned.json"), JSON.stringify({ sessionId: session.id, quiescent: true }));
    await writeFile(path.join(directory, "hosts", "orphan.json"), JSON.stringify({ sessionId: "deleted-session", quiescent: false }));
    const summary = await recoverOwnedState(store, { start: async () => { throw new Error("not used"); },
      reconcile: async (record) => ({ quiescent: record !== null && typeof record === "object" && !Array.isArray(record) && record.quiescent === true,
        method: "process-tree" }) }, directory);
    assert.equal(summary.unverifiedRecords, 1);
    assert.equal(summary.confirmedSessions, 0);
    assert.equal((await core.getSession(session.id)).recovery, "blocked");
  } finally {
    await core.close();
    await store.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("Windows process-lifetime guard excludes a second owner and releases on process exit", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pnp-guard-"));
  const moduleUrl = new URL("../../src/runtime/instance-lock.ts", import.meta.url).href;
  const source = `import { acquireProcessLifetimeLock } from ${JSON.stringify(moduleUrl)};\ntry { await acquireProcessLifetimeLock(process.env.GUARD_DIR); console.log("granted"); if (process.env.HOLD === "1") setInterval(() => {}, 1000); } catch (error) { console.log(error.code ?? "failed"); process.exitCode=2; }`;
  const launch = (hold: boolean) => spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
    env: { ...process.env, GUARD_DIR: directory, HOLD: hold ? "1" : "0" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const output = (child: ReturnType<typeof launch>) => new Promise<string>((resolve) => {
    let value = ""; child.stdout.on("data", (chunk: Buffer) => { value += chunk.toString(); if (value.includes("\n")) resolve(value.trim()); });
    child.on("close", () => resolve(value.trim()));
  });
  const first = launch(true);
  const firstClosed = new Promise<void>((resolve) => first.once("close", () => resolve()));
  try {
    assert.equal(await output(first), "granted");
    const second = launch(false);
    const secondClosed = new Promise<void>((resolve) => second.once("close", () => resolve()));
    assert.equal(await output(second), "INSTANCE_LOCKED");
    await secondClosed;
    first.kill();
    await firstClosed;
    const third = launch(false);
    const thirdClosed = new Promise<void>((resolve) => third.once("close", () => resolve()));
    assert.equal(await output(third), "granted");
    await thirdClosed;
  } finally { first.kill(); await firstClosed; await rm(directory, { recursive: true, force: true }); }
});
