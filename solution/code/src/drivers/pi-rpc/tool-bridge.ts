import { writeFile } from "node:fs/promises";
import type { ToolBinding, ToolSideEffect } from "../../contracts/index.ts";
import type { PiSessionPaths } from "./launch.ts";

/** Variable-name prefixes for the values the bridge extension resolves from `process.env`. */
export const TOOL_ENVIRONMENT_PREFIX = "PNP_PI_TOOLENV_";
export const TOOL_HEADER_ENVIRONMENT_PREFIX = "PNP_PI_TOOLHDR_";
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** One MCP server this session may reach, as written to the `pnp-tools.json` sidecar. Every
 * credential-bearing field is a variable NAME; the values live only in `LaunchSpec.env`. */
export interface PiStdioBridgeServer {
  readonly id: string;
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  /** Original variable name -> generated variable name holding the resolved value. */
  readonly envNames: Readonly<Record<string, string>>;
  readonly sideEffect: ToolSideEffect;
  readonly timeoutMs: number;
}
export interface PiHttpBridgeServer {
  readonly id: string;
  readonly transport: "http";
  readonly url: string;
  /** Original header name -> generated variable name holding the resolved value. */
  readonly headerNames: Readonly<Record<string, string>>;
  readonly sideEffect: ToolSideEffect;
  readonly timeoutMs: number;
}
export type PiBridgeServer = PiStdioBridgeServer | PiHttpBridgeServer;

export interface DroppedPiToolBinding {
  readonly id: string;
  readonly transport: ToolBinding["transport"];
  readonly reason: string;
}
export interface PiToolProjection {
  readonly servers: readonly PiBridgeServer[];
  /** Generated variable name -> resolved value. Only ever placed in `LaunchSpec.env`. */
  readonly env: Readonly<Record<string, string>>;
  readonly dropped: readonly DroppedPiToolBinding[];
}

const COMMAND_UNSUPPORTED_REASON = "the pi bridge is an MCP client; cli/native command bindings are not supported";

/**
 * Projects the run's tool bindings onto the sidecar the in-pi bridge extension reads.
 *
 * Only MCP transports are supported: the bridge connects with the MCP SDK client, so an
 * `mcp-stdio` binding is started by the SDK's own stdio transport inside the pi process and an
 * `mcp-http` binding is reached over Streamable HTTP. `cli`/`native` bindings used to be executed
 * by a generated extension calling `execFile`; that path is gone, so they are dropped and
 * reported through the existing `tools.unsupported-transport` notice rather than being
 * reinterpreted as MCP servers.
 */
export function projectPiTools(tools: readonly ToolBinding[]): PiToolProjection {
  const servers: PiBridgeServer[] = [];
  const dropped: DroppedPiToolBinding[] = [];
  const env: Record<string, string> = {};
  let envIndex = 0;
  let headerIndex = 0;
  for (const tool of tools) {
    const timeoutMs = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    if (tool.transport === "mcp-stdio") {
      const envNames: Record<string, string> = {};
      for (const [name, value] of Object.entries(tool.env)) {
        envIndex += 1;
        const variable = `${TOOL_ENVIRONMENT_PREFIX}${String(envIndex)}`;
        envNames[name] = variable;
        env[variable] = value;
      }
      servers.push({ id: tool.id, transport: "stdio", command: tool.command, args: [...tool.args], envNames, sideEffect: tool.sideEffect, timeoutMs });
      continue;
    }
    if (tool.transport === "mcp-http") {
      const headerNames: Record<string, string> = {};
      for (const [name, value] of Object.entries(tool.headers)) {
        headerIndex += 1;
        const variable = `${TOOL_HEADER_ENVIRONMENT_PREFIX}${String(headerIndex)}`;
        headerNames[name] = variable;
        env[variable] = value;
      }
      servers.push({ id: tool.id, transport: "http", url: tool.url, headerNames, sideEffect: tool.sideEffect, timeoutMs });
      continue;
    }
    dropped.push({ id: tool.id, transport: tool.transport, reason: COMMAND_UNSUPPORTED_REASON });
  }
  return { servers, env, dropped };
}

export interface WrittenToolBridge {
  /** Absolute sidecar path, or undefined when this session has no MCP server at all. */
  readonly bridgeFile?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly dropped: readonly DroppedPiToolBinding[];
}
/**
 * Writes the session sidecar. Mode 0600 is requested for the same reason `LocalProcessHost` does
 * it for ownership records; on Windows Node ignores the mode and the directory ACL is the only
 * protection, which is exactly why the file carries variable names and never a resolved value
 * (docs/engineering-review-3.md section 16 B).
 */
export async function writeToolBridge(paths: PiSessionPaths, tools: readonly ToolBinding[]): Promise<WrittenToolBridge> {
  const projection = projectPiTools(tools);
  if (projection.servers.length === 0) return { env: projection.env, dropped: projection.dropped };
  await writeFile(paths.toolsFile, JSON.stringify(projection.servers, null, 2), { mode: 0o600 });
  return { bridgeFile: paths.toolsFile, env: projection.env, dropped: projection.dropped };
}
