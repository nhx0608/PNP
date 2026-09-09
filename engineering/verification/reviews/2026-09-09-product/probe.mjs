// Review probes only: real HTTP/SSE routes and temporary SQLite, with a Mock engine.
// No model calls, real Harnesses, user data, or external services are used.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateStore } from "../../../code/src/storage/store.ts";
import { GatewayCore } from "../../../code/src/core/gateway-core.ts";
import { MockPack } from "../../../code/src/engines/mock/pack.ts";
import { MockIntegration } from "../../../code/src/integration/mock/provider.ts";
import { buildApp } from "../../../code/src/gateway/app.ts";

const root = await mkdtemp(path.join(tmpdir(), "pnp-product-review-"));
const dataDirectory = path.join(root, "data");
await mkdir(dataDirectory);
const store = new StateStore(path.join(dataDirectory, "pnp.db"));
const core = new GatewayCore(store, new MockPack(), new MockIntegration(), { dataDirectory });
const app = buildApp(core);
const controller = new AbortController();
let reader;
let deadline;
try {
  const routes = [];
  for (const url of ["/", "/session", "/engines", "/runs", "/config"]) {
    const reply = await app.inject({ method: "GET", url });
    routes.push({ method: "GET", url, status: reply.statusCode });
  }

  // This proves server-side Origin acceptance only, not a full browser exploit.
  const originReply = await app.inject({
    method: "POST", url: "/session",
    headers: { origin: "https://untrusted.invalid", "content-type": "text/plain" },
    payload: JSON.stringify({ directory: path.join(root, "workspace"), title: "Review probe" }),
  });
  assert.equal(originReply.statusCode, 200);

  for (let index = 1; index <= 5000; index += 1) {
    await core.journal.publish("review.checkpoint", { index });
  }
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/event`, {
    signal: controller.signal, headers: { "Last-Event-ID": "0" },
  });
  reader = response.body.getReader();
  deadline = setTimeout(() => controller.abort(), 5000);
  const decoder = new TextDecoder();
  let received = "";
  while (!received.includes("id: 4096\n")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    received += decoder.decode(chunk.value, { stream: true });
  }
  await core.journal.publish("review.live", { index: 5001 });
  while (!received.includes("id: 5001\n")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    received += decoder.decode(chunk.value, { stream: true });
  }
  const ids = [...received.matchAll(/^id: (\d+)$/gm)].map((entry) => Number(entry[1]));
  assert.equal(ids.length, 4097);
  assert.equal(ids[4095], 4096);
  assert.equal(ids[4096], 5001);
  const missing = Array.from({ length: 5001 }, (_, index) => index + 1).filter((id) => !ids.includes(id));
  assert.equal(missing.length, 904);
  console.log(JSON.stringify({
    kind: "product-review-probes", platform: process.platform, node: process.version,
    routes,
    origin: { sent: "https://untrusted.invalid", contentType: "text/plain", status: originReply.statusCode,
      qualification: "Server-side inject only; browser network restrictions were not tested." },
    sse: { storedEvents: 5001, receivedEvents: ids.length, replayedThrough: ids[4095], nextLiveId: ids[4096],
      missingCount: missing.length, missingFirst: missing[0], missingLast: missing.at(-1),
      qualification: "The real route advances to live events after the replay limit without a gap signal." },
    qualification: "Defect reproduction; successful script exit means the observed gaps were reproduced, not fixed.",
  }, null, 2));
} finally {
  clearTimeout(deadline);
  await reader?.cancel().catch(() => undefined);
  controller.abort();
  await app.close();
  await store.close();
  // Retain the isolated temporary database for inspection; no recursive deletion in a review.
}
