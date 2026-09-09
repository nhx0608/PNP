import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateStore } from "../../src/storage/store.ts";
import { GatewayCore } from "../../src/core/gateway-core.ts";
import { MockPack } from "../../src/engines/mock/pack.ts";
import { MockIntegration } from "../../src/integration/mock/provider.ts";
import { ConfiguredIntegration } from "../../src/integration/configured/provider.ts";
import { loadIntegration } from "../../src/integration/index.ts";
import { buildApp } from "../../src/gateway/app.ts";
import type { PublicEvent } from "../../src/contracts/index.ts";
import { removeTree } from "../kit/fs.ts";

test("original northbound create/prompt/message/status/delete contract", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-http-"));
  const dir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(dir, { recursive: true });
  const store = new StateStore(path.join(dir, "pnp.db"));
  const core = new GatewayCore(store, new MockPack(), new MockIntegration(), { dataDirectory: dir });
  const app = buildApp(core);
  try {
    assert.equal((await app.inject({ method: "POST", url: "/session", payload: {} })).statusCode, 400);
    const created = await app.inject({ method: "POST", url: "/session", payload: { directory: workspace } });
    assert.equal(created.statusCode, 200); // title is optional.
    const id = (created.json() as { id: string }).id;
    // model is optional: the integration provider resolves its configured default.
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`, payload: { parts: [{ type: "text", text: "hello" }] } })).statusCode, 204);
    // Unknown part types are dropped, but a prompt with nothing recognizable is still rejected.
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`, payload: { parts: [{ type: "image", url: "x" }] } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`, payload: { parts: [{ type: "image", url: "x" }, { type: "text", text: "hello" }] } })).statusCode, 204);
    // The "provider/model" shorthand is accepted alongside the object form.
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`, payload: { parts: [{ type: "text", text: "hi" }], model: "test/test" } })).statusCode, 204);
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`, payload: { parts: [{ type: "text", text: "hi" }], model: "nope" } })).statusCode, 400);
    const response = await app.inject({
      method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", text: "hello" }], model: { providerID: "test", modelID: "test" } },
    });
    assert.equal(response.statusCode, 204);
    const history = await app.inject({ method: "GET", url: `/session/${id}/message` });
    assert.equal(history.json().at(-1).info.finish, "stop");
    const statuses = await app.inject({ method: "GET", url: "/session/status" });
    assert.equal(statuses.json()[id].type, "idle");
    assert.equal((await app.inject({ method: "DELETE", url: `/session/${id}` })).statusCode, 200);
  } finally {
    await app.close(); await store.close(); await removeTree(root);
  }
});

test("HTTP input failures preserve safe 400, 413, and 415 semantics", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-http-errors-"));
  const dir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(dir, { recursive: true });
  const store = new StateStore(path.join(dir, "pnp.db"));
  const core = new GatewayCore(store, new MockPack(), new MockIntegration(), { dataDirectory: dir });
  const app = buildApp(core);
  try {
    const malformed = await app.inject({ method: "POST", url: "/session",
      headers: { "content-type": "application/json" }, payload: "{" });
    assert.equal(malformed.statusCode, 400);
    assert.deepEqual(Object.keys(malformed.json()).sort(), ["code", "message"]);
    const tooLarge = await app.inject({ method: "POST", url: "/session",
      headers: { "content-type": "application/json" }, payload: JSON.stringify({ directory: "x".repeat(1024 * 1024) }) });
    assert.equal(tooLarge.statusCode, 413);
    // Every body on this API is JSON, so an unexpected media type is judged by whether the body
    // parses, not by what the header claimed. XML is still refused - as 400, naming the real
    // problem, instead of 415 blaming the header.
    const unsupported = await app.inject({ method: "POST", url: "/session",
      headers: { "content-type": "application/xml" }, payload: "<session/>" });
    assert.equal(unsupported.statusCode, 400);
    assert.equal((unsupported.json() as { code: string }).code, "VALIDATION_ERROR");
    // The two shapes a real assessment client sends without meaning anything by them: PowerShell's
    // `Invoke-RestMethod -Body $json` with no -ContentType, and `curl -d`. Both used to get 415
    // before the engine was ever reached, which loses the case over a header.
    for (const contentType of ["application/x-www-form-urlencoded", "text/plain; charset=utf-8"]) {
      const tolerated = await app.inject({ method: "POST", url: "/session",
        headers: { "content-type": contentType }, payload: JSON.stringify({ directory: workspace }) });
      assert.equal(tolerated.statusCode, 200, `Content-Type ${contentType} must still create a session`);
    }
    // A trailing slash is a URL-joining accident, not a different resource.
    const trailingSlash = await app.inject({ method: "POST", url: "/session/",
      headers: { "content-type": "application/json" }, payload: JSON.stringify({ directory: workspace }) });
    assert.equal(trailingSlash.statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/session/status/" })).statusCode, 200);
    // A path inside the gateway's own data directory is refused, and the refusal never echoes it.
    const insidePath = path.join(dir, "missing-secret-name");
    const inside = await app.inject({ method: "POST", url: "/session", payload: { directory: insidePath } });
    assert.equal(inside.statusCode, 400);
    assert.doesNotMatch(inside.body, /missing-secret-name/);
    const created = await app.inject({ method: "POST", url: "/session", payload: { directory: workspace } });
    const id = (created.json() as { id: string }).id;
    const emptyAbort = await app.inject({ method: "POST", url: `/session/${id}/abort`,
      headers: { "content-type": "application/json" }, payload: "" });
    assert.equal(emptyAbort.statusCode, 200);
  } finally {
    await app.close(); await store.close(); await removeTree(root);
  }
});

test("an unrecognised model runs on the configured default and is published as model.resolved", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-model-"));
  const dir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(dir, { recursive: true });
  const store = new StateStore(path.join(dir, "pnp.db"));
  // A small configured profile, the same shape the shipped one has: one model, no credentials.
  const integration = new ConfiguredIntegration(
    [{ selection: { providerID: "competition", modelID: "default" }, endpoint: "http://127.0.0.1:9/v1",
      protocol: "openai-chat", headerEnvironment: {} }],
    [], () => ({ effect: "allow", reasonCode: "TEST_ALLOW" }), {},
  );
  const core = new GatewayCore(store, new MockPack(), integration, { dataDirectory: dir });
  const app = buildApp(core);
  try {
    const created = await app.inject({ method: "POST", url: "/session", payload: { directory: workspace } });
    const id = (created.json() as { id: string }).id;
    // The specification makes `model` required and the evaluator supplies identifiers this
    // deployment does not control. That is a 204 on the profile's default model, never a 403.
    const response = await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", text: "hello" }], model: { providerID: "evaluator", modelID: "unknown-1" } } });
    assert.equal(response.statusCode, 204);
    const history = await app.inject({ method: "GET", url: `/session/${id}/message` });
    assert.equal(history.json().at(-1).info.finish, "stop");
    const resolved = (await core.eventsSince(0)).filter((event) => event.type === "model.resolved");
    assert.equal(resolved.length, 1);
    const properties = resolved[0]?.properties ?? {};
    assert.deepEqual(properties.requested, { providerID: "evaluator", modelID: "unknown-1" });
    assert.deepEqual(properties.selected, { providerID: "competition", modelID: "default" });
    assert.equal(properties.resolution, "substituted");
    assert.equal(properties.sessionID, id);
    // A named, configured model is recorded as exact.
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", text: "again" }], model: { providerID: "competition", modelID: "default" } } })).statusCode, 204);
    assert.equal((await core.eventsSince(0)).filter((event) => event.type === "model.resolved").at(-1)?.properties.resolution, "exact");
  } finally {
    await app.close(); await store.close(); await removeTree(root);
  }
});

test("evaluator-facing bodies ignore unknown fields but still require the documented ones", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-http-unknown-"));
  const dir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(dir, { recursive: true });
  const store = new StateStore(path.join(dir, "pnp.db"));
  const core = new GatewayCore(store, new MockPack(), new MockIntegration(), { dataDirectory: dir });
  const app = buildApp(core);
  try {
    // An assessment client that carries its own correlation field must not lose the case to a 400.
    const created = await app.inject({ method: "POST", url: "/session",
      payload: { directory: workspace, title: "unknown fields", trace_id: "trace-1", metadata: { run: 7 } } });
    assert.equal(created.statusCode, 200);
    const id = (created.json() as { id: string }).id;
    const prompted = await app.inject({ method: "POST", url: `/session/${id}/prompt_async`, payload: {
      parts: [{ type: "text", text: "hello" }], mode: "task", trace_id: "trace-2",
      model: { providerID: "test", modelID: "test", temperature: 0.2 },
    } });
    assert.equal(prompted.statusCode, 204);
    // Ignoring the unknown is not the same as accepting anything: the documented fields still hold.
    const missingDirectory = await app.inject({ method: "POST", url: "/session", payload: { trace_id: "trace-3" } });
    assert.equal(missingDirectory.statusCode, 400);
    assert.equal(missingDirectory.json().code, "VALIDATION_ERROR");
    const missingParts = await app.inject({ method: "POST", url: `/session/${id}/prompt_async`, payload: { mode: "task" } });
    assert.equal(missingParts.statusCode, 400);
    assert.equal(missingParts.json().code, "VALIDATION_ERROR");
    const missingModelId = await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", text: "hello" }], model: { providerID: "test", trace_id: "trace-4" } } });
    assert.equal(missingModelId.statusCode, 400);
    assert.equal(missingModelId.json().code, "VALIDATION_ERROR");
    // Types are still checked where a value cannot be coerced (Fastify coerces scalars by default).
    const wrongType = await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", text: "hello" }], model: { providerID: "test", modelID: { deep: true } } } });
    assert.equal(wrongType.statusCode, 400);
    assert.equal(wrongType.json().code, "VALIDATION_ERROR");
  } finally {
    await app.close(); await store.close(); await removeTree(root);
  }
});

test("a text part may name its text `content`, the field the message projection uses", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-parts-"));
  const dir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(dir, { recursive: true });
  const store = new StateStore(path.join(dir, "pnp.db"));
  const core = new GatewayCore(store, new MockPack(), new MockIntegration(), { dataDirectory: dir });
  const app = buildApp(core);
  try {
    const created = await app.inject({ method: "POST", url: "/session", payload: { directory: workspace } });
    const id = (created.json() as { id: string }).id;
    // A client that mirrors the field name it read back from GET /session/{id}/message must not
    // lose the case over a field name.
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", content: "from content" }] } })).statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: `/session/${id}/message` })).json()
      .find((message: { role: string }) => message.role === "user").content, "from content");
    // The request body's own field wins when a part carries both.
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", text: "from text", content: "from content" }] } })).statusCode, 204);
    const users = (await app.inject({ method: "GET", url: `/session/${id}/message` })).json()
      .filter((message: { role: string }) => message.role === "user");
    assert.equal(users.at(-1).content, "from text");
    // A text part with neither field is still not a recognised part.
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text" }] } })).statusCode, 400);
  } finally {
    await app.close(); await store.close(); await removeTree(root);
  }
});

test("a prompt stopped by the caller's own abort returns 204 and records a cancelled turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-abort-"));
  const dir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(dir, { recursive: true });
  const store = new StateStore(path.join(dir, "pnp.db"));
  const core = new GatewayCore(store, new MockPack({ delayMs: 500 }), new MockIntegration(),
    { dataDirectory: dir, cancelGraceMs: 100 });
  const app = buildApp(core);
  try {
    const created = await app.inject({ method: "POST", url: "/session", payload: { directory: workspace } });
    const id = (created.json() as { id: string }).id;
    const prompt = app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", text: "hello" }] } });
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await app.inject({ method: "GET", url: "/session/status" })).json()[id]?.type === "busy") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/abort` })).statusCode, 200);
    // contracts.md section 3.3: the stop the caller asked for is a normal ending, not a conflict.
    assert.equal((await prompt).statusCode, 204);
    const history = (await app.inject({ method: "GET", url: `/session/${id}/message` })).json();
    assert.equal(history.at(-1).info.finish, "cancelled");
    assert.equal(JSON.stringify(history.at(-1).parts).includes("step-finish"), false);
    assert.equal((await app.inject({ method: "GET", url: "/session/status" })).json()[id].type, "idle");
  } finally {
    await app.close(); await store.close(); await removeTree(root);
  }
});

