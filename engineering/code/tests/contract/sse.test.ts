import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateStore } from "../../src/storage/store.ts";
import { GatewayCore } from "../../src/core/gateway-core.ts";
import { MockPack } from "../../src/engines/mock/pack.ts";
import { MockIntegration } from "../../src/integration/mock/provider.ts";
import { buildApp } from "../../src/gateway/app.ts";

test("real SSE delivers connection and persisted terminal events alongside a blocking prompt", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pnp-sse-"));
  const store = new StateStore(path.join(directory, "pnp.db"));
  const core = new GatewayCore(store, new MockPack({ delayMs: 50 }), new MockIntegration(), { dataDirectory: directory });
  const app = buildApp(core);
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/event`, { signal: controller.signal });
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = decoder.decode((await reader.read()).value);
    assert.match(received, /server.connected/);
    const session = await core.createSession(directory);
    const prompt = fetch(`${base}/session/${session.id}/prompt_async`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "test" }], model: { providerID: "test", modelID: "test" } }) });
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      while (!received.includes('"type":"session.idle"')) {
        const chunk = await reader.read(); if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
      assert.match(received, /session.status/);
      assert.match(received, /session.idle/);
      assert.equal((await prompt).status, 204);
      assert.equal((await core.messages(session.id)).at(-1)?.info?.finish, "stop");
    } finally { clearTimeout(timer); }
  } finally {
    await reader?.cancel().catch(() => undefined); controller.abort();
    await app.close(); await store.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("a reconnect with Last-Event-ID replays the gap in order and without duplicates", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pnp-sse-resume-"));
  const store = new StateStore(path.join(directory, "pnp.db"));
  const core = new GatewayCore(store, new MockPack(), new MockIntegration(), { dataDirectory: directory });
  const app = buildApp(core);
  const controller = new AbortController();
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    // Publish while nobody is listening: exactly the gap a dropped connection leaves behind.
    const session = await core.createSession(directory);
    await core.run(session.id, { parts: [{ type: "text", text: "one" }], model: { providerID: "test", modelID: "test" } });
    const committed = await core.journal.since(0, 1000);
    assert.ok(committed.length > 2, "the run must have committed events to resume from");
    const resumeFrom = committed[0]!.sequence;

    const response = await fetch(`${base}/event`, { signal: controller.signal, headers: { "Last-Event-ID": String(resumeFrom) } });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const deadline = setTimeout(() => controller.abort(), 5000);
    try {
      const last = committed.at(-1)!.sequence;
      while (!received.includes(`id: ${last}\n`)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
    } finally { clearTimeout(deadline); }

    const ids = [...received.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "replayed events must stay in sequence order");
    assert.equal(new Set(ids).size, ids.length, "a resume must not duplicate an event");
    assert.equal(ids.includes(resumeFrom), false, "Last-Event-ID is exclusive");
    assert.deepEqual(ids, committed.filter((event) => event.sequence > resumeFrom).map((event) => event.sequence));
  } finally {
    controller.abort();
    await app.close(); await store.close(); await rm(directory, { recursive: true, force: true });
  }
});
