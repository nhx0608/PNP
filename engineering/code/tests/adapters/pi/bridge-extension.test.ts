import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activateBridge, createToolCallHook, DENIED_REASON, extractPatterns, NO_UI_REASON,
  operationForTool, sanitiseToolName,
} from "../../../src/drivers/pi-rpc/extension/pnp-bridge.ts";
import type {
  PiEventContext, PiExtensionApi, PiToolCallDecision, PiToolCallEvent, PiToolDefinition,
} from "../../../src/drivers/pi-rpc/extension/pnp-bridge.ts";
import type { ToolSideEffect } from "../../../src/contracts/index.ts";
import { projectPiTools } from "../../../src/drivers/pi-rpc/tool-bridge.ts";
import type { ToolBinding } from "../../../src/contracts/index.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Loads the real extension module in-process against a fake `pi` object and a *real* MCP server
 * (`fixtures/fake-mcp-server.mjs`, an `McpServer` over a `StdioServerTransport` started by the MCP
 * SDK's own stdio client transport). No pi binary is needed; the same module was additionally
 * loaded by a real 0.85.1 process with `-e` during the probe recorded in `docs/engines/pi.md` B08.
 */
const SERVER_FIXTURE = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

interface FakePi extends PiExtensionApi {
  readonly tools: PiToolDefinition[];
  hook?: (event: PiToolCallEvent, ctx: PiEventContext) => Promise<PiToolCallDecision | undefined>;
  shutdown?: () => Promise<void>;
}
function fakePi(): FakePi {
  const tools: PiToolDefinition[] = [];
  const pi = {
    tools,
    registerTool(definition: PiToolDefinition) { tools.push(definition); },
    on(event: string, handler: unknown) {
      if (event === "tool_call") pi.hook = handler as FakePi["hook"];
      else pi.shutdown = handler as FakePi["shutdown"];
    },
  } as FakePi;
  return pi;
}
function uiContext(answer: boolean | Error, calls: { title: string; message: string }[] = []): PiEventContext {
  return {
    hasUI: true,
    ui: {
      async confirm(title: string, message: string): Promise<boolean> {
        calls.push({ title, message });
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}
async function sidecarFor(binding: ToolBinding): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-pi-bridge-"));
  const file = path.join(root, "pnp-tools.json");
  await writeFile(file, JSON.stringify(projectPiTools([binding]).servers));
  return file;
}
const stdioBinding: ToolBinding = {
  id: "office", transport: "mcp-stdio", command: process.execPath, args: [SERVER_FIXTURE],
  env: { FIXTURE_TOKEN: "tool-secret" }, sideEffect: "write", timeoutMs: 20_000,
};
/** Every connected client owns a real child process; a test file that leaves one running never
 * exits, which `scripts/test.mjs` deliberately refuses to paper over with --test-force-exit. */
async function closeAll(clients: readonly Client[]): Promise<void> {
  for (const client of clients) await client.close();
}

test("the bridge connects to a real MCP server and registers every tool under a sanitised name", async () => {
  const pi = fakePi();
  const file = await sidecarFor(stdioBinding);
  const projection = projectPiTools([stdioBinding]);
  const clients = await activateBridge(pi, {
    env: { ...process.env, PNP_PI_BRIDGE_FILE: file, PNP_FIXTURE_SECRET_NAME: "FIXTURE_TOKEN", ...projection.env },
    report: (message) => { throw new Error(`unexpected bridge failure: ${message}`); },
  });
  try {
    assert.deepEqual(pi.tools.map((tool) => tool.name), ["office_read_file", "office_write_file", "office_always_fails"]);
    const read = pi.tools[0]!;
    assert.equal(read.description, "Reads a file at the given path.");
    assert.equal((read.parameters as { type: string }).type, "object");
    assert.notEqual(pi.hook, undefined);
  } finally { await closeAll(clients); }
});

test("a bridged call returns the server's text parts, and the resolved env reached the server process", async () => {
  const pi = fakePi();
  const file = await sidecarFor(stdioBinding);
  const projection = projectPiTools([stdioBinding]);
  const clients = await activateBridge(pi, { env: { ...process.env, PNP_PI_BRIDGE_FILE: file, PNP_FIXTURE_SECRET_NAME: "FIXTURE_TOKEN", ...projection.env } });
  try {
    const read = pi.tools.find((tool) => tool.name === "office_read_file")!;
    const result = await read.execute("call-1", { path: "/tmp/report.docx" });
    assert.deepEqual(result.content, [{ type: "text", text: "read:/tmp/report.docx" }]);
    assert.deepEqual(result.details, { server: "office", tool: "read_file" });
    const write = pi.tools.find((tool) => tool.name === "office_write_file")!;
    const written = await write.execute("call-2", { path: "/tmp/out.txt", text: "hi" });
    // The value travelled only in the launch environment; the server read it back under its own name.
    assert.equal(written.content[0]!.text, "wrote:/tmp/out.txt:hi\nenv:tool-secret");
  } finally { await closeAll(clients); }
});

test("an MCP isError result throws, because a returned value never marks a pi tool result failed", async () => {
  const pi = fakePi();
  const file = await sidecarFor(stdioBinding);
  const projection = projectPiTools([stdioBinding]);
  const clients = await activateBridge(pi, { env: { ...process.env, PNP_PI_BRIDGE_FILE: file, ...projection.env } });
  try {
    const failing = pi.tools.find((tool) => tool.name === "office_always_fails")!;
    await assert.rejects(failing.execute("call-3", {}), /fixture failure/);
  } finally { await closeAll(clients); }
});

test("a server that cannot be reached is reported once and does not stop the extension loading", async () => {
  const pi = fakePi();
  const broken: ToolBinding = { ...stdioBinding, id: "broken", args: [path.join(path.dirname(SERVER_FIXTURE), "does-not-exist.mjs")] };
  const file = await sidecarFor(broken);
  const reported: string[] = [];
  const clients = await activateBridge(pi, { env: { ...process.env, PNP_PI_BRIDGE_FILE: file }, report: (message) => reported.push(message) });
  await closeAll(clients);
  assert.equal(pi.tools.length, 0);
  assert.equal(reported.length, 1);
  assert.match(reported[0]!, /"broken" \(stdio\)/);
  assert.notEqual(pi.hook, undefined); // The policy hook is installed even with no usable server.
});

test("no sidecar at all still installs the policy hook", async () => {
  const pi = fakePi();
  await activateBridge(pi, { env: {}, report: () => { throw new Error("nothing to report"); } });
  assert.deepEqual(pi.tools, []);
  assert.notEqual(pi.hook, undefined);
});

test("the tool_call hook allows reads silently and asks the gateway for everything else", async () => {
  const bridged = new Map<string, ToolSideEffect>([["office_write_file", "write"], ["office_read_file", "read"], ["welink_send", "external"]]);
  const hook = createToolCallHook(bridged);
  for (const name of ["read", "grep", "find", "ls", "office_read_file"]) {
    const calls: { title: string; message: string }[] = [];
    assert.equal(await hook({ toolName: name, input: { path: "/tmp/a" } }, uiContext(true, calls)), undefined);
    assert.deepEqual(calls, [], `${name} should not have asked for permission`);
  }
  const calls: { title: string; message: string }[] = [];
  assert.equal(await hook({ toolName: "bash", input: { command: "del /f C:\\data\\x" } }, uiContext(true, calls)), undefined);
  assert.deepEqual(calls, [{ title: "pnp:shell", message: JSON.stringify({ tool: "bash", operation: "shell", patterns: ["del /f C:\\data\\x"] }) }]);
  const denied: { title: string; message: string }[] = [];
  assert.deepEqual(await hook({ toolName: "write", input: { path: "C:\\out\\report.docx" } }, uiContext(false, denied)),
    { block: true, reason: DENIED_REASON });
  assert.equal(denied[0]!.title, "pnp:write");
  assert.deepEqual(JSON.parse(denied[0]!.message), { tool: "write", operation: "write", patterns: ["C:\\out\\report.docx"] });
  // Bridged MCP tools carry their server's declared side effect, and unknown names are not "read".
  assert.equal((await hook({ toolName: "office_write_file", input: {} }, uiContext(true)))?.block, undefined);
  assert.equal((await hook({ toolName: "welink_send", input: {} }, uiContext(false)))?.reason, DENIED_REASON);
  assert.equal(operationForTool("welink_send", bridged), "external");
  assert.equal(operationForTool("something_new", bridged), "something_new");
  assert.equal(operationForTool("powershell", bridged), "shell");
});

test("a missing UI channel and a failing confirm both block instead of running unapproved", async () => {
  const hook = createToolCallHook(new Map());
  const noUi: PiEventContext = { hasUI: false, ui: { confirm: () => { throw new Error("must not be called"); } } };
  assert.deepEqual(await hook({ toolName: "bash", input: { command: "echo" } }, noUi), { block: true, reason: NO_UI_REASON });
  assert.equal(await hook({ toolName: "read", input: { path: "/tmp/a" } }, noUi), undefined); // Reads still pass.
  const decision = await hook({ toolName: "edit", input: { path: "/tmp/a" } }, uiContext(new Error("channel gone")));
  assert.equal(decision?.block, true);
  assert.match(decision!.reason, /policy channel unavailable/);
});

test("patterns come from the documented argument names and from path-shaped strings", () => {
  assert.deepEqual(extractPatterns({ command: "ls -la" }), ["ls -la"]);
  assert.deepEqual(extractPatterns({ path: "/a/b", file_path: "/c/d" }), ["/a/b", "/c/d"]);
  assert.deepEqual(extractPatterns({ destination: "C:\\out\\x.docx", note: "just words", count: 3 }), ["C:\\out\\x.docx"]);
  assert.deepEqual(extractPatterns({ path: "/a", also: "/a" }), ["/a"]); // De-duplicated.
  assert.deepEqual(extractPatterns("not an object"), []);
  assert.equal(extractPatterns({ path: "x".repeat(900) })[0]!.length, 512); // Bounded frame size.
});

test("bridged names are reduced to the character set both model wire formats accept", () => {
  assert.equal(sanitiseToolName("office", "docx_extract"), "office_docx_extract");
  assert.equal(sanitiseToolName("office-mcp", "write.file"), "office-mcp_write_file");
  assert.equal(sanitiseToolName("a b", "c/d"), "a_b_c_d");
  assert.equal(sanitiseToolName("_", "_"), "tool"); // Leading underscores trimmed; never empty.
  assert.equal(sanitiseToolName("x".repeat(80), "y").length, 64);
});

test("session_shutdown closes every MCP client, so pi's exit leaves no server child behind", async () => {
  // Real-pi measurement: without this handler LocalProcessHost proved the stop only as
  // {quiescent:false, method:"process-tree"} (the server child was still in pi's process group
  // when pi exited); with it the same session terminates as {quiescent:true, method:"protocol"}.
  const pi = fakePi();
  const file = await sidecarFor(stdioBinding);
  const projection = projectPiTools([stdioBinding]);
  const clients = await activateBridge(pi, { env: { ...process.env, PNP_PI_BRIDGE_FILE: file, ...projection.env } });
  assert.equal(clients.length, 1);
  assert.notEqual(pi.shutdown, undefined);
  await pi.shutdown!();
  await pi.shutdown!(); // Idempotent, as the upstream guidance requires.
  const read = pi.tools.find((tool) => tool.name === "office_read_file")!;
  await assert.rejects(read.execute("call-after-shutdown", { path: "/tmp/a" })); // The transport is really gone.
});
