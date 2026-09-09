import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MINIMUM_PYTHON, PYTHON_ENTRY, describeUnavailable, resolvePython } from "../../../src/tools/pdf-mcp/python.ts";
import type { PythonInterpreter } from "../../../src/tools/pdf-mcp/python.ts";

/**
 * Talks to the real Python MCP server over stdio, with the SDK's own client — the same client the
 * gateway's engines use. Testing through the transport is the point: this is the only place in the
 * Node test suites that can prove a tool server written in another language is reachable across the
 * MCP boundary with no gateway, driver or engine-pack change at all.
 *
 * Every test that needs the interpreter SKIPS rather than fails when there is none, so CI on a
 * machine without Python stays green, and `PYTHON_SKIP_REASON` names exactly what was missing.
 */

const LAUNCHER = fileURLToPath(new URL("../../../src/tools/pdf-mcp/launch.ts", import.meta.url));
const FIXTURE_SCRIPT = fileURLToPath(new URL("../../../src/tools/pdf-mcp/tests/pdf_fixtures.py", import.meta.url));

const resolution = resolvePython();
export const PYTHON: PythonInterpreter | null = resolution.available ? resolution.interpreter : null;
export const PYTHON_SKIP_REASON: string | false = resolution.available
  ? false
  : `no usable Python ${MINIMUM_PYTHON[0]}.${MINIMUM_PYTHON[1]}+ interpreter on this host — ${describeUnavailable(resolution)}`;

export type ToolResult = {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
};

export interface Session {
  client: Client;
  stop: () => Promise<void>;
}

/** Starts `main.py` itself: the command a settings entry would name once `${PNP_PYTHON}` exists. */
export async function startPdfClient(): Promise<Session> {
  assert.ok(PYTHON !== null, "startPdfClient must not be called when Python is unavailable");
  const transport = new StdioClientTransport({
    command: PYTHON.command,
    args: [...PYTHON.prefixArgs, PYTHON_ENTRY],
    stderr: "ignore",
  });
  const client = new Client({ name: "pdf-mcp-tests", version: "0.0.0" });
  await client.connect(transport);
  return { client, stop: async (): Promise<void> => { await client.close(); } };
}

/**
 * Starts the launcher the way `config/settings.json` does, with an environment of the caller's
 * choosing. A `PNP_PYTHON` pointing at nothing is how the "no interpreter" path is exercised on a
 * machine that does have Python.
 */
export async function startLauncherClient(environment: Record<string, string>): Promise<Session> {
  const flags = process.features.typescript === false ? ["--experimental-strip-types"] : [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...flags, "--no-warnings", LAUNCHER],
    env: { ...(process.env as Record<string, string>), ...environment },
    stderr: "ignore",
  });
  const client = new Client({ name: "pdf-mcp-launcher-tests", version: "0.0.0" });
  await client.connect(transport);
  return { client, stop: async (): Promise<void> => { await client.close(); } };
}

export async function makeWorkspace(prefix: string): Promise<string> {
  // A Chinese path component, because that is what an evaluation task actually hands the model.
  const base = await mkdtemp(path.join(tmpdir(), `pnp-pdf-${prefix}-`));
  return base;
}

/**
 * Writes one of the named fixtures by running the Python builder that the standalone tests use, so
 * both suites assert against byte-identical documents instead of two hand-written PDF writers.
 */
export function writeFixture(name: "report" | "scan" | "prose", file: string): string {
  assert.ok(PYTHON !== null, "writeFixture needs Python");
  const result = spawnSync(PYTHON.command, [...PYTHON.prefixArgs, FIXTURE_SCRIPT, name, file], {
    encoding: "utf8", windowsHide: true, timeout: 60000,
  });
  assert.equal(result.status, 0, `fixture builder failed: ${result.stderr ?? ""}`);
  return file;
}

export function structured<T>(result: ToolResult): T {
  assert.equal(result.isError, undefined, `expected success, got: ${resultText(result)}`);
  assert.ok(result.structuredContent !== undefined && result.structuredContent !== null,
    `expected structuredContent, got: ${resultText(result)}`);
  return result.structuredContent as T;
}

export function resultText(result: ToolResult): string {
  if (!Array.isArray(result.content)) return JSON.stringify(result);
  return result.content
    .map((block) => (typeof block === "object" && block !== null && "text" in block
      ? String((block as { text: unknown }).text)
      : ""))
    .join("\n");
}

export function expectError(result: ToolResult, fragment: string): string {
  assert.equal(result.isError, true, `expected an error result, got: ${resultText(result)}`);
  const text = resultText(result);
  assert.ok(text.includes(fragment), `expected error to mention ${JSON.stringify(fragment)}, got: ${text}`);
  return text;
}
