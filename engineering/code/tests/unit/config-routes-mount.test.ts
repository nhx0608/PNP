import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { ConfigService } from "../../src/config/service.ts";
import { configRoutes } from "../../src/config/routes.ts";
import { asPnpError } from "../../src/core/errors.ts";
import { removeTree } from "../kit/fs.ts";

/**
 * The seam itself, over real HTTP. The unit tests around ConfigService call the table's handlers
 * directly, which cannot catch the things that only Fastify decides: whether "*" really is the
 * wildcard parameter name, whether a query string arrives as the handler expects, whether an ETag
 * survives, and whether a thrown PnpError still becomes the gateway's {code,message} envelope once
 * a route answers with an explicit status instead of returning a body. The mount loop below is the
 * one in src/gateway/app.ts; if that loop and this one drift, this test is what says so.
 */
async function mounted(directory: string, environment: NodeJS.ProcessEnv = {}) {
  const file = path.join(directory, "settings.json");
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    // app.ts additionally translates Fastify's own error codes; these routes only ever throw
    // PnpError, so the part of the handler that matters here is the envelope.
    const safe = asPnpError(error);
    return reply.code(safe.status).send({ code: safe.code, message: safe.message });
  });
  const service = new ConfigService({
    engineId: "opencode", settingsPath: file, engineIds: ["opencode", "pi"],
    environment: { PNP_MODEL_ENDPOINT: "https://model.test/v1", ...environment },
    historyDirectory: path.join(directory, "history"),
    runningSha256: createHash("sha256").update(await readFile(file)).digest("hex"),
  });
  for (const route of configRoutes(service)) {
    const handler = async (request: { query?: unknown; params?: unknown; body?: unknown }, reply: {
      code(status: number): { headers(values: Record<string, string>): { send(body: unknown): unknown }; send(body: unknown): unknown };
    }) => {
      const answer = await route.handle({
        query: request.query as Readonly<Record<string, string | undefined>> | undefined,
        params: request.params as Readonly<Record<string, string | undefined>> | undefined,
        body: request.body,
      });
      const sending = reply.code(answer.status);
      return answer.headers === undefined ? sending.send(answer.body) : sending.headers({ ...answer.headers }).send(answer.body);
    };
    if (route.method === "GET") app.get(route.path, handler);
    else if (route.method === "POST") app.post(route.path, handler);
    else app.put(route.path, handler);
  }
  return { app, service, file };
}

function document(common: Record<string, unknown> = {}) {
  return {
    version: 1,
    common: {
      model: {
        default: { providerID: "local", modelID: "one" },
        models: [{
          selection: { providerID: "local", modelID: "one" },
          endpointEnvironment: "PNP_MODEL_ENDPOINT", protocol: "openai-chat",
        }],
      },
      permissions: { default: "allow" },
      instructions: ["instructions/house.md"],
      ...common,
    },
    cores: { opencode: {}, pi: {} },
  };
}

async function fixture(run: (context: Awaited<ReturnType<typeof mounted>>) => Promise<void>, environment?: NodeJS.ProcessEnv) {
  const directory = await mkdtemp(path.join(tmpdir(), "pnp-config-mount-"));
  try {
    await writeFile(path.join(directory, "settings.json"), `${JSON.stringify(document(), null, 2)}\n`);
    await mkdir(path.join(directory, "instructions"));
    await writeFile(path.join(directory, "instructions", "house.md"), "# House rules\n");
    const context = await mounted(directory, environment);
    try { await run(context); } finally { await context.app.close(); }
  } finally { await removeTree(directory); }
}

test("the mounted /config routes answer over HTTP", async () => fixture(async ({ app }) => {
  const read = await app.inject({ method: "GET", url: "/config?engine=pi" });
  assert.equal(read.statusCode, 200);
  const payload = read.json() as {
    running: { engine: string; sha256: string; inSync: boolean };
    provenance: unknown[]; capabilities: { engineId: string }; warnings: unknown[];
  };
  assert.equal(payload.running.inSync, true);
  assert.equal(payload.capabilities.engineId, "pi");
  assert.ok(payload.provenance.length > 0);

  const raw = await app.inject({ method: "GET", url: "/config/raw" });
  assert.equal(raw.statusCode, 200);
  assert.equal(raw.headers.etag, `"${(raw.json() as { sha256: string }).sha256}"`);

  const environment = await app.inject({ method: "GET", url: "/config/environment" });
  assert.equal(environment.statusCode, 200);
  assert.ok((environment.json() as { variables: unknown[] }).variables.length > 0);
}));

