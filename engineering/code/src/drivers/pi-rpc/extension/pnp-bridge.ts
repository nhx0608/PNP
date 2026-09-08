import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolSideEffect } from "../../../contracts/index.ts";
import type { PiBridgeServer } from "../tool-bridge.ts";

/**
 * The pi extension this driver loads with `-e` (upstream `docs/extensions.md`: extensions are
 * jiti-loaded modules whose default export receives the `ExtensionAPI`; probed on a real
 * `@earendil-works/pi-coding-agent` 0.85.1, which loaded both a `.ts` and a `.js` copy of this
 * shape and accepted every `registerTool` name offered).
 *
 * It runs **inside the pi process**, not inside the gateway, and does two jobs:
 *
 * 1. **MCP client bridge.** It reads the session sidecar written by `../tool-bridge.ts` (path in
 *    `PNP_PI_BRIDGE_FILE`), connects to each of this session's MCP servers with the MCP SDK, and
 *    republishes their tools as pi custom tools. pi has no MCP client of its own and no runtime
 *    "add tool" RPC command, so this is the only way an `mcp-stdio`/`mcp-http` binding can reach
 *    a pi run at all.
 * 2. **Policy gate.** It registers a `tool_call` hook so pi's own built-ins (`bash`, `write`, ...)
 *    go through the gateway's permission policy instead of executing unconditionally
 *    (docs/engineering-review-3.md section 16 A). The decision is *not* made here: the hook turns
 *    every non-read call into a `ctx.ui.confirm` whose title is `pnp:<operation>`, which
 *    `../channel.ts` recognises and routes to `services.interact()`.
 *
 * The sidecar carries environment-variable NAMES only. Their values are placed in the pi
 * process's environment by `../launch.ts` and read back here from `process.env`, so no resolved
 * credential is ever written to disk (docs/spec/contracts.md: resolved tool configuration is
 * never persisted, logged, or put into an error message). Nothing in this file writes a resolved
 * value to a file, an event, or a diagnostic string.
 *
 * This module must not import `node:child_process`: the MCP SDK's stdio transport owns process
 * creation for MCP servers, inside pi's own process tree.
 */

/** Sidecar location, mirrored from `../launch.ts` (kept as a literal so the extension never has
 * to import the driver module — that module reaches the process host and must not load here). */
export const BRIDGE_FILE_ENVIRONMENT = "PNP_PI_BRIDGE_FILE";
/** Returned to pi when the gateway refuses a call. Surfaced to the model as the block reason. */
export const DENIED_REASON = "denied by PNP policy";
/** No dialog channel means no way to reach the gateway's policy, so the call fails closed. */
export const NO_UI_REASON = "no PNP policy channel (pi reported no UI); blocked instead of running unapproved";
/** At most this many, each truncated to `PATTERN_MAX_LENGTH`, so one confirm stays a small frame. */
const PATTERN_LIMIT = 16;
const PATTERN_MAX_LENGTH = 512;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * pi itself validates nothing here (probed against real 0.85.1: `registerTool` accepted
 * `office.docx_extract`, `a.b` and even `bad name` without complaint). The constraint is one step
 * further out — a registered tool becomes a function/tool name in the model request, and both
 * wire formats this gateway targets restrict that name to `[A-Za-z0-9_-]{1,64}`. So the bridged
 * name is `<serverId>.<toolName>` with **every character outside `A-Za-z0-9_-` replaced by `_`**
 * (the joining `.` included), leading `_` trimmed, truncated to 64 characters, and disambiguated
 * with a `_2`, `_3`, ... suffix if two servers collapse onto the same name.
 */
export const TOOL_NAME_MAX_LENGTH = 64;
export function sanitiseToolName(serverId: string, toolName: string): string {
  const replaced = `${serverId}.${toolName}`.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+/, "");
  const trimmed = replaced.length === 0 ? "tool" : replaced;
  return trimmed.length <= TOOL_NAME_MAX_LENGTH ? trimmed : trimmed.slice(0, TOOL_NAME_MAX_LENGTH);
}

