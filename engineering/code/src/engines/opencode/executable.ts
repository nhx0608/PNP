import { stat } from "node:fs/promises";
import path from "node:path";
import { PnpError } from "../../core/errors.ts";
import type { OpenCodeEngineConfig, OpenCodeExecutableSource } from "./config.ts";

/**
 * Resolves the OpenCode launch target the shared ProcessHost will accept.
 *
 * `npm install -g opencode-ai` does not install a JS CLI. The package declares `bin` as
 * `{"opencode": "./bin/opencode.exe"}` and ships that path as a ~479-byte placeholder; its postinstall then
 * pulls the real Bun-compiled standalone executable (~172 MB) out of the platform optional dependency
 * (`opencode-windows-x64`, or the `-baseline` variant when the CPU has no AVX2), hard-links or copies it over
 * that same `bin/opencode.exe`, and validates it with `--version`. There is no script entry anywhere in the
 * package, so `exe` is the only mode that matches a real install and is the shipped default
 * (docs/engines/opencode.md section 1).
 *
 * `node-script` is kept as an explicit opt-in (`PNP_OPENCODE_EXECUTABLE_KIND=node-script`) for a repackaged or
 * future JS-entry build; it cannot resolve against a stock install because there is no script to point it at.
 * npm's global install also writes an `opencode.cmd` shim, which the shared ProcessHost refuses either way: it
 * spawns with shell:false and, on win32, rejects an executable that does not end in `.exe`
 * (src/runtime/process-host.ts: "Resolve npm shims to a real executable or node.exe plus a JS entrypoint.").
 */
export type ExecutableEvidence = "configured" | "environment" | "well-known-probe" | "host-runtime-fallback";
export interface ResolvedOpenCodeExecutable {
  /** Absolute path to the binary the host will spawn (node.exe in node-script mode). */
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
  /**
   * Platform of the machine that will spawn the process. It selects the path rule, mirroring the shared
   * ProcessHost exactly: absolute on every platform, `.exe` only on win32 (src/runtime/process-host.ts).
   * Injected so both rules are covered by tests, and so the Pack stays usable for a Linux smoke run against an
   * `opencode-linux-x64` binary instead of being hard-wired to Windows.
   */
  readonly platform: NodeJS.Platform;
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
  return { env: process.env, hostRuntimePath: process.execPath, platform: process.platform, fileExists: defaultFileExists };
}

/**
 * `${VAR}` and `${VAR(x86)}` token expansion against the resolving environment. A template with an unset or
 * empty token yields `undefined` and is skipped: expanding `${APPDATA}\npm\...` to `\npm\...` on a host with no
 * APPDATA would probe -- and could match -- a root-relative path nobody configured.
 */
function expand(template: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
  let unresolved = false;
  const expanded = template.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const value = env[name];
    if (value === undefined || value.length === 0) {
      unresolved = true;
      return "";
    }
    return value;
  });
  return unresolved ? undefined : expanded;
}

/**
 * An explicit path is an operator's statement and is checked as one: a well-formed path that names no file
 * fails here, naming its source, instead of surfacing later as the host's generic "could not be started".
 * Well-known candidates are existence-checked during probing and never reach this.
 */
async function requireExists(
  candidate: string, resolved: { evidence: ExecutableEvidence }, source: OpenCodeExecutableSource,
  field: string, environment: ExecutableEnvironment,
): Promise<void> {
  if (resolved.evidence === "well-known-probe" || await environment.fileExists(candidate)) return;
  const origin = resolved.evidence === "configured" ? `${field}.configuredPath` : source.environmentVariable;
  throw new PnpError("ENGINE_EXECUTABLE_NOT_FOUND", `${origin} names "${candidate}", which is not a file on this host.`, 503);
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
    if (candidate === undefined || candidate.length === 0) continue;
    if (await environment.fileExists(candidate)) return { candidate, evidence: "well-known-probe" };
  }
  return undefined;
}
/**
 * Absoluteness is required on every platform, exactly as the shared ProcessHost requires it. The rule is picked
 * by the *target* platform (`path.win32` / `path.posix`) rather than the ambient `path`, so it stays the same
 * whether the check runs on Windows or on a Linux CI host.
 */
function requireAbsolutePath(candidate: string, field: string, platform: NodeJS.Platform): string {
  const absolute = platform === "win32" ? path.win32.isAbsolute(candidate) : path.posix.isAbsolute(candidate);
  if (!absolute) {
    const shape = platform === "win32" ? "an absolute Windows" : "an absolute POSIX";
    throw new PnpError("ENGINE_EXECUTABLE_INVALID", `${field} must be ${shape} path; got "${candidate}".`, 503);
  }
  return candidate;
}
/**
 * The `.exe` suffix is a Windows-only rule because it is a Windows-only rule in the shared host
 * (`platform === "win32" && !executable.toLowerCase().endsWith(".exe")`). A shared Windows host still enforces
 * it, so the npm shim is still rejected there; a Linux host running `opencode-linux-x64` has no extension to
 * demand and must not be blocked by one.
 */
function requireExecutablePath(candidate: string, field: string, platform: NodeJS.Platform): string {
  requireAbsolutePath(candidate, field, platform);
  if (platform === "win32" && !candidate.toLowerCase().endsWith(".exe")) {
    throw new PnpError("ENGINE_EXECUTABLE_INVALID", `${field} must end in .exe on Windows; the shared host rejects npm shims. Got "${candidate}".`, 503);
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
        "No opencode executable was found via config, environment or well-known paths. Install it with `npm install -g opencode-ai`, or set executable.exe.configuredPath in config/engines/opencode.json or the PNP_OPENCODE_EXE_PATH environment variable.", 503);
    }
    const executable = requireExecutablePath(resolved.candidate, "executable.exe", environment.platform);
    await requireExists(executable, resolved, config.executable.exe, "executable.exe", environment);
    return { executable, prefixArgs: [], kind: "exe", executableEvidence: resolved.evidence };
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
      "No opencode CLI script was found via config, environment or well-known paths. node-script mode is an explicit opt-in for a repackaged JS-entry build: the published opencode-ai package ships a native executable and no script entry, so set executable.script.configuredPath or PNP_OPENCODE_SCRIPT_PATH, or drop PNP_OPENCODE_EXECUTABLE_KIND to use the default exe mode.", 503);
  }
  return {
    executable: requireExecutablePath(node.candidate, "executable.node", environment.platform),
    prefixArgs: [requireAbsolutePath(script.candidate, "executable.script", environment.platform)],
    kind: "node-script", executableEvidence: node.evidence, scriptEvidence: script.evidence,
  };
}
