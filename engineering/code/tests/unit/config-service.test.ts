import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigService } from "../../src/config/service.ts";
import { configRoutes } from "../../src/config/routes.ts";
import { changedSections, combinedEffect } from "../../src/config/effects.ts";
import type { ConfigRequest, ConfigResponse } from "../../src/config/routes.ts";
import { PnpError } from "../../src/core/errors.ts";
import { removeTree } from "../kit/fs.ts";

/** A value that must never be echoed by any route, planted in the environment the service reads. */
const SECRET = "sk-not-a-real-key-0123456789";
const ENGINES = ["opencode", "pi"] as const;

function document(overrides: { common?: Record<string, unknown>; cores?: Record<string, unknown> } = {}) {
  return {
    version: 1,
    common: {
      model: {
        default: { providerID: "local", modelID: "one" },
        models: [{
          selection: { providerID: "local", modelID: "one" },
          endpointEnvironment: "PNP_MODEL_ENDPOINT",
          apiKeyEnvironment: "PNP_MODEL_API_KEY",
          protocol: "openai-chat",
        }],
      },
      permissions: { default: "allow", operations: { external: "ask" } },
      instructions: ["instructions/house.md"],
      ...overrides.common,
    },
    cores: {
      opencode: { permissions: { operations: { external: "deny" } } },
      pi: {},
      ...overrides.cores,
    },
  };
}

interface Fixture {
  directory: string;
  file: string;
  service: ConfigService;
  call(method: string, route: string, request?: ConfigRequest): Promise<ConfigResponse>;
  digest(): Promise<string>;
}

async function fixture(
  run: (context: Fixture) => Promise<void>,
  options: { settings?: unknown; environment?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "pnp-config-service-"));
  try {
    const file = path.join(directory, "settings.json");
    await writeFile(file, `${JSON.stringify(options.settings ?? document(), null, 2)}\n`);
    await mkdir(path.join(directory, "instructions"));
    await writeFile(path.join(directory, "instructions", "house.md"), "# House rules\n");
    await mkdir(path.join(directory, "skills", "writing"), { recursive: true });
    await writeFile(path.join(directory, "skills", "writing", "SKILL.md"),
      "---\nname: writing\ndescription: Write useful text\n---\nContent\n");
    const environment: NodeJS.ProcessEnv = {
      PNP_MODEL_ENDPOINT: "https://model.test/v1", PNP_MODEL_API_KEY: SECRET, ...options.environment,
    };
    const service = new ConfigService({
      engineId: "opencode", settingsPath: file, engineIds: [...ENGINES], environment,
      historyDirectory: path.join(directory, "history"),
    });
    const routes = configRoutes(service);
    await run({
      directory, file, service,
      call: async (method, routePath, request = {}) => {
        const route = routes.find((entry) => entry.method === method && entry.path === routePath);
        assert.ok(route !== undefined, `no route ${method} ${routePath}`);
        return route.handle(request);
      },
      digest: async () => createHash("sha256").update(await readFile(file)).digest("hex"),
    });
  } finally { await removeTree(directory); }
}

async function rejects(run: () => Promise<unknown>, code: string): Promise<PnpError> {
  let failure: unknown;
  try { await run(); }
  catch (error) { failure = error; }
  assert.ok(failure instanceof PnpError, `expected ${code}, got ${String(failure)}`);
  assert.equal(failure.code, code);
  return failure;
}

