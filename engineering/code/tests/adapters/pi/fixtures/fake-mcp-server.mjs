#!/usr/bin/env node
// Test-only MCP server: a real `McpServer` over a real `StdioServerTransport`, so the bridge
// extension under test speaks the actual MCP protocol over a real pipe instead of a stub client.
// It exposes one read-shaped tool and one write-shaped tool, plus one that always fails, so the
// bridge's `isError` mapping can be exercised. It echoes the value of the environment variable
// named by PNP_FIXTURE_SECRET_NAME so a test can prove the driver's env mapping actually arrived.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake-mcp-server", version: "1.0.0" });

server.registerTool("read_file", {
  title: "Read file",
  description: "Reads a file at the given path.",
  inputSchema: { path: z.string().describe("Absolute path to read") },
}, async ({ path }) => ({ content: [{ type: "text", text: `read:${path}` }] }));

server.registerTool("write.file", {
  title: "Write file",
  description: "Writes text to the given path.",
  inputSchema: { path: z.string(), text: z.string() },
}, async ({ path, text }) => ({
  content: [
    { type: "text", text: `wrote:${path}:${text}` },
    { type: "text", text: `env:${process.env[process.env.PNP_FIXTURE_SECRET_NAME ?? "UNSET"] ?? "missing"}` },
  ],
}));

server.registerTool("always_fails", {
  title: "Always fails",
  description: "Always returns an MCP error result.",
  inputSchema: {},
}, async () => ({ isError: true, content: [{ type: "text", text: "fixture failure" }] }));

await server.connect(new StdioServerTransport());
