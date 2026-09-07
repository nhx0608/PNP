import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPnpSettings } from "../../src/config/settings.ts";
import { loadIntegration } from "../../src/integration/index.ts";
import type { Session, ToolBinding } from "../../src/contracts/index.ts";
import { PnpError } from "../../src/core/errors.ts";
import { removeTree } from "../kit/fs.ts";

const model = {
  selection: { providerID: "shared", modelID: "m1" },
  endpoint: "http://127.0.0.1:9001/v1",
  protocol: "openai-chat",
  headerEnvironment: {},
};
const session: Session = {
  id: "test", title: "", directory: tmpdir(), engineId: "opencode", channelId: "acp",
  lifecycle: "active", status: "idle", recovery: "ready", createdAt: "", updatedAt: "",
};
/** An absolute command on both targets: `path.win32.isAbsolute` accepts a rooted path too. */
const COMMAND = "/opt/pnp/welink-mcp";

async function settingsFile(value: unknown): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-mcp-settings-"));
  const file = path.join(dir, "settings.json");
  await writeFile(file, JSON.stringify(value));
  return { dir, file };
}
function withServers(servers: unknown, cores: unknown = {}): unknown {
  return {
    version: 1,
    common: {
      model: { default: model.selection, models: [model] },
      permissions: { default: "allow", operations: {} },
      mcp: { servers },
    },
    cores,
  };
}
/** The tool bindings one prepared run actually receives, which is the only thing a driver ever sees. */
async function preparedTools(input: {
  settingsPath?: string;
  configuredProfile?: string;
  environment: NodeJS.ProcessEnv;
}): Promise<readonly ToolBinding[]> {
  const provider = await loadIntegration({
    kind: "configured", development: false, engineDevelopmentOnly: false, engineId: "opencode",
    ...(input.settingsPath === undefined ? {} : { settingsPath: input.settingsPath }),
    ...(input.configuredProfile === undefined ? {} : { configuredProfile: input.configuredProfile }),
    environment: input.environment,
  });
  const context = await provider.prepare({
    session,
    request: { parts: [{ type: "text", text: "test" }], model: { providerID: "", modelID: "" } },
    signal: new AbortController().signal,
  });
  return context.tools;
}

test("MCP settings inherit common servers and allow partial Core overrides by server id", async () => {
  const { dir, file } = await settingsFile({
    version: 1,
    common: {
      model: { default: model.selection, models: [model] },
      permissions: { default: "allow", operations: {} },
      mcp: {
        servers: {
          welink: {
            transport: "stdio",
            command: "welink-mcp",
            args: ["serve"],
            env: { WELINK_HOME: "PNP_WELINK_HOME" },
            enabled: true,
            timeoutMs: 5000,
          },
          knowledge: {
            transport: "streamable-http",
            urlEnvironment: "PNP_KNOWLEDGE_MCP_URL",
            headerEnvironment: { Authorization: "PNP_KNOWLEDGE_MCP_AUTH" },
            enabled: true,
          },
        },
      },
    },
    cores: {
      opencode: {
        mcp: {
          servers: {
            welink: { timeoutMs: 12000, env: { WELINK_LOG_LEVEL: "PNP_WELINK_LOG_LEVEL" } },
            knowledge: { enabled: false },
          },
        },
      },
      pi: {},
    },
  });
  try {
    const opencode = await loadPnpSettings({ engineId: "opencode", settingsPath: file });
    assert.deepEqual(opencode.mcp.servers, [
      {
        id: "welink",
        transport: "stdio",
        command: "welink-mcp",
        args: ["serve"],
        env: { WELINK_HOME: "PNP_WELINK_HOME", WELINK_LOG_LEVEL: "PNP_WELINK_LOG_LEVEL" },
        enabled: true,
        sideEffect: "external",
        timeoutMs: 12000,
      },
      {
        id: "knowledge",
        transport: "streamable-http",
        urlEnvironment: "PNP_KNOWLEDGE_MCP_URL",
        headerEnvironment: { Authorization: "PNP_KNOWLEDGE_MCP_AUTH" },
        enabled: false,
        sideEffect: "external",
      },
    ]);

    const pi = await loadPnpSettings({ engineId: "pi", settingsPath: file });
    assert.equal(pi.mcp.servers.find((server) => server.id === "welink")?.enabled, true);
    assert.equal(pi.mcp.servers.find((server) => server.id === "welink")?.timeoutMs, 5000);
    assert.equal(pi.mcp.servers.find((server) => server.id === "knowledge")?.enabled, true);
  } finally { await removeTree(dir); }
});

test("a Core may add its own MCP server and invalid transport-specific fields fail closed", async () => {
  const { dir, file } = await settingsFile({
    version: 1,
    common: {
      model: { default: model.selection, models: [model] },
      permissions: { default: "allow", operations: {} },
      mcp: { servers: {} },
    },
    cores: {
      opencode: {
        mcp: {
          servers: {
            localOnly: { transport: "stdio", command: "local-mcp", enabled: true },
          },
        },
      },
    },
  });
  try {
    const effective = await loadPnpSettings({ engineId: "opencode", settingsPath: file });
    assert.deepEqual(effective.mcp.servers, [{
      id: "localOnly", transport: "stdio", command: "local-mcp", args: [], env: {}, enabled: true,
      sideEffect: "external",
    }]);
  } finally { await removeTree(dir); }

  const invalid = await settingsFile({
    version: 1,
    common: {
      model: { default: model.selection, models: [model] },
      permissions: { default: "allow", operations: {} },
      mcp: { servers: { bad: { transport: "stdio", command: "bad", url: "https://example.com/mcp" } } },
    },
    cores: {},
  });
  try {
    await assert.rejects(loadPnpSettings({ engineId: "opencode", settingsPath: invalid.file }), { code: "SETTINGS_INVALID" });
  } finally { await removeTree(invalid.dir); }
});

