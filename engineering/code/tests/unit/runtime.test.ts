import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { JsonlDecoder } from "../../src/runtime/jsonl.ts";
import { supervisorEngineExit } from "../../src/runtime/process-host.ts";
import { OwnedResourceScope } from "../../src/runtime/resource-scope.ts";
import { Redactor } from "../../src/security/redaction.ts";
import { acquireInstanceLock } from "../../src/runtime/instance-lock.ts";
import { bounded } from "../../src/runtime/deadline.ts";
import { isWithin } from "../../src/security/workspace.ts";
import { WindowsJobHost } from "../../src/runtime/windows-host.ts";

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
