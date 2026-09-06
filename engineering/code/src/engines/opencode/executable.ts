import { stat } from "node:fs/promises";
import path from "node:path";
import { PnpError } from "../../core/errors.ts";
import type { OpenCodeEngineConfig, OpenCodeExecutableSource } from "./config.ts";

/**
 * Resolves the OpenCode launch target the shared ProcessHost will accept.
 *
 * OpenCode's Windows distribution is `npm install -g` of a JS CLI (docs/engines/opencode.md; no first-party
 * Windows .exe build is documented). npm's global install creates `opencode.cmd`, a batch shim that execs
 * `node.exe <real-entry.js> %*`. The shared ProcessHost spawns with shell:false and rejects anything that is
 * not an absolute path ending in `.exe` (src/runtime/process-host.ts: "Resolve npm shims to a real executable
 * or node.exe plus a JS entrypoint."), so the shim can never be launched directly. This module resolves either
 * (a) a real standalone `.exe`, if an operator has one, or (b) node.exe plus the CLI's absolute script path,
 * which is what actually runs on Windows once npm's shim is peeled back.
 */
export type ExecutableEvidence = "configured" | "environment" | "well-known-probe" | "host-runtime-fallback";
export interface ResolvedOpenCodeExecutable {
  /** Absolute path to the .exe the host will spawn (node.exe in node-script mode). */
  executable: string;
  /** Args to prepend before the ACP subcommand: the script path in node-script mode, nothing in exe mode. */
  prefixArgs: readonly string[];
  kind: "exe" | "node-script";
  executableEvidence: ExecutableEvidence;
  scriptEvidence?: ExecutableEvidence;
}
export interface ExecutableEnvironment {
  /** process.env from the machine resolving the executable (the gateway host), read-only, never mutated. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The gateway's own interpreter path, used as the node-script fallback. */
  readonly hostRuntimePath: string;
  /** Injected so tests can fake "this file exists on disk" without touching a real filesystem. */
  fileExists(candidate: string): Promise<boolean>;
}

async function defaultFileExists(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    return info.isFile();
  } catch {
    return false;
  }
}
export function realExecutableEnvironment(): ExecutableEnvironment {
  return { env: process.env, hostRuntimePath: process.execPath, fileExists: defaultFileExists };
}

/** `${VAR}` and `${VAR(x86)}` token expansion against the resolving environment; unset tokens expand to "". */
function expand(template: string, env: Readonly<Record<string, string | undefined>>): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, name: string) => env[name] ?? "");
}

async function resolveSource(
  source: OpenCodeExecutableSource, environment: ExecutableEnvironment,
): Promise<{ candidate: string; evidence: ExecutableEvidence } | undefined> {
  if (source.configuredPath !== null && source.configuredPath.length > 0) {
    return { candidate: source.configuredPath, evidence: "configured" };
  }
  const fromEnv = environment.env[source.environmentVariable];
  if (fromEnv !== undefined && fromEnv.length > 0) return { candidate: fromEnv, evidence: "environment" };
  for (const template of source.wellKnownPaths) {
    const candidate = expand(template, environment.env);
    if (candidate.length === 0) continue;
    if (await environment.fileExists(candidate)) return { candidate, evidence: "well-known-probe" };
  }
  return undefined;
}
function requireWindowsExecutablePath(candidate: string, field: string): string {
  if (!path.win32.isAbsolute(candidate)) {
    throw new PnpError("ENGINE_EXECUTABLE_INVALID", `${field} must be an absolute Windows path; got "${candidate}".`, 503);
  }
  if (!candidate.toLowerCase().endsWith(".exe")) {
    throw new PnpError("ENGINE_EXECUTABLE_INVALID", `${field} must end in .exe; the shared host rejects npm shims. Got "${candidate}".`, 503);
  }
  return candidate;
}
function requireWindowsScriptPath(candidate: string, field: string): string {
  if (!path.win32.isAbsolute(candidate)) {
    throw new PnpError("ENGINE_EXECUTABLE_INVALID", `${field} must be an absolute Windows path; got "${candidate}".`, 503);
  }
  return candidate;
}

/**
 * Resolution order per source: explicit config `configuredPath` -> environment variable -> well-known
 * install-location probe (existence-checked, never executed). Throws ENGINE_EXECUTABLE_NOT_FOUND (or
 * ENGINE_EXECUTABLE_INVALID for a resolved-but-malformed path) rather than falling back to a guess.
 */
export async function resolveOpenCodeExecutable(
  config: OpenCodeEngineConfig, environment: ExecutableEnvironment = realExecutableEnvironment(),
): Promise<ResolvedOpenCodeExecutable> {
  const requestedKind = environment.env[config.executable.kindEnvironmentVariable];
  const kind = requestedKind === "exe" || requestedKind === "node-script" ? requestedKind : config.executable.defaultKind;
  if (kind === "exe") {
    const resolved = await resolveSource(config.executable.exe, environment);
    if (resolved === undefined) {
      throw new PnpError("ENGINE_EXECUTABLE_NOT_FOUND",
        "No opencode .exe was found via config, environment or well-known paths. Set executable.exe.configuredPath in config/engines/opencode.json or the PNP_OPENCODE_EXE_PATH environment variable.", 503);
    }
    return {
      executable: requireWindowsExecutablePath(resolved.candidate, "executable.exe"),
      prefixArgs: [], kind: "exe", executableEvidence: resolved.evidence,
    };
  }
  let node = await resolveSource(config.executable.node, environment);
  if (node === undefined && config.executable.node.fallbackToHostRuntime) {
    node = { candidate: environment.hostRuntimePath, evidence: "host-runtime-fallback" };
  }
  if (node === undefined) {
    throw new PnpError("ENGINE_EXECUTABLE_NOT_FOUND",
      "No node.exe was found for OpenCode via config, environment, well-known paths or host runtime fallback.", 503);
  }
  const script = await resolveSource(config.executable.script, environment);
  if (script === undefined) {
    throw new PnpError("ENGINE_SCRIPT_NOT_FOUND",
      "No opencode CLI script was found via config, environment or well-known paths. Set executable.script.configuredPath in config/engines/opencode.json or the PNP_OPENCODE_SCRIPT_PATH environment variable to the installed opencode-ai bin script.", 503);
  }
  return {
    executable: requireWindowsExecutablePath(node.candidate, "executable.node"),
    prefixArgs: [requireWindowsScriptPath(script.candidate, "executable.script")],
    kind: "node-script", executableEvidence: node.evidence, scriptEvidence: script.evidence,
  };
}