/**
 * pi's built-in tool names mapped onto the gateway's operation classes, so one `write: ask`
 * policy means the same thing under pi as it does under OpenCode. `powershell` is here because
 * this driver enables it in place of `bash` on Windows hosts without Git Bash (see
 * `../launch.ts#buildPiSettings`). A name that is neither a built-in nor a bridged MCP tool keeps
 * its own name as the operation: unknown means "not classified as read", never "allowed".
 */
export const BUILT_IN_OPERATIONS: Readonly<Record<string, string>> = {
  bash: "shell", powershell: "shell",
  write: "write", edit: "write",
  read: "read", grep: "read", find: "read", ls: "read",
};
function operationForSideEffect(sideEffect: ToolSideEffect): string {
  return sideEffect === "read" ? "read" : sideEffect === "write" ? "write" : "external";
}
export function operationForTool(toolName: string, bridged: ReadonlyMap<string, ToolSideEffect>): string {
  const sideEffect = bridged.get(toolName);
  if (sideEffect !== undefined) return operationForSideEffect(sideEffect);
  return BUILT_IN_OPERATIONS[toolName] ?? toolName;
}

function looksLikePath(value: string): boolean {
  if (value.length === 0 || value.length > 1024) return false;
  return value.includes("/") || value.includes("\\") || /^[A-Za-z]:/.test(value);
}
/**
 * The path/command strings a policy rule can match on (docs/spec/contracts.md R7 patterns). Only
 * model-supplied tool arguments are read; nothing here can reach a credential, because the tool
 * arguments never carry one (the MCP server's own env/headers stay in `process.env`).
 */
export function extractPatterns(input: unknown): string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  const patterns: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== "string" || value.length === 0) return;
    const trimmed = value.length > PATTERN_MAX_LENGTH ? value.slice(0, PATTERN_MAX_LENGTH) : value;
    if (!patterns.includes(trimmed) && patterns.length < PATTERN_LIMIT) patterns.push(trimmed);
  };
  const named = ["path", "file_path", "command"];
  for (const key of named) add(record[key]);
  for (const [key, value] of Object.entries(record)) {
    if (named.includes(key)) continue;
    if (typeof value === "string" && looksLikePath(value)) add(value);
  }
  return patterns;
}

/** The slice of pi's `ExtensionAPI`/`ExtensionContext` this extension uses. Declared locally so
 * the gateway never takes a build or runtime dependency on the pi package. */
export interface PiUiContext {
  confirm(title: string, message: string): Promise<boolean> | boolean;
}
export interface PiEventContext {
  readonly hasUI: boolean;
  readonly ui: PiUiContext;
}
export interface PiToolCallEvent {
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly input?: unknown;
}
export interface PiToolCallDecision {
  readonly block: true;
  readonly reason: string;
}
export interface PiToolContent {
  readonly type: "text";
  readonly text: string;
}
export interface PiToolResult {
  readonly content: readonly PiToolContent[];
  readonly details?: unknown;
}
export interface PiToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: unknown;
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<PiToolResult>;
}
export interface PiExtensionApi {
  registerTool(definition: PiToolDefinition): void;
  on(event: "tool_call", handler: (event: PiToolCallEvent, ctx: PiEventContext) => Promise<PiToolCallDecision | undefined>): void;
  on(event: "session_shutdown", handler: () => Promise<void>): void;
}

/**
 * `tool_call` returns `{block:true, reason}` to stop a call and `undefined` to let it through
 * (upstream `docs/extensions.md` "Tool Events"). `read` is allowed without a round trip; every
 * other operation asks the gateway. A confirm that throws blocks: a policy channel that cannot
 * answer must never read as approval.
 */
