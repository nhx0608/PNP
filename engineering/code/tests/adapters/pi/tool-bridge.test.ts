import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolBinding } from "../../../src/contracts/index.ts";
import { resolveSessionPaths } from "../../../src/drivers/pi-rpc/launch.ts";
import { projectPiTools, writeToolBridge } from "../../../src/drivers/pi-rpc/tool-bridge.ts";

async function paths() {
  return resolveSessionPaths(await mkdtemp(path.join(tmpdir(), "pnp-pi-tools-")));
}

const cli: ToolBinding = {
  id: "local-cli", transport: "cli", command: "C:\\tools\\read.exe", args: ["--json"],
  env: { CLI_TOKEN: "cli-secret" }, sideEffect: "read", timeoutMs: 1234,
};
const native: ToolBinding = {
  id: "local-native", transport: "native", command: "C:\\tools\\write.exe", args: [],
  env: {}, sideEffect: "write",
};
const stdio: ToolBinding = {
  id: "remote-stdio", transport: "mcp-stdio", command: "C:\\tools\\mcp.exe", args: ["serve"],
  env: { MCP_TOKEN: "stdio-secret" }, sideEffect: "external",
};
const http: ToolBinding = {
  id: "remote-http", transport: "mcp-http", url: "https://mcp.example.invalid",
  headers: { Authorization: "Bearer http-secret" }, sideEffect: "external",
};

test("Pi projects cli/native commands and reports both MCP transports as unsupported", () => {
  const projection = projectPiTools([stdio, cli, http, native]);
  assert.deepEqual(projection.supported.map((tool) => [tool.id, tool.transport]), [
    ["local-cli", "cli"], ["local-native", "native"],
  ]);
  assert.deepEqual(projection.dropped, [
    { id: "remote-stdio", transport: "mcp-stdio", reason: "pi native extensions are not an MCP client" },
    { id: "remote-http", transport: "mcp-http", reason: "pi native extensions are not an MCP client" },
  ]);
});

test("an HTTP-only tool set needs no bridge and serializes no credentials", async () => {
  const sessionPaths = await paths();
  assert.equal(await writeToolBridge(sessionPaths, [http]), undefined);
  await assert.rejects(access(sessionPaths.toolsFile), { code: "ENOENT" });
  await assert.rejects(access(sessionPaths.extensionFile), { code: "ENOENT" });
});

test("a mixed tool set serializes only cli/native bindings, never MCP bindings", async () => {
  const sessionPaths = await paths();
  assert.equal(await writeToolBridge(sessionPaths, [stdio, cli, http, native]), sessionPaths.extensionFile);
  const serialized = await readFile(sessionPaths.toolsFile, "utf8");
  const entries = JSON.parse(serialized) as { id: string; transport?: string }[];
  assert.deepEqual(entries.map((entry) => entry.id), ["local-cli", "local-native"]);
  assert.equal(serialized.includes("remote-stdio"), false);
  assert.equal(serialized.includes("stdio-secret"), false);
  assert.equal(serialized.includes("remote-http"), false);
  assert.equal(serialized.includes("http-secret"), false);
  assert.equal(entries.some((entry) => "transport" in entry), false);
});