test("GET /config labels every effective value with the layer that produced it", async () => fixture(async ({ call }) => {
  const response = await call("GET", "/config", { query: { engine: "opencode" } });
  assert.equal(response.status, 200);
  const payload = response.body as {
    effective: { permissions: { operations: Record<string, unknown> } };
    provenance: { path: string; layer: string; source: string; variable?: string; set?: boolean }[];
    running: { engine: string; inSync: boolean };
    file: { sha256: string; readonly: boolean };
  };
  assert.equal(payload.effective.permissions.operations.external, "deny");
  const at = (needle: string) => payload.provenance.find((entry) => entry.path === needle);
  assert.deepEqual(
    { layer: at("permissions.operations.external")?.layer, source: at("permissions.operations.external")?.source },
    { layer: "core", source: "cores.opencode.permissions.operations.external" },
  );
  assert.equal(at("permissions.default")?.layer, "common");
  assert.equal(at("model.default.providerID")?.source, "common.model.default");
  // The third kind of origin: a name, its set flag, and nothing else.
  const key = payload.provenance.find((entry) => entry.variable === "PNP_MODEL_API_KEY");
  assert.deepEqual({ layer: key?.layer, set: key?.set }, { layer: "environment", set: true });
  assert.equal(payload.running.inSync, true);
  assert.equal(payload.file.readonly, false);
}));

test("no route echoes an environment value, and /config/environment answers with names only",
  async () => fixture(async ({ call }) => {
    const responses = [
      await call("GET", "/config"),
      await call("GET", "/config/raw"),
      await call("GET", "/config/environment"),
      await call("POST", "/config/validate", { body: { settings: document() } }),
    ];
    for (const response of responses) assert.equal(JSON.stringify(response.body).includes(SECRET), false);
    const environment = (await call("GET", "/config/environment")).body as {
      variables: { variable: string; set: boolean; kind: string; paths: string[] }[]; howToSet: string;
    };
    assert.deepEqual(environment.variables.find((entry) => entry.variable === "PNP_MODEL_API_KEY"), {
      variable: "PNP_MODEL_API_KEY", set: true, kind: "model",
      paths: ["common.model.models.0.apiKeyEnvironment"],
    });
    assert.equal(environment.variables.find((entry) => entry.variable === "PNP_QUESTION_POLICY")?.set, false);
    assert.match(environment.howToSet, /pnp\.cmd config|local\.env/);
  }));

test("the configuration API cannot be pointed at an environment file", async () => fixture(async ({ call, directory }) => {
  await writeFile(path.join(directory, "local.env"), `PNP_MODEL_API_KEY=${SECRET}\n`);
  await rejects(() => call("GET", "/config/files/instruction/*", { params: { "*": "../local.env" } }), "CONFIG_PATH_FORBIDDEN");
  await rejects(() => call("GET", "/config/files/instruction/*", { params: { "*": "../local.env.md" } }), "CONFIG_PATH_FORBIDDEN");
  await rejects(() => call("GET", "/config/files/instruction/*", { params: { "*": "absent.md" } }), "NOT_FOUND");
  await rejects(() => call("GET", "/config/files/instruction/*", { params: { "*": "/etc/passwd" } }), "CONFIG_PATH_FORBIDDEN");
  // A Markdown name that resolves onto the environment file is refused by identity, not by name.
  // A hard link is the form of aliasing an unprivileged process can actually create on Windows.
  await link(path.join(directory, "local.env"), path.join(directory, "instructions", "sneaky.md"));
  const failure = await rejects(
    () => call("GET", "/config/files/instruction/*", { params: { "*": "sneaky.md" } }), "CONFIG_PATH_FORBIDDEN");
  assert.equal(failure.message.includes(SECRET), false);
}));

test("credential-shaped fields are refused at the HTTP boundary, opaque domains are not",
  async () => fixture(async ({ service }) => {
    const unsafe = [
      { mcp: { servers: { one: { transport: "stdio", command: "/bin/one", args: [`--api-key=${SECRET}`] } } } },
      {
        model: {
          default: { providerID: "local", modelID: "one" },
          models: [{
            selection: { providerID: "local", modelID: "one" }, protocol: "openai-chat",
            endpoint: `https://model.test/v1?token=${SECRET}`,
          }],
        },
      },
      { native: { engine: { apiKey: SECRET } } },
    ];
    for (const common of unsafe) {
      await rejects(() => service.validate(document({ common }), ["opencode"]), "CONFIG_HTTP_UNSAFE_FIELD");
    }
    // The open domains carry engine-private JSON; refusing them wholesale would close the very
    // extension point they exist for, so they are scanned by the same field-name rule instead.
    const result = await service.validate(document({
      common: {
        native: { compaction: { reserveTokens: 8192 } },
        assets: { memory: { notes: { path: "instructions/house.md", parameters: { keep: 3 } } } },
      },
    }), ["opencode"]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.effective.opencode?.native.compaction, { reserveTokens: 8192 });
  }));

