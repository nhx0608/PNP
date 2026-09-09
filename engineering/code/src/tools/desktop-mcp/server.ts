import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorMessage } from "./errors.ts";
import { discoverApplications, openApplication, type DesktopOperations } from "./windows.ts";

export const SERVER_NAME = "windows-desktop";
export const SERVER_VERSION = "0.1.0";

function result(data: Record<string, unknown>, summary: string): CallToolResult {
  return { content: [{ type: "text", text: `${summary}\n${JSON.stringify(data)}` }], structuredContent: data };
}

function failure(name: string, error: unknown): CallToolResult {
  const described = errorMessage(error);
  return { content: [{ type: "text", text: `${name} failed [${described.code}]: ${described.message}` }], isError: true };
}

function annotations(sideEffect: "read" | "external", title: string): ToolAnnotations {
  return sideEffect === "read"
    ? { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    : { title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
}

export function createDesktopServer(operations?: DesktopOperations): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, {
    instructions: "Windows desktop MCP only discovers and launches its fixed allowlist: Notepad, Outlook (classic), and Outlook (new). It cannot run arbitrary commands, automate UI, send messages, or close applications.",
  });
  server.registerTool("desktop_list_apps", {
    title: "Discover allowed Windows applications",
    description: "Detects whether the fixed safe allowlist is installed: Notepad, Outlook (classic), and Outlook (new). Missing Outlook variants include an actionable diagnostic.",
    inputSchema: z.object({}), annotations: annotations("read", "Discover allowed Windows applications"), _meta: { sideEffect: "read" },
  }, async (_args, extra) => {
    try { return result({ applications: await (operations?.discover ?? discoverApplications)(extra.signal) }, "desktop_list_apps: inspected the fixed Windows application allowlist."); }
    catch (error) { return failure("desktop_list_apps", error); }
  });
  server.registerTool("desktop_open_app", {
    title: "Open an allowed Windows application",
    description: "Requests Windows Shell activation for exactly one allowlisted app: notepad, outlook-classic, or outlook-new. It never accepts paths, shell commands, arguments, UI automation instructions, or message content. Activation acceptance is not proof that the app UI is ready.",
    inputSchema: z.object({ appId: z.enum(["notepad", "outlook-classic", "outlook-new"]) }), annotations: annotations("external", "Open an allowed Windows application"), _meta: { sideEffect: "external" },
  }, async (args, extra) => {
    try { return result(await openApplication(args.appId, extra.signal, operations), `desktop_open_app: ${args.appId} launch result.`); }
    catch (error) { return failure("desktop_open_app", error); }
  });
  return server;
}