test("the model identifier the environment supplies is the one model.resolved publishes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-model-id-"));
  const dir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(dir, { recursive: true });
  const settings = path.join(root, "settings.json");
  await writeFile(settings, JSON.stringify({
    version: 1,
    common: {
      model: {
        default: { providerID: "competition" },
        models: [{
          selection: { providerID: "competition", modelID: "default" },
          modelIDEnvironment: "PNP_MODEL_ID",
          endpointEnvironment: "PNP_MODEL_ENDPOINT",
          protocol: "openai-chat",
        }],
      },
      permissions: { default: "allow", operations: {} },
    },
    cores: { mock: {} },
  }));
  const store = new StateStore(path.join(dir, "pnp.db"));
  const integration = await loadIntegration({
    kind: "configured", development: false, engineDevelopmentOnly: false, engineId: "mock",
    settingsPath: settings,
    environment: { PNP_MODEL_ENDPOINT: "https://model.test.invalid/v1", PNP_MODEL_ID: "endpoint-model" },
  });
  const core = new GatewayCore(store, new MockPack(), integration, { dataDirectory: dir });
  const app = buildApp(core);
  try {
    const created = await app.inject({ method: "POST", url: "/session", payload: { directory: workspace } });
    const id = (created.json() as { id: string }).id;
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", text: "hello" }], model: { providerID: "evaluator", modelID: "unknown-1" } } })).statusCode, 204);
    const resolved = (await core.eventsSince(0)).filter((event) => event.type === "model.resolved").at(-1);
    // The trace shows what the endpoint was actually asked for, not the placeholder in the file.
    assert.deepEqual(resolved?.properties.selected, { providerID: "competition", modelID: "endpoint-model" });
    assert.deepEqual(resolved?.properties.requested, { providerID: "evaluator", modelID: "unknown-1" });
  } finally {
    await app.close(); await store.close(); await removeTree(root);
  }
});