test("POST /config/validate reports problems by path and never touches the file",
  async () => fixture(async ({ call, digest }) => {
    const before = await digest();
    const response = await call("POST", "/config/validate", {
      body: {
        settings: document({ common: { permissions: { default: "maybe" } }, cores: { pi: { typo: true } } }),
        engines: [...ENGINES],
      },
    });
    const payload = response.body as { ok: boolean; problems: { path: string; severity: string }[] };
    assert.equal(payload.ok, false);
    assert.ok(payload.problems.some((problem) => problem.severity === "error"));
    assert.ok(payload.problems.every((problem) => typeof problem.path === "string" && problem.path.length > 0));
    assert.equal(await digest(), before);
  }));

test("PUT /config refuses a stale base digest and leaves the file byte-identical",
  async () => fixture(async ({ call, file, digest }) => {
    const before = await readFile(file);
    const response = await call("PUT", "/config", { body: { settings: document(), baseSha256: "0".repeat(64) } });
    assert.equal(response.status, 409);
    const payload = response.body as { code: string; current: string };
    assert.equal(payload.code, "CONFIG_CONFLICT");
    assert.equal(payload.current, await digest());
    assert.deepEqual(await readFile(file), before);
  }));

test("PUT /config validates, backs up, then replaces the file atomically",
  async () => fixture(async ({ call, file, digest, directory }) => {
    const base = await digest();
    const next = document({ common: { permissions: { default: "ask", operations: { external: "ask" } } } });
    const response = await call("PUT", "/config", { body: { settings: next, baseSha256: base, label: "tightened" } });
    assert.equal(response.status, 200);
    const payload = response.body as { sha256: string; backup: string; effect: string; running: { inSync: boolean } };
    assert.equal(await readFile(file, "utf8"), `${JSON.stringify(next, null, 2)}\n`);
    assert.equal(payload.sha256, await digest());
    assert.equal(payload.effect, "restart");
    // The running gateway still holds the old document, and the answer says so rather than
    // implying the edit already took effect.
    assert.equal(payload.running.inSync, false);
    assert.equal(await readFile(payload.backup, "utf8"), `${JSON.stringify(document(), null, 2)}\n`);
    assert.match(path.basename(payload.backup), /^settings-.*-tightened\.json$/);
    assert.deepEqual(await readdir(path.join(directory, "history")), [path.basename(payload.backup)]);
    // No temporary file survives a successful replacement.
    assert.deepEqual((await readdir(directory)).filter((name) => name.includes("tmp")), []);
  }));

test("an invalid candidate is refused with its problems and never reaches the file",
  async () => fixture(async ({ call, file, digest }) => {
    const before = await readFile(file);
    const response = await call("PUT", "/config", {
      body: { settings: document({ common: { permissions: { default: "maybe" } } }), baseSha256: await digest() },
    });
    assert.equal(response.status, 400);
    const payload = response.body as { code: string; problems: unknown[] };
    assert.equal(payload.code, "SETTINGS_INVALID");
    assert.ok(payload.problems.length > 0);
    assert.deepEqual(await readFile(file), before);
  }));

