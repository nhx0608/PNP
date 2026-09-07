import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPnpSettings } from "../../src/config/settings.ts";
import { removeTree } from "../kit/fs.ts";

const model = {
  selection: { providerID: "shared", modelID: "m1" },
  endpoint: "http://127.0.0.1:9001/v1",
  protocol: "openai-chat",
  headerEnvironment: {},
};

async function settingsFile(value: unknown): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-mcp-settings-"));
  const file = path.join(dir, "settings.json");
  await writeFile(file, JSON.stringify(value));
  return { dir, file };
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
        timeoutMs: 12000,
      },
      {
        id: "knowledge",
        transport: "streamable-http",
        urlEnvironment: "PNP_KNOWLEDGE_MCP_URL",
        headerEnvironment: { Authorization: "PNP_KNOWLEDGE_MCP_AUTH" },
        enabled: false,
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