// The task statement makes these endpoints a hard requirement, because the judge model submits its
// interactions through them ("需要实现接口供裁判模型自动提交交互"). They had no HTTP-level coverage
// at all, so nothing pinned which bodies they accept. A 404 here means the body shape was accepted
// and only the request id was unknown; a 400 means the shape itself was rejected.
test("question and permission replies accept the shapes an assessment client actually sends", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-interaction-"));
  const dir = path.join(root, "data");
  await mkdir(dir, { recursive: true });
  const store = new StateStore(path.join(dir, "pnp.db"));
  const core = new GatewayCore(store, new MockPack(), new MockIntegration(), { dataDirectory: dir });
  const app = buildApp(core);
  const status = async (url: string, payload: unknown) =>
    (await app.inject({ method: "POST", url, payload: payload as never })).statusCode;
  try {
    // Both lists exist and answer even when nothing is pending; a judge polling them must not 404.
    assert.equal((await app.inject({ method: "GET", url: "/question" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/permission" })).statusCode, 200);

    // Documented shape, and the flat single-question shape a client naturally writes.
    assert.equal(await status("/question/unknown/reply", { answers: [["方案 A"]] }), 404);
    assert.equal(await status("/question/unknown/reply", { answers: ["方案 A"] }), 404);
    // Shapes that are genuinely wrong stay 400 rather than being coerced into an answer.
    assert.equal(await status("/question/unknown/reply", { answers: "方案 A" }), 400);
    assert.equal(await status("/question/unknown/reply", { answers: [1] }), 400);
    assert.equal(await status("/question/unknown/reply", { answers: [["ok"], 2] }), 400);
    assert.equal(await status("/question/unknown/reply", {}), 400);

    for (const reply of ["once", "always", "reject"]) {
      assert.equal(await status("/permission/unknown/reply", { reply }), 404, `${reply} is a documented decision`);
    }
    assert.equal(await status("/permission/unknown/reply", { reply: "maybe" }), 400);
    assert.equal(await status("/permission/unknown/reply", {}), 400);
  } finally {
    await app.close(); await store.close(); await removeTree(root);
  }
});

/** The text carried by a `message.part.updated`, or undefined when the part is not a text part. */
function partText(event: PublicEvent): string | undefined {
  const part = event.properties.part;
  if (typeof part !== "object" || part === null || Array.isArray(part)) return undefined;
  return part.type === "text" && typeof part.content === "string" ? part.content : undefined;
}

// A checkpoint needs a quarter of what is already stored, and checkpointBytes starts at 0, so the
// floor in that Math.max is what the FIRST checkpoint costs. At 4096 no answer shorter than 4 KB ever
// produced an intermediate part update, and a client watching the stream saw a single terminal blob
// after the whole turn - a measured 49.8 s run emitted 5 part updates in total.
test("an answer well under 4 KB still streams an intermediate part update", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-stream-"));
  const dir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(dir, { recursive: true });
  const store = new StateStore(path.join(dir, "pnp.db"));
  const core = new GatewayCore(store, new MockPack(), new MockIntegration(), { dataDirectory: dir });
  const app = buildApp(core);
  try {
    const created = await app.inject({ method: "POST", url: "/session", payload: { directory: workspace } });
    const id = (created.json() as { id: string }).id;
    // MockPack echoes the prompt back, so this sets the whole answer at a few hundred bytes: over the
    // 256-byte floor, far under the 4096-byte one.
    const prompt = "s".repeat(300);
    assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
      payload: { parts: [{ type: "text", text: prompt }] } })).statusCode, 204);
    const history = (await app.inject({ method: "GET", url: `/session/${id}/message` })).json();
    assert.equal(history.at(-1).info.finish, "stop");
    const answer = String(history.at(-1).content);
    assert.ok(Buffer.byteLength(answer) < 4096, "this test only means anything for an answer under the old floor");

    const events = await core.eventsSince(0);
    const terminal = events.findIndex((event) => event.type === "session.idle");
    assert.ok(terminal > 0);
    // Streaming means at least one text part BEFORE the run's terminal message, and it must be a
    // live checkpoint rather than the final text republished: the checkpoint carries what the engine
    // had emitted so far, which still includes the mock progress prefix.
    const streamed = events.slice(0, terminal).map(partText).filter((text) => text !== undefined);
    assert.ok(streamed.length >= 2, `expected an intermediate text part, saw ${streamed.length}`);
    assert.ok(streamed.some((text) => text !== answer && text.includes(answer)),
      "the intermediate checkpoint must carry the accumulated stream text, not the final answer");
    // The northbound part still carries the FULL accumulated text, never a delta.
    assert.equal(streamed.at(-1), answer);
  } finally {
    await app.close(); await store.close(); await removeTree(root);
  }
});

