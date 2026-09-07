import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  /** Session-private `PI_CODING_AGENT_DIR` target (verified: real pi 0.85.1 uses this env var
   * verbatim as its whole config root — default `~/.pi/agent` — instead of an additive layer,
   * so pointing it here keeps this session's credentials off the operator's real pi config and
   * off every other concurrent session on the same host). */
  readonly agentConfigDir: string;
  readonly modelsConfigFile: string;
}
export function resolveSessionPaths(nativeDataDirectory: string): PiSessionPaths {
  const agentConfigDir = path.join(nativeDataDirectory, "pi-agent");
  return {
    sessionDir: nativeDataDirectory,
    sessionFile: path.join(nativeDataDirectory, "session.jsonl"),
    toolsFile: path.join(nativeDataDirectory, "pnp-tools.json"),
    extensionFile: path.join(nativeDataDirectory, "pnp-tool-bridge.mjs"),
    agentConfigDir,
    modelsConfigFile: path.join(agentConfigDir, "models.json"),
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
    env: { ...baseEnvironment(), PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: input.paths.agentConfigDir },
    sessionId: input.sessionId,
    ownerToken: input.ownerToken,
  };
}

/** `--provider`/`--model` are the documented pi CLI selectors (docs/research/T02-pi-harness.md
 * §"接入方式选择"), verified against real pi 0.85.1 together with `writePiModelsConfig` below. */
export function buildModelArgs(selection: ModelSelection): readonly string[] {
  return ["--provider", selection.providerID, "--model", selection.modelID];
}

/** Maps a `ResolvedModel.protocol` to pi's `models.json` "api" enum (`packages/coding-agent/
 * docs/models.md` "Supported APIs"; verified against real pi 0.85.1 — see `docs/engines/pi.md`).
 * "custom"/"test" have no pi-compatible wire format, so `writePiModelsConfig` writes no provider
 * entry for them instead of guessing; a real pi process then only has its own built-ins to work
 * with, and a genuinely misconfigured run fails loudly at pi startup rather than silently. */
function piApiFor(protocol: ResolvedModel["protocol"]): "openai-completions" | "anthropic-messages" | undefined {
  if (protocol === "openai-chat") return "openai-completions";
  if (protocol === "anthropic-messages") return "anthropic-messages";
  return undefined;
}
interface PiProviderConfig {
  readonly api: "openai-completions" | "anthropic-messages";
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly models: readonly { readonly id: string }[];
}
interface PiModelsConfigFile { providers: Record<string, PiProviderConfig> }

/**
 * Declares `model` as a pi custom provider in this session's private `models.json` (read by pi
 * via `PI_CODING_AGENT_DIR`, see `buildLaunchSpec`). This is pi's only documented mechanism for
 * pointing a provider at an arbitrary internal `baseUrl` plus bearer credential — there is no
 * generic `*_BASE_URL` environment override outside the Azure OpenAI provider (verified: a real
 * pi 0.85.1 process launched with `OPENAI_BASE_URL` pointed at a local mock server ignored it
 * and called the real `api.openai.com` instead; only `models.json` actually redirected traffic).
 * Called both when a session opens (initial model) and before `set_model` (model switch), and
 * merges into any existing file instead of overwriting it so an earlier model's provider entry
 * survives a later switch within the same session. Never logs the resolved credential; only ever
 * written to a `0600` file under this session's own native data directory. */
export async function writePiModelsConfig(paths: PiSessionPaths, model: ResolvedModel): Promise<void> {
  // Always ensured, even for a protocol with no pi mapping below: `PI_CODING_AGENT_DIR` (set to
  // this same directory in `buildLaunchSpec`) should point at a real directory before pi starts,
  // rather than relying on pi to create a missing config root itself.
  await mkdir(paths.agentConfigDir, { recursive: true });
  const api = piApiFor(model.protocol);
  if (api === undefined) return; // Declared limitation: no pi transport for this protocol.
  const bearer = model.headers.authorization?.replace(/^Bearer\s+/i, "");
  const provider: PiProviderConfig = {
    api, apiKey: bearer ?? "pnp-unused", // Placeholder mirrors pi's own docs for keyless local servers.
    ...(model.endpoint === undefined ? {} : { baseUrl: model.endpoint }),
    models: [{ id: model.selection.modelID }],
  };
  let config: PiModelsConfigFile = { providers: {} };
  try {
    const parsed: unknown = JSON.parse(await readFile(paths.modelsConfigFile, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const providers = (parsed as { providers?: unknown }).providers;
      if (providers !== null && typeof providers === "object" && !Array.isArray(providers)) {
        config = { providers: { ...(providers as Record<string, PiProviderConfig>) } };
      }
    }
  } catch { /* First write for this session, or a corrupt file this write is about to replace. */ }
  config.providers[model.selection.providerID] = provider;
  await writeFile(paths.modelsConfigFile, JSON.stringify(config, null, 2), { mode: 0o600 });
}