test("instruction files round trip under their digest and stay inside the approved root",
  async () => fixture(async ({ call, directory }) => {
    const rules = path.join(directory, "instructions", "house.md");
    const listing = (await call("GET", "/config/files", { query: { kind: "instruction" } })).body as {
      files: { path: string; sha256: string }[];
    };
    assert.deepEqual(listing.files.map((entry) => entry.path), ["house.md"]);
    const read = (await call("GET", "/config/files/instruction/*", { params: { "*": "house.md" } })).body as {
      text: string; sha256: string; effect: string;
    };
    assert.equal(read.text, "# House rules\n");
    assert.equal(read.sha256, listing.files[0]?.sha256);
    const stale = await call("PUT", "/config/files/instruction/*", {
      params: { "*": "house.md" }, body: { text: "changed", ifMatch: "0".repeat(64) },
    });
    assert.equal(stale.status, 409);
    assert.equal(await readFile(rules, "utf8"), "# House rules\n");
    const written = await call("PUT", "/config/files/instruction/*", {
      params: { "*": "house.md" }, body: { text: "# New rules\n", ifMatch: read.sha256 },
    });
    assert.equal(written.status, 200);
    assert.equal(await readFile(rules, "utf8"), "# New rules\n");
    await rejects(() => call("PUT", "/config/files/instruction/*", {
      params: { "*": "../settings.json" }, body: { text: "{}", ifMatch: "*" },
    }), "CONFIG_PATH_FORBIDDEN");
    await rejects(() => call("PUT", "/config/files/instruction/*", {
      params: { "*": "house.md" }, body: { text: "x".repeat(1024 * 1024 + 1), ifMatch: "*" },
    }), "CONFIG_FILE_TOO_LARGE");
  }));

test("PNP_CONFIG_READONLY closes every writing route and is visible on the read side", async () => fixture(
  async ({ call, service, digest }) => {
    assert.equal(service.readonly, true);
    assert.equal(((await call("GET", "/config")).body as { file: { readonly: boolean } }).file.readonly, true);
    const base = await digest();
    await rejects(() => call("PUT", "/config", { body: { settings: document(), baseSha256: base } }), "CONFIG_READONLY");
    await rejects(() => call("PUT", "/config/files/instruction/*", {
      params: { "*": "house.md" }, body: { text: "x", ifMatch: "*" },
    }), "CONFIG_READONLY");
    assert.deepEqual(configRoutes(service).filter((route) => route.write).map((route) => route.path),
      ["/config", "/config/files/instruction/*"]);
  }, { environment: { PNP_CONFIG_READONLY: "1" } }));

test("an unregistered engine is a 404 rather than an empty answer", async () => fixture(async ({ call, service }) => {
  await rejects(() => call("GET", "/config", { query: { engine: "hermes" } }), "CONFIG_UNKNOWN_ENGINE");
  await rejects(() => service.validate(document(), ["hermes"]), "CONFIG_UNKNOWN_ENGINE");
}));

/** A document that configures capability domains this delivery parses but cannot yet project. */
function withDomains() {
  return document({
    common: {
      skills: { writing: { path: "skills/writing" } },
      assets: { memory: { glossary: { path: "instructions/house.md" } } },
      native: { compaction: { reserveTokens: 8192 } },
    },
  });
}

test("GET /config says which configured domains the selected engine cannot currently carry",
  async () => fixture(async ({ call }) => {
    const payload = (await call("GET", "/config")).body as {
      capabilities: {
        engineId: string; applicable: boolean; nativeOptionsPending: boolean;
        skipped: { kind: string; id: string; reason: string }[];
        required: { kind: string; id: string }[];
      };
      effective: { skills: unknown[]; native: Record<string, unknown> };
    };
    // The settings parsed and merged - accepting them is real, and so is not applying them.
    assert.equal(payload.effective.skills.length, 1);
    assert.equal(payload.capabilities.engineId, "opencode");
    assert.equal(payload.capabilities.applicable, false);
    assert.equal(payload.capabilities.nativeOptionsPending, true);
    assert.deepEqual(payload.capabilities.required, []);
    assert.deepEqual(
      payload.capabilities.skipped.map((entry) => `${entry.kind}:${entry.id}:${entry.reason}`).sort(),
      ["memory:glossary:projection-unavailable", "skill:writing:projection-unavailable"],
    );
  }, { settings: withDomains() }));

