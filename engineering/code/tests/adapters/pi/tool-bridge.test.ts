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
  id: "office", transport: "mcp-stdio", command: "C:\\tools\\mcp.exe", args: ["serve"],
  env: { OFFICE_TOKEN: "stdio-secret" }, sideEffect: "write", timeoutMs: 9000,
};
const http: ToolBinding = {
  id: "welink", transport: "mcp-http", url: "https://mcp.example.invalid",
  headers: { Authorization: "Bearer http-secret", appid: "appid-secret" }, sideEffect: "external",
};

test("Pi projects both MCP transports and reports cli/native bindings as unsupported", () => {
  const projection = projectPiTools([stdio, cli, http, native]);
  assert.deepEqual(projection.servers, [
    { id: "office", transport: "stdio", command: "C:\\tools\\mcp.exe", args: ["serve"], envNames: { OFFICE_TOKEN: "PNP_PI_TOOLENV_1" }, sideEffect: "write", timeoutMs: 9000 },
    { id: "welink", transport: "http", url: "https://mcp.example.invalid", headerNames: { Authorization: "PNP_PI_TOOLHDR_1", appid: "PNP_PI_TOOLHDR_2" }, sideEffect: "external", timeoutMs: 30_000 },
  ]);
  assert.deepEqual(projection.env, { PNP_PI_TOOLENV_1: "stdio-secret", PNP_PI_TOOLHDR_1: "Bearer http-secret", PNP_PI_TOOLHDR_2: "appid-secret" });
  assert.deepEqual(projection.dropped.map((entry) => [entry.id, entry.transport]), [["local-cli", "cli"], ["local-native", "native"]]);
  for (const entry of projection.dropped) assert.match(entry.reason, /MCP client/);
});

test("a session with no MCP server writes no sidecar at all", async () => {
  const sessionPaths = await paths();
  const written = await writeToolBridge(sessionPaths, [cli, native]);
  assert.equal(written.bridgeFile, undefined);
  assert.deepEqual(written.env, {});
  assert.deepEqual(written.dropped.map((entry) => entry.id), ["local-cli", "local-native"]);
  await assert.rejects(access(sessionPaths.toolsFile), { code: "ENOENT" });
});

test("the sidecar holds variable names only; the resolved values exist only in the returned env", async () => {
  const sessionPaths = await paths();
  const written = await writeToolBridge(sessionPaths, [stdio, cli, http, native]);
  assert.equal(written.bridgeFile, sessionPaths.toolsFile);
  const serialized = await readFile(sessionPaths.toolsFile, "utf8");
  for (const secret of ["stdio-secret", "http-secret", "appid-secret", "cli-secret"]) {
    assert.equal(serialized.includes(secret), false, `${secret} was written to the sidecar`);
  }
  assert.equal(serialized.includes("PNP_PI_TOOLENV_1"), true);
  assert.equal(serialized.includes("PNP_PI_TOOLHDR_1"), true);
  const entries = JSON.parse(serialized) as { id: string; transport: string }[];
  assert.deepEqual(entries.map((entry) => [entry.id, entry.transport]), [["office", "stdio"], ["welink", "http"]]);
  assert.deepEqual(written.env, { PNP_PI_TOOLENV_1: "stdio-secret", PNP_PI_TOOLHDR_1: "Bearer http-secret", PNP_PI_TOOLHDR_2: "appid-secret" });
  // Windows ignores mode 0600, which is exactly why the file carries no value in the first place.
  assert.deepEqual(written.dropped.map((entry) => entry.id), ["local-cli", "local-native"]);
});

test("variable names stay unique across servers so one server cannot read another's value", () => {
  const second: ToolBinding = { ...stdio, id: "second", env: { OFFICE_TOKEN: "other-secret" } };
  const projection = projectPiTools([stdio, second]);
  const [first, other] = projection.servers as [{ envNames: Record<string, string> }, { envNames: Record<string, string> }];
  assert.notEqual(first.envNames.OFFICE_TOKEN, other.envNames.OFFICE_TOKEN);
  assert.equal(Object.keys(projection.env).length, 2);
});
