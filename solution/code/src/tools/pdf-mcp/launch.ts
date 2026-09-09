import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  CODE_ROOT, MINIMUM_PYTHON, PYTHON_ENTRY, PYTHON_VARIABLE, describeUnavailable, resolvePython,
} from "./python.ts";

/**
 * Starts the Python PDF MCP server: `node dist/tools/pdf-mcp/launch.js`, spawned by the gateway over
 * stdio like the two Node servers.
 *
 * ## Why a Node file starts a Python server
 *
 * The MCP boundary really does take an arbitrary command — `config/settings.json` declares
 * `command` + `args` and the gateway spawns it, which is why a tool server can be written in any
 * language and reach both engines unchanged. Two rules in the *existing* code stop this entry from
 * naming `python` directly, and neither is this package's to change:
 *
 *   1. `expandPlaceholders` in `src/config/settings.ts` knows exactly two placeholders,
 *      `${PNP_CODE_ROOT}` and `${PNP_NODE}`. An unknown one is a `SETTINGS_INVALID` failure of the
 *      whole settings load, which would take the Node tool servers down with it.
 *   2. `mcpToolBindings` in `src/integration/index.ts` requires `command` to be an absolute path,
 *      never a PATH lookup — and no absolute path to Python is knowable when the settings file is
 *      written.
 *
 * So the settings entry names `${PNP_NODE}` and this file, whose entire job is to find an
 * interpreter and get out of the way: it `spawn`s Python with `stdio: "inherit"`, so the Python
 * process inherits the gateway's own pipes and owns the JSON-RPC stream end to end. No frame is
 * parsed, copied or re-serialised here. `src/tools/pdf-mcp/README.md` specifies the one-line change
 * to `src/config/settings.ts` that retires this file in favour of `"command": "${PNP_PYTHON}"`.
 *
 * ## When there is no Python
 *
 * The server is optional, so a missing interpreter is a reported fact and not a failure: this
 * process stays up and answers MCP itself, publishing a single `server_info` tool that states what
 * was looked for, what was found, and the variable to set. An engine sees a healthy server with an
 * honest catalogue instead of a spawn error, and the Node office and desktop servers are untouched.
 */

const SERVER_NAME = "pdf";
const SERVER_VERSION = "0.1.0";

async function unavailableServer(reason: string, detail: string): Promise<void> {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, {
    instructions: "PDF 工具当前不可用：本机没有可用的 Python 解释器。请调用 server_info 查看原因与需要设置的变量。"
      + " The PDF tools are unavailable on this machine because no usable Python interpreter was found."
      + " Call server_info for the reason and the variable to set. The office and desktop tool servers"
      + " are unaffected.",
  });
  server.registerTool("server_info", {
    title: "服务器信息 / Server information",
    description: "返回本服务器的状态。当前 PDF 工具不可用，本工具给出缺少的解释器、已尝试的候选路径与需要设置的环境变量。"
      + " Reports this server's status. The PDF tools are currently unavailable; this tool names the"
      + " missing interpreter, every candidate that was tried, and the environment variable to set.",
    inputSchema: z.object({}),
    annotations: { title: "服务器信息 / Server information", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { sideEffect: "read" },
  }, () => {
    const data = {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      implementation: "python",
      available: false,
      reason,
      detail,
      requiredPython: `${MINIMUM_PYTHON[0]}.${MINIMUM_PYTHON[1]}+`,
      remedyVariable: PYTHON_VARIABLE,
      serverEntry: PYTHON_ENTRY,
      tools: [],
    };
    return {
      content: [{
        type: "text" as const,
        text: `server_info: ${SERVER_NAME} ${SERVER_VERSION} 不可用 / unavailable — ${reason}\n`
          + JSON.stringify(data),
      }],
      structuredContent: data,
    };
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} MCP server unavailable: ${detail}\n`);
}

function runPython(command: string, prefixArgs: readonly string[], version: string, source: string): void {
  const child = spawn(command, [...prefixArgs, PYTHON_ENTRY], {
    // The gateway's own stdin/stdout/stderr are handed straight to Python: this process never sees a
    // JSON-RPC frame, so it cannot corrupt, delay or truncate one.
    stdio: "inherit",
    windowsHide: true,
    shell: false,
    cwd: CODE_ROOT,
  });
  process.stderr.write(
    `${SERVER_NAME} MCP server starting python ${version} from ${source} (${command})\n`);
  const forward = (signal: NodeJS.Signals): void => {
    try { child.kill(signal); } catch { /* the child is already gone; the exit handler settles it */ }
  };
  process.on("SIGINT", () => { forward("SIGINT"); });
  process.on("SIGTERM", () => { forward("SIGTERM"); });
  child.on("error", (error: Error) => {
    process.stderr.write(`${SERVER_NAME} MCP server could not start python: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    if (signal !== null) {
      process.stderr.write(`${SERVER_NAME} MCP server python exited on ${signal}\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 0;
  });
}

async function main(): Promise<void> {
  if (!existsSync(PYTHON_ENTRY)) {
    await unavailableServer(
      "the Python server file is missing from this delivery",
      `${PYTHON_ENTRY} does not exist. The package was unpacked without src/tools/pdf-mcp/main.py.`);
    return;
  }
  const resolution = resolvePython();
  if (!resolution.available) {
    await unavailableServer(resolution.reason, describeUnavailable(resolution));
    return;
  }
  runPython(
    resolution.interpreter.command, resolution.interpreter.prefixArgs,
    resolution.interpreter.version, resolution.interpreter.source);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${SERVER_NAME} MCP server failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
