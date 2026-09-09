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
import { removeTree } from "../kit/fs.ts";

test("real SSE delivers connection and persisted terminal events alongside a blocking prompt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-sse-"));
  const directory = path.join(root, "data");
  await mkdir(directory, { recursive: true });
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
    const session = await core.createSession(path.join(root, "workspace"));
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
    await app.close(); await store.close(); await removeTree(root);
  }
});

test("a reconnect with Last-Event-ID replays the gap in order and without duplicates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-sse-resume-"));
  const directory = path.join(root, "data");
  await mkdir(directory, { recursive: true });
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
    const session = await core.createSession(path.join(root, "workspace"));
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
    await app.close(); await store.close(); await removeTree(root);
  }
});

// Reproduces the loss this endpoint used to hide: with more stored events than one resume can carry,
// a client asking for everything received 1..REPLAY_LIMIT and then jumped straight to the live tail.
// Its own cursor had moved past the missing range, so no later reconnect could recover it, and
// nothing in the stream said so. The truncation itself is kept; being told about it is the fix.
test("a resume past the replay limit announces the withheld range as server.gap", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-sse-gap-"));
  const directory = path.join(root, "data");
  await mkdir(directory, { recursive: true });
  const store = new StateStore(path.join(directory, "pnp.db"));
  const core = new GatewayCore(store, new MockPack(), new MockIntegration(), { dataDirectory: directory });
  const app = buildApp(core);
  const controller = new AbortController();
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const session = await core.createSession(path.join(root, "workspace"));
    // More events than a single resume writes (REPLAY_LIMIT is 4096), committed in batches because
    // the store refuses more than 1024 operations in flight.
    const total = 4200;
    for (let written = 0; written < total; written += 400) {
      await Promise.all(Array.from({ length: Math.min(400, total - written) }, (_, offset) =>
        core.journal.publish("test.filler", { sessionID: session.id, runID: "run-fill", index: written + offset })));
    }

    const response = await fetch(`${base}/event`, { signal: controller.signal, headers: { "Last-Event-ID": "0" } });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const deadline = setTimeout(() => controller.abort(), 30_000);
    try {
      // Read until the gap frame is complete, not merely started: a chunk boundary can land inside it.
      for (;;) {
        const at = received.indexOf('"type":"server.gap"');
        if (at >= 0 && received.indexOf("\n", at) >= 0) break;
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
    } finally { clearTimeout(deadline); }

    const at = received.indexOf('"type":"server.gap"');
    assert.ok(at >= 0, "a truncated resume must tell the client its history is incomplete");
    const frame = received.slice(received.lastIndexOf("data: ", at) + "data: ".length, received.indexOf("\n", at));
    const gap = JSON.parse(frame) as { type: string; properties: { from: number; to: number | null; reason: string } };
    assert.equal(gap.properties.reason, "replay-limit");
    const ids = [...received.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    assert.equal(ids.length, 4096, "one resume still writes at most REPLAY_LIMIT events");
    // The notice arrives before anything newer, and it is the only frame that carries no id, so the
    // client's Last-Event-ID never advances past the range it is being told it lost.
    assert.equal(gap.properties.from, Math.max(...ids) + 1);
    assert.equal(gap.properties.to, null, "the upper bound is unknown while nothing newer has arrived");
    assert.equal(received.slice(at).includes("id: "), false);
    // Incompleteness is now decidable from the stream alone: the gap starts inside the stored range.
    const committed = await core.journal.since(gap.properties.from - 1, 1);
    assert.equal(committed[0]?.sequence, gap.properties.from, "the announced range really is stored history");
  } finally {
    controller.abort();
    await app.close(); await store.close(); await removeTree(root);
  }
});