export function createToolCallHook(bridged: ReadonlyMap<string, ToolSideEffect>) {
  return async function onToolCall(event: PiToolCallEvent, ctx: PiEventContext): Promise<PiToolCallDecision | undefined> {
    const operation = operationForTool(event.toolName, bridged);
    if (operation === "read") return undefined;
    if (ctx.hasUI !== true) return { block: true, reason: NO_UI_REASON };
    const patterns = extractPatterns(event.input);
    const message = JSON.stringify({ tool: event.toolName, operation, patterns });
    let allowed: boolean;
    try { allowed = await ctx.ui.confirm(`pnp:${operation}`, message); }
    catch { return { block: true, reason: `${DENIED_REASON} (policy channel unavailable)` }; }
    return allowed === true ? undefined : { block: true, reason: DENIED_REASON };
  };
}

/** Reads the sidecar. A missing variable means "this session has no MCP server", not an error. */
export function loadBridgeServers(file: string | undefined, report: (message: string) => void): PiBridgeServer[] {
  if (file === undefined || file.length === 0) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { report(`PNP bridge: cannot read the tool sidecar: ${describe(error)}`); return []; }
  if (!Array.isArray(parsed)) { report("PNP bridge: the tool sidecar is not an array; no MCP server was bridged."); return []; }
  return parsed as PiBridgeServer[];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/** Resolved values only ever come from `process.env` and only ever go into a transport. */
function resolveByName(names: Readonly<Record<string, string>>, env: NodeJS.ProcessEnv): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [original, variable] of Object.entries(names)) {
    const value = env[variable];
    if (value !== undefined) resolved[original] = value;
  }
  return resolved;
}

export async function connectBridgeServer(server: PiBridgeServer, env: NodeJS.ProcessEnv = process.env): Promise<Client> {
  const client = new Client({ name: "pnp-pi-bridge", version: "1.0.0" });
  if (server.transport === "stdio") {
    const inherited: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) if (value !== undefined) inherited[key] = value;
    const transport = new StdioClientTransport({
      command: server.command, args: [...server.args],
      env: { ...inherited, ...resolveByName(server.envNames, env) },
    });
    await client.connect(transport, { timeout: server.timeoutMs > 0 ? server.timeoutMs : DEFAULT_CONNECT_TIMEOUT_MS });
    return client;
  }
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: resolveByName(server.headerNames, env) },
  });
  await client.connect(transport, { timeout: server.timeoutMs > 0 ? server.timeoutMs : DEFAULT_CONNECT_TIMEOUT_MS });
  return client;
}

interface ListedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}
/**
 * Turns one server's `tools/list` answer into pi tool registrations.
 *
 * `isError` is carried across faithfully by **throwing**: upstream `docs/extensions.md` is
 * explicit that "returning a value never sets the error flag regardless of what properties you
 * include", and only a thrown error marks the tool result failed for the model. Returning a
 * success-shaped result for a failed MCP call would be exactly the fabricated-success pattern the
 * repository rules forbid.
 */
export function registerBridgedTools(
  pi: PiExtensionApi, client: Client, server: PiBridgeServer, tools: readonly ListedTool[],
  taken: Set<string>, bridged: Map<string, ToolSideEffect>,
): string[] {
  const registered: string[] = [];
  for (const tool of tools) {
    let name = sanitiseToolName(server.id, tool.name);
    let attempt = 2;
    while (taken.has(name)) { name = `${sanitiseToolName(server.id, tool.name).slice(0, TOOL_NAME_MAX_LENGTH - 3)}_${String(attempt)}`; attempt += 1; }
    taken.add(name);
    bridged.set(name, server.sideEffect);
    registered.push(name);
    const schema = tool.inputSchema === undefined || tool.inputSchema === null ? { type: "object" } : tool.inputSchema;
    pi.registerTool({
      name, label: name,
      description: tool.description ?? `${tool.name} (bridged from MCP server ${server.id})`,
      parameters: schema,
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal): Promise<PiToolResult> {
        const args = params !== null && typeof params === "object" && !Array.isArray(params)
          ? params as Record<string, unknown> : {};
        const result = await client.callTool({ name: tool.name, arguments: args }, undefined, {
          ...(server.timeoutMs > 0 ? { timeout: server.timeoutMs } : {}),
          ...(signal === undefined ? {} : { signal }),
        });
        const content = toTextContent(result.content);
        if (result.isError === true) {
          throw new Error(content.length === 0 ? `MCP tool ${tool.name} reported an error with no message.` : content);
        }
        return { content: [{ type: "text", text: content }], details: { server: server.id, tool: tool.name } };
      },
    });
  }
  return registered;
}