test("the enabled MCP servers become the run's tool bindings with their environment resolved", async () => {
  const { dir, file } = await settingsFile(withServers({
    welink: {
      transport: "stdio",
      command: COMMAND,
      args: ["serve"],
      env: { WELINK_HOME: "PNP_WELINK_HOME" },
      timeoutMs: 5000,
    },
    notes: { transport: "stdio", command: "/opt/pnp/notes-mcp", sideEffect: "read" },
    archive: { transport: "stdio", command: "/opt/pnp/archive-mcp", enabled: false },
  }));
  try {
    const tools = await preparedTools({ settingsPath: file, environment: { PNP_WELINK_HOME: "D:\\pnp\\welink" } });
    // The disabled server is absent rather than reported: it was turned off on purpose. The values are the
    // ones the environment held, and a server that never said what it does is "external".
    assert.deepEqual(tools, [
      {
        id: "welink", transport: "mcp-stdio", command: COMMAND, args: ["serve"],
        env: { WELINK_HOME: "D:\\pnp\\welink" }, sideEffect: "external", timeoutMs: 5000,
      },
      { id: "notes", transport: "mcp-stdio", command: "/opt/pnp/notes-mcp", args: [], env: {}, sideEffect: "read" },
    ]);
  } finally { await removeTree(dir); }
});

test("a Core override that disables a common MCP server removes it from the bindings", async () => {
  const { dir, file } = await settingsFile(withServers(
    {
      welink: { transport: "stdio", command: COMMAND },
      notes: { transport: "stdio", command: "/opt/pnp/notes-mcp" },
    },
    { opencode: { mcp: { servers: { welink: { enabled: false } } } } },
  ));
  try {
    const tools = await preparedTools({ settingsPath: file, environment: {} });
    assert.deepEqual(tools.map((entry) => entry.id), ["notes"]);
  } finally { await removeTree(dir); }
});

test("an MCP server whose environment variable is unset fails the load instead of running without it", async () => {
  const { dir, file } = await settingsFile(withServers({
    welink: { transport: "stdio", command: COMMAND, env: { WELINK_HOME: "PNP_WELINK_HOME" } },
  }));
  try {
    // 503, not 400: the settings are valid, the deployment is incomplete.
    await assert.rejects(preparedTools({ settingsPath: file, environment: {} }),
      { code: "INTEGRATION_CONFIG_INVALID", status: 503 });
  } finally { await removeTree(dir); }
});

test("an MCP command that is not an absolute path is refused, never looked up on PATH", async () => {
  const { dir, file } = await settingsFile(withServers({
    welink: { transport: "stdio", command: "welink-mcp" },
  }));
  try {
    await assert.rejects(preparedTools({ settingsPath: file, environment: {} }),
      { code: "INTEGRATION_CONFIG_INVALID", status: 400 });
  } finally { await removeTree(dir); }
});

test("a remote MCP server resolves its url and headers, and an unapproved address never reaches a driver", async () => {
  const { dir, file } = await settingsFile(withServers({
    knowledge: {
      transport: "streamable-http",
      urlEnvironment: "PNP_KNOWLEDGE_MCP_URL",
      headerEnvironment: { Authorization: "PNP_KNOWLEDGE_MCP_AUTH" },
      sideEffect: "read",
    },
  }));
  try {
    const tools = await preparedTools({
      settingsPath: file,
      environment: {
        PNP_KNOWLEDGE_MCP_URL: "https://knowledge.example/mcp",
        PNP_KNOWLEDGE_MCP_AUTH: "Bearer test-only",
      },
    });
    assert.deepEqual(tools, [{
      id: "knowledge", transport: "mcp-http", url: "https://knowledge.example/mcp",
      headers: { Authorization: "Bearer test-only" }, sideEffect: "read",
    }]);
    // The variable's value is checked when it resolves, because a settings file cannot know what it will hold.
    await assert.rejects(
      preparedTools({
        settingsPath: file,
        environment: {
          PNP_KNOWLEDGE_MCP_URL: "http://knowledge.example/mcp",
          PNP_KNOWLEDGE_MCP_AUTH: "Bearer test-only",
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof PnpError);
        assert.equal(error.code, "INTEGRATION_CONFIG_INVALID");
        assert.equal(error.status, 400);
        // The address is a deployment fact; the message names the setting instead of quoting it.
        assert.ok(!error.message.includes("knowledge.example"));
        return true;
      });
  } finally { await removeTree(dir); }
});

test("an explicit legacy profile with no explicit settings still supplies its own tools", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-mcp-legacy-"));
  try {
    const profile = path.join(dir, "profile.json");
    await writeFile(profile, JSON.stringify({
      models: [{
        selection: { providerID: "legacy", modelID: "legacy" }, endpoint: "http://127.0.0.1:9999/v1",
        protocol: "openai-chat", headerEnvironment: {},
      }],
      tools: [{
        id: "legacy-tool", transport: "cli", command: "/opt/pnp/legacy.exe", args: [], env: {}, sideEffect: "write",
      }],
      policy: { default: "allow", operations: {} },
    }));
    // A deployment that names its own profile and no settings file is the one case that still reads the
    // profile's tools; nothing here consults settings.json at all.
    const tools = await preparedTools({ configuredProfile: profile, environment: {} });
    assert.deepEqual(tools, [{
      id: "legacy-tool", transport: "cli", command: "/opt/pnp/legacy.exe", args: [], env: {}, sideEffect: "write",
    }]);
  } finally { await removeTree(dir); }
});