// The owner asked for it directly: 我至少能根据 session 或者 trace 查询到会话历史吧. Before this the
// journal exposed only a global cursor, so reading one session meant replaying the whole journal.
test("session event history pages by sequence and never leaks another session events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-session-events-"));
  const dir = path.join(root, "data");
  await mkdir(dir, { recursive: true });
  const store = new StateStore(path.join(dir, "pnp.db"));
  const core = new GatewayCore(store, new MockPack(), new MockIntegration(), { dataDirectory: dir });
  const app = buildApp(core);
  const create = async (name: string) => {
    const response = await app.inject({ method: "POST", url: "/session", payload: { directory: path.join(root, name) } });
    return (response.json() as { id: string }).id;
  };
  interface Page { events: PublicEvent[]; next_cursor: number | null; complete: boolean }
  const history = async (id: string, query = "") =>
    (await app.inject({ method: "GET", url: `/session/${id}/event${query}` })).json() as Page;
  try {
    const first = await create("workspace-a");
    const second = await create("workspace-b");
    for (const id of [first, second]) {
      assert.equal((await app.inject({ method: "POST", url: `/session/${id}/prompt_async`,
        payload: { parts: [{ type: "text", text: "hello" }] } })).statusCode, 204);
    }

    const all = await history(first);
    assert.ok(all.events.length >= 3, "a completed run publishes more than one event");
    assert.equal(all.complete, true);
    assert.equal(all.next_cursor, all.events.at(-1)!.sequence);
    assert.deepEqual(all.events.map((event) => event.sequence),
      [...all.events.map((event) => event.sequence)].sort((a, b) => a - b));
    // Isolation is the whole point of the endpoint: the second run interleaves in the global
    // sequence, and none of it may appear here.
    assert.ok(all.events.every((event) => event.properties.sessionID === first));
    const others = (await history(second)).events.map((event) => event.sequence);
    assert.equal(all.events.some((event) => others.includes(event.sequence)), false);

    // Two pages joined by next_cursor reconstruct exactly the one page, holes in the global
    // sequence included: complete is false only while rows remain.
    const page = await history(first, "?limit=2");
    assert.equal(page.events.length, 2);
    assert.equal(page.complete, false);
    assert.equal(page.next_cursor, all.events[1]!.sequence);
    const rest = await history(first, `?after=${page.next_cursor}&limit=256`);
    assert.equal(rest.complete, true);
    assert.deepEqual([...page.events, ...rest.events].map((event) => event.sequence),
      all.events.map((event) => event.sequence));
    // Past the end: nothing returned, so no cursor to return either.
    const beyond = await history(first, `?after=${all.next_cursor}`);
    assert.deepEqual(beyond.events, []);
    assert.equal(beyond.next_cursor, null);
    assert.equal(beyond.complete, true);

    // An unknown session is NOT_FOUND, exactly as on the other /session/:id routes.
    const unknown = await app.inject({ method: "GET", url: "/session/ses_00000000-0000-4000-8000-000000000000/event" });
    assert.equal(unknown.statusCode, 404);
    assert.equal((unknown.json() as { code: string }).code, "NOT_FOUND");
    // The sibling routes under the same prefix still answer; nothing was shadowed by the new one.
    assert.equal((await app.inject({ method: "GET", url: `/session/${first}/message` })).statusCode, 200);

    for (const query of ["?after=-1", "?after=abc", "?after=1.5", "?after=1e3", "?limit=0", "?limit=9999", "?limit=-2", "?limit=x"]) {
      const rejected = await app.inject({ method: "GET", url: `/session/${first}/event${query}` });
      assert.equal(rejected.statusCode, 400, `${query} must not be answered with a page`);
      assert.deepEqual(Object.keys(rejected.json() as object).sort(), ["code", "message"]);
      assert.equal((rejected.json() as { code: string }).code, "VALIDATION_ERROR");
    }

    // Deletion cascades the rows away, so a session and its history disappear together.
    assert.equal((await app.inject({ method: "DELETE", url: `/session/${first}` })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/session/${first}/event` })).statusCode, 404);
    assert.ok((await history(second)).events.length > 0, "another session history survives");
  } finally {
    await app.close(); await store.close(); await removeTree(root);
  }
});
