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
