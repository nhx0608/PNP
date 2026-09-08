import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { describeError } from "./errors.ts";

/** What a tool reports on success: one human-readable line plus the machine-readable result. */
export type ToolPayload = { summary: string; data: Record<string, unknown> };

export type SideEffect = "read" | "write" | "external";

/**
 * Both halves of the answer travel in the same result: `structuredContent` for a client that reads
 * MCP structured output, and the same JSON appended to the text block for the engines that only
 * surface text to the model. Sending the summary alone would make the model guess at the data it
 * just asked for.
 */
export function successResult(payload: ToolPayload): CallToolResult {
  return {
    content: [{ type: "text", text: `${payload.summary}\n${JSON.stringify(payload.data)}` }],
    structuredContent: payload.data,
  };
}

export function failureResult(tool: string, error: unknown): CallToolResult {
  const described = describeError(error);
  return {
    content: [{ type: "text", text: `${tool} 失败 / failed [${described.code}]: ${described.message}` }],
    isError: true,
  };
}

export function annotationsFor(sideEffect: SideEffect, title: string): ToolAnnotations {
  if (sideEffect === "read") return { title, readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  if (sideEffect === "write") {
    return { title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  }
  return { title, readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
}