test("POST /config/validate reports the same capability gap per engine before anything is saved",
  async () => fixture(async ({ call, digest }) => {
    const before = await digest();
    const payload = (await call("POST", "/config/validate", {
      body: { settings: withDomains(), engines: [...ENGINES] },
    })).body as {
      ok: boolean; capabilities: Record<string, { engineId: string; applicable: boolean; skipped: unknown[] }>;
    };
    assert.equal(payload.ok, true);
    assert.deepEqual(Object.keys(payload.capabilities).sort(), ["opencode", "pi"]);
    for (const engineId of ENGINES) {
      assert.equal(payload.capabilities[engineId]?.engineId, engineId);
      assert.equal(payload.capabilities[engineId]?.applicable, false);
      assert.equal(payload.capabilities[engineId]?.skipped.length, 2);
    }
    assert.equal(await digest(), before);
  }));

test("a saved settings change reports the sections it touched and that a restart is what applies them",
  async () => fixture(async ({ call, digest }) => {
    const next = document({
      common: { permissions: { default: "ask", operations: { external: "ask" } } },
      cores: { pi: { mcp: { servers: { extra: { transport: "stdio", command: "/bin/extra", args: [] } } } } },
    });
    const payload = (await call("PUT", "/config", { body: { settings: next, baseSha256: await digest() } })).body as {
      effect: string; changed: { section: string; effect: string; residents: string; note: string }[];
    };
    // One change in common, one in a Core section: both are named, by key, once.
    assert.deepEqual(payload.changed.map((entry) => entry.section).sort(), ["mcp", "permissions"]);
    assert.equal(payload.effect, "restart");
    for (const entry of payload.changed) {
      assert.equal(entry.effect, "restart");
      assert.equal(entry.residents, "unaffected");
      assert.match(entry.note, /restart/i);
    }
  }));

test("editing a listed instruction file reaches new sessions, and fences the ones already open",
  async () => fixture(async ({ call }) => {
    const read = (await call("GET", "/config/files/instruction/*", { params: { "*": "house.md" } })).body as {
      sha256: string; effect: string; residents: string;
    };
    assert.equal(read.effect, "new-sessions");
    const written = (await call("PUT", "/config/files/instruction/*", {
      params: { "*": "house.md" }, body: { text: "# New rules\n", ifMatch: read.sha256 },
    })).body as { effect: string; residents: string; note: string };
    assert.equal(written.effect, "new-sessions");
    assert.equal(written.residents, "engine-dependent");
    assert.match(written.note, /ENGINE_BINDINGS_CHANGED/);
    // The claim above is the whole point: a resident session must not be hot-patched.
    assert.match(written.note, /native configuration is rewritten in place/);
  }));

test("changing the instruction list is a restart, not the per-turn file re-read", async () => {
  const before = { version: 1, common: { instructions: ["instructions/house.md"] }, cores: {} };
  const after = { version: 1, common: { instructions: [] }, cores: {} };
  const changed = changedSections(before, after);
  assert.deepEqual(changed.map((entry) => entry.section), ["instructions"]);
  assert.equal(changed[0]?.effect, "restart");
  assert.equal(combinedEffect(changed), "restart");
  assert.deepEqual(changedSections(before, before), []);
});

test("the /config family is a pure addition: every path is new and none is registered twice",
  async () => fixture(async ({ service }) => {
    const routes = configRoutes(service);
    for (const route of routes) {
      assert.ok(route.path === "/config" || route.path.startsWith("/config/"), route.path);
      assert.ok(route.summary.length > 0, route.path);
    }
    const seen = routes.map((route) => `${route.method} ${route.path}`);
    assert.equal(new Set(seen).size, seen.length);
    // None of the gateway's existing routes lives under /config, so nothing here reshapes one.
    const app = await readFile(path.join(process.cwd(), "src", "gateway", "app.ts"), "utf8");
    const registrations = [...app.matchAll(/\bapp\.(get|post|put|delete)\b/g)];
    assert.ok(registrations.length >= 16, `expected the shipped routes, found ${registrations.length}`);
    // Literal paths only; the session lifecycle ones are registered from a loop over a suffix.
    const existing = [...app.matchAll(/\bapp\.(?:get|post|put|delete)<?[^(]*\(\s*"([^"]+)"/g)]
      .map((match) => match[1]!);
    assert.deepEqual(existing.filter((route) => route.startsWith("/config")), []);
  }));
