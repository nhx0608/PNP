import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { htmlToText } from "../../../src/tools/office-mcp/system.ts";
import type { AppOpenResult } from "../../../src/tools/office-mcp/system.ts";
import { expectError, startOfficeClient, structured, type ToolResult } from "./harness.ts";

let session: Awaited<ReturnType<typeof startOfficeClient>> | null = null;
async function connect(): Promise<Client> {
  session ??= await startOfficeClient();
  return session.client;
}
after(async () => {
  if (session !== null) await session.stop();
});

const EXPECTED_TOOLS = [
  "docx_extract", "docx_replace_paragraphs", "docx_create",
  "xlsx_read", "xlsx_write",
  "pptx_extract", "pptx_replace_text", "pptx_reorder_slides", "pptx_delete_slides", "pptx_create",
  "csv_read", "data_aggregate", "fs_find", "fs_delete", "app_open", "web_fetch", "server_info",
];

type ServerInfo = {
  name: string;
  version: string;
  platform: string;
  tools: { name: string; title: string; sideEffect: string; description: string }[];
};

test("the stdio server lists every tool with a bilingual description and an input schema", async () => {
  const client = await connect();
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...EXPECTED_TOOLS].sort());
  for (const tool of listed.tools) {
    assert.ok((tool.description ?? "").length > 0, `${tool.name} has no description`);
    assert.match(tool.description ?? "", /[\u4e00-\u9fff]/, `${tool.name} has no Chinese description`);
    assert.match(tool.description ?? "", /[A-Za-z]{4,}/, `${tool.name} has no English description`);
    assert.equal(tool.inputSchema.type, "object", `${tool.name} has no object input schema`);
    assert.ok(tool.annotations?.title !== undefined, `${tool.name} has no annotations`);
  }
  const write = listed.tools.find((tool) => tool.name === "docx_create");
  assert.equal(write?.annotations?.readOnlyHint, false);
  const read = listed.tools.find((tool) => tool.name === "docx_extract");
  assert.equal(read?.annotations?.readOnlyHint, true);
  const external = listed.tools.find((tool) => tool.name === "fs_delete");
  assert.equal(external?.annotations?.destructiveHint, true);
});

test("server_info reports the version and the tool catalogue with each tool's side effect", async () => {
  const client = await connect();
  const info = structured<ServerInfo>(await client.callTool({ name: "server_info", arguments: {} }));
  assert.equal(info.name, "office");
  assert.match(info.version, /^\d+\.\d+\.\d+$/);
  assert.equal(info.platform, process.platform);
  assert.deepEqual(info.tools.map((tool) => tool.name).sort(), [...EXPECTED_TOOLS].sort());
  assert.equal(info.tools.find((tool) => tool.name === "fs_delete")?.sideEffect, "external");
  assert.equal(info.tools.find((tool) => tool.name === "xlsx_write")?.sideEffect, "write");
  assert.equal(info.tools.find((tool) => tool.name === "csv_read")?.sideEffect, "read");
});

test("app_open rejects a name that could carry a path or a shell fragment", async () => {
  const client = await connect();
  expectError(await client.callTool({ name: "app_open", arguments: { name: "C:\\Windows\\System32\\cmd.exe" } }) as ToolResult,
    "INVALID_ARGUMENT");
  expectError(await client.callTool({ name: "app_open", arguments: { name: "outlook'; Stop-Computer #" } }) as ToolResult,
    "INVALID_ARGUMENT");
});

test("app_open reports that it is Windows-only", {
  skip: process.platform === "win32" ? "this host is Windows, where app_open really launches an application" : false,
}, async () => {
  const client = await connect();
  const text = expectError(await client.callTool({ name: "app_open", arguments: { name: "outlook" } }) as ToolResult,
    "PLATFORM_UNSUPPORTED");
  assert.ok(text.includes(process.platform), "the error should name the platform it ran on");
});

test("app_open launches an application through Windows PowerShell", {
  // A hosted CI runner is not a desktop session: on GitHub's Windows runner `Start-Process notepad`
  // never returned within the tool's 20 s budget on two consecutive runs, while the same command is
  // instantaneous on an interactive desktop. The case is therefore verified on a real desktop
  // (docs/local-verification-plan.md, office_002), not here.
  skip: process.platform !== "win32"
    ? `app_open needs Windows PowerShell; this host is ${process.platform}`
    : (process.env.CI !== undefined ? "a hosted Windows runner has no interactive desktop for a GUI launch" : false),
}, async () => {
  const client = await connect();
  const result = structured<AppOpenResult>(await client.callTool({ name: "app_open", arguments: { name: "notepad" } }));
  assert.match(result.command, /powershell\.exe/i);
  assert.ok(result.argv.includes("-NonInteractive"));
  assert.equal(result.exitCode, 0);
});

test("web_fetch accepts only http and https", async () => {
  const client = await connect();
  expectError(await client.callTool({ name: "web_fetch", arguments: { url: "ftp://example.invalid/x" } }) as ToolResult,
    "INVALID_ARGUMENT");
  expectError(await client.callTool({ name: "web_fetch", arguments: { url: "file:///etc/passwd" } }) as ToolResult,
    "INVALID_ARGUMENT");
  expectError(await client.callTool({ name: "web_fetch", arguments: { url: "不是地址" } }) as ToolResult,
    "INVALID_ARGUMENT");
});

test("web_fetch turns HTML into readable text", () => {
  const html = "<html><head><title>库存报告</title><style>p{color:red}</style></head>"
    + "<body><h1>标题</h1><p>第一段 &amp; more</p><ul><li>要点一</li><li>要点二</li></ul>"
    + "<script>ignored()</script></body></html>";
  const text = htmlToText(html);
  assert.ok(!text.includes("ignored"), "script contents must be dropped");
  assert.ok(!text.includes("color:red"), "style contents must be dropped");
  assert.match(text, /第一段 & more/);
  assert.match(text, /- 要点一/);
  assert.ok(!text.includes("<"), "no markup may survive");
});

test("an unknown tool name and a malformed argument are refused, not guessed at", async () => {
  const client = await connect();
  expectError(await client.callTool({ name: "docx_delete_everything", arguments: {} }) as ToolResult,
    "docx_delete_everything");
  expectError(await client.callTool({ name: "docx_extract", arguments: { path: 42 } }) as ToolResult, "path");
});