/** Text parts verbatim, in order; a non-text part is named rather than dropped or invented. */
function toTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (entry === null || typeof entry !== "object") continue;
    const part = entry as { type?: unknown; text?: unknown };
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else if (typeof part.type === "string") parts.push(`[${part.type} content returned by the MCP server; not rendered as text]`);
  }
  return parts.join("\n");
}

export interface BridgeOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Where a per-server failure goes. Defaults to stderr: in `--mode rpc` stdout is the protocol
   * channel, and pi's own `ExtensionContext` (with `ctx.ui.notify`) does not exist at load time —
   * probed on real 0.85.1, which rejects action methods called during extension loading. */
  readonly report?: (message: string) => void;
}
/**
 * Connects every sidecar server and registers the `tool_call` hook. One server failing to connect
 * is reported once and skipped; the extension still loads, the other servers still work, and the
 * policy hook is still installed. Throwing here would take the whole pi process's startup with it.
 *
 * The connected clients are returned so a caller that owns their lifetime (a test, or a future pi
 * shutdown hook) can close them. pi itself ignores the value; its own process exit tears the MCP
 * server children down with it, since the SDK's stdio transport owns them.
 */
export async function activateBridge(pi: PiExtensionApi, options: BridgeOptions = {}): Promise<Client[]> {
  const env = options.env ?? process.env;
  const report = options.report ?? ((message: string) => { console.error(message); });
  const bridged = new Map<string, ToolSideEffect>();
  const taken = new Set<string>();
  const clients: Client[] = [];
  for (const server of loadBridgeServers(env[BRIDGE_FILE_ENVIRONMENT], report)) {
    try {
      const client = await connectBridgeServer(server, env);
      clients.push(client);
      const listed = await client.listTools();
      registerBridgedTools(pi, client, server, listed.tools, taken, bridged);
    } catch (error) {
      // Server id and transport are configuration identifiers, never credentials.
      report(`PNP bridge: MCP server "${server.id}" (${server.transport}) is unavailable: ${describe(error)}`);
    }
  }
  pi.on("tool_call", createToolCallHook(bridged));
  // Upstream `docs/extensions.md` "Long-lived resources and shutdown": close session-scoped
  // resources from an idempotent `session_shutdown` handler, which pi also fires on exit
  // (Ctrl+C/Ctrl+D/SIGHUP/SIGTERM -- closing pi's stdin, which is exactly how `LocalProcessHost`
  // asks a process to stop, counts as Ctrl+D). This is not tidiness: every MCP server the SDK
  // started is a child in pi's own process group, and `LocalProcessHost` proves a stop on POSIX by
  // checking that the whole group is gone the moment pi exits. Measured against real pi 0.85.1:
  // without this handler a session with one bridged MCP server terminated as
  // `{quiescent:false, method:"process-tree"}` because the server child had not yet noticed its
  // stdin EOF; with it, the same session terminates as `{quiescent:true, method:"protocol"}`.
  let closed = false;
  pi.on("session_shutdown", async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const client of clients) {
      try { await client.close(); } catch { /* Already gone: a failed close is not a reason to block pi's exit. */ }
    }
  });
  return clients;
}

export default async function activate(pi: PiExtensionApi): Promise<void> {
  await activateBridge(pi);
}