test("the wildcard tail reaches the handler, and a traversal is refused by the gateway envelope",
  async () => fixture(async ({ app }) => {
    const listed = await app.inject({ method: "GET", url: "/config/files?kind=instruction" });
    assert.deepEqual((listed.json() as { files: { path: string }[] }).files.map((entry) => entry.path), ["house.md"]);

    const read = await app.inject({ method: "GET", url: "/config/files/instruction/house.md" });
    assert.equal(read.statusCode, 200);
    const file = read.json() as { text: string; sha256: string; effect: string };
    assert.equal(file.text, "# House rules\n");
    assert.equal(file.effect, "new-sessions");

    // A literal "../.." never reaches the handler: the router normalises it out of the path and
    // nothing matches. The percent-encoded form does reach it, which is the case that matters.
    assert.equal((await app.inject({ method: "GET", url: "/config/files/instruction/../../settings.json" })).statusCode, 404);
    const escape = await app.inject({ method: "GET", url: "/config/files/instruction/..%2f..%2fsettings.json" });
    assert.equal(escape.statusCode, 403);
    assert.equal((escape.json() as { code: string }).code, "CONFIG_PATH_FORBIDDEN");

    const written = await app.inject({
      method: "PUT", url: "/config/files/instruction/house.md",
      payload: { text: "# New rules\n", ifMatch: file.sha256 },
    });
    assert.equal(written.statusCode, 200);
  }));

test("a conflict and an invalid candidate keep the fields a page needs, not just code and message",
  async () => fixture(async ({ app, file }) => {
    const before = await readFile(file);
    const conflict = await app.inject({
      method: "PUT", url: "/config", payload: { settings: document(), baseSha256: "0".repeat(64) },
    });
    assert.equal(conflict.statusCode, 409);
    const current = createHash("sha256").update(before).digest("hex");
    assert.deepEqual(conflict.json(), {
      code: "CONFIG_CONFLICT",
      message: "The settings file changed; reload it and re-apply the edit.",
      current,
    });

    const invalid = await app.inject({
      method: "PUT", url: "/config",
      payload: { settings: document({ permissions: { default: "maybe" } }), baseSha256: current },
    });
    assert.equal(invalid.statusCode, 400);
    const body = invalid.json() as { code: string; problems: { path: string }[] };
    assert.equal(body.code, "SETTINGS_INVALID");
    assert.ok(body.problems.length > 0);
    assert.deepEqual(await readFile(file), before);
  }));

test("a saved document round trips through HTTP and reports the sections it changed",
  async () => fixture(async ({ app, file }) => {
    const base = createHash("sha256").update(await readFile(file)).digest("hex");
    const next = document({ permissions: { default: "ask" } });
    const saved = await app.inject({ method: "PUT", url: "/config", payload: { settings: next, baseSha256: base } });
    assert.equal(saved.statusCode, 200);
    const body = saved.json() as { changed: { section: string }[]; running: { inSync: boolean } };
    assert.deepEqual(body.changed.map((entry) => entry.section), ["permissions"]);
    // The file moved; the process did not.
    assert.equal(body.running.inSync, false);
    assert.equal(await readFile(file, "utf8"), `${JSON.stringify(next, null, 2)}\n`);
    assert.equal((await app.inject({ method: "GET", url: "/config" })).json().running.inSync, false);
  }));

test("PNP_CONFIG_READONLY answers 403 through the mounted routes", async () => fixture(async ({ app, file }) => {
  const base = createHash("sha256").update(await readFile(file)).digest("hex");
  const refused = await app.inject({ method: "PUT", url: "/config", payload: { settings: document(), baseSha256: base } });
  assert.equal(refused.statusCode, 403);
  assert.equal((refused.json() as { code: string }).code, "CONFIG_READONLY");
  assert.equal((await app.inject({ method: "GET", url: "/config" })).json().file.readonly, true);
}, { PNP_CONFIG_READONLY: "1" }));

test("an unknown engine is 404 and an unknown /config path is the gateway's own not-found",
  async () => fixture(async ({ app }) => {
    const unknown = await app.inject({ method: "GET", url: "/config?engine=hermes" });
    assert.equal(unknown.statusCode, 404);
    assert.equal((unknown.json() as { code: string }).code, "CONFIG_UNKNOWN_ENGINE");
    assert.equal((await app.inject({ method: "GET", url: "/config/nothing-here" })).statusCode, 404);
  }));
