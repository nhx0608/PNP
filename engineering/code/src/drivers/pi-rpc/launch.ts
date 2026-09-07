import path from "node:path";
import type { LaunchSpec } from "../../contracts/host.ts";
import type { ModelSelection, ResolvedModel } from "../../contracts/index.ts";
import { PnpError } from "../../core/errors.ts";
import { baseEnvironment } from "../../runtime/process-host.ts";

/**
 * Locates the `pi` CLI. There is no portable global-install path across npm/pnpm/Windows shims
 * (a `.cmd`/`.ps1` shim is not a directly launchable executable on this platform; see
 * `LocalProcessHost.start`'s "resolve npm shims" check), so the operator must point at a real
 * executable explicitly instead of us guessing an install layout that may be wrong.
 */
export interface PiLaunchConfig {
  /** Absolute path to a Node executable, or to a self-contained `pi` executable when `entry` is unset. */
  readonly node: string;
  /** Absolute path to the pi-coding-agent CLI entry script; omitted when `node` is itself the pi executable. */
  readonly entry?: string;
  readonly extraArgs: readonly string[];
  readonly approve: "always" | "never";
}
export function resolvePiLaunchConfig(env: NodeJS.ProcessEnv = process.env): PiLaunchConfig {
  const executable = env.PNP_PI_EXECUTABLE;
  const entry = env.PNP_PI_ENTRY;
  const node = env.PNP_PI_NODE ?? process.execPath;
  const approve: "always" | "never" = env.PNP_PI_APPROVE === "always" ? "always" : "never";
  let extraArgs: readonly string[] = [];
  if (env.PNP_PI_EXTRA_ARGS !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(env.PNP_PI_EXTRA_ARGS); }
    catch { throw new PnpError("ENGINE_CONFIGURATION_ERROR", "PNP_PI_EXTRA_ARGS must be a JSON array of strings.", 400); }
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
      throw new PnpError("ENGINE_CONFIGURATION_ERROR", "PNP_PI_EXTRA_ARGS must be a JSON array of strings.", 400);
    }
    extraArgs = parsed;
  }
  if (executable !== undefined) {
    if (!path.isAbsolute(executable)) throw new PnpError("ENGINE_CONFIGURATION_ERROR", "PNP_PI_EXECUTABLE must be an absolute path.", 400);
    return { node: executable, extraArgs, approve };
  }
  if (entry !== undefined) {
    if (!path.isAbsolute(entry) || !path.isAbsolute(node)) {
      throw new PnpError("ENGINE_CONFIGURATION_ERROR", "PNP_PI_ENTRY and PNP_PI_NODE must be absolute paths.", 400);
    }
    return { node, entry, extraArgs, approve };
  }
  throw new PnpError("ENGINE_UNAVAILABLE", "Pi CLI location is not configured; set PNP_PI_EXECUTABLE or PNP_PI_ENTRY.", 503);
}

export interface PiSessionPaths {
  readonly sessionDir: string;
  readonly sessionFile: string;
  readonly toolsFile: string;
  readonly extensionFile: string;
}
export function resolveSessionPaths(nativeDataDirectory: string): PiSessionPaths {
  return {
    sessionDir: nativeDataDirectory,
    sessionFile: path.join(nativeDataDirectory, "session.jsonl"),
    toolsFile: path.join(nativeDataDirectory, "pnp-tools.json"),
    extensionFile: path.join(nativeDataDirectory, "pnp-tool-bridge.mjs"),
  };
}

export function buildLaunchSpec(config: PiLaunchConfig, input: {
  readonly sessionId: string;
  readonly ownerToken: string;
  readonly cwd: string;
  readonly paths: PiSessionPaths;
  readonly extensionPath?: string;
  readonly model: ResolvedModel;
}): LaunchSpec {
  const flags = [
    "--mode", "rpc",
    "--session", input.paths.sessionFile,
    "--session-dir", input.paths.sessionDir,
    config.approve === "always" ? "--approve" : "--no-approve",
    ...buildModelArgs(input.model.selection),
    ...(input.extensionPath === undefined ? [] : ["-e", input.extensionPath]),
    ...config.extraArgs,
  ];
  const args = config.entry === undefined ? flags : [config.entry, ...flags];
  return {
    executable: config.node,
    args,
    cwd: input.cwd,
    env: { ...baseEnvironment(), ...buildModelEnv(input.model), PI_TELEMETRY: "0" },
    sessionId: input.sessionId,
    ownerToken: input.ownerToken,
  };
}

/** `--provider`/`--model` are the documented pi CLI selectors (docs/research/T02-pi-harness.md
 * §"接入方式选择"); this is a declared mapping, not verified against a real installed pi build. */
export function buildModelArgs(selection: ModelSelection): readonly string[] {
  return ["--provider", selection.providerID, "--model", selection.modelID];
}

/** Best-effort provider credential handoff. pi's RPC mode has no documented per-run credential
 * injection channel, so a bearer header is mapped to the matching provider's well-known env var;
 * anything outside these two protocols requires the operator's own `~/.pi/agent/models.json`
 * (declared limitation, see docs/engines/pi.md). Never logged; only ever placed on the child
 * process environment. */
export function buildModelEnv(model: ResolvedModel): Record<string, string> {
  const bearer = model.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (bearer === undefined) return {};
  if (model.protocol === "anthropic-messages") {
    return { ANTHROPIC_API_KEY: bearer, ...(model.endpoint === undefined ? {} : { ANTHROPIC_BASE_URL: model.endpoint }) };
  }
  if (model.protocol === "openai-chat") {
    return { OPENAI_API_KEY: bearer, ...(model.endpoint === undefined ? {} : { OPENAI_BASE_URL: model.endpoint }) };
  }
  return {};
}
