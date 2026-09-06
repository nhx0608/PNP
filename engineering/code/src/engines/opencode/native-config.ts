import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { Json, ResolvedModel } from "../../contracts/index.ts";
import { PnpError } from "../../core/errors.ts";
import type { OpenCodeEngineConfig } from "./config.ts";

const OPENCODE_ROOT_SEGMENT = "opencode";

/**
 * Where this session's private OpenCode environment lives, and the env vars that point OpenCode there instead
 * of the operator's real profile. All paths are rooted under `EngineOpenInput.nativeDataDirectory`, never under
 * the user's workspace (`Session.directory`) and never under the gateway host's real HOME/APPDATA.
 */
export interface RedirectPlan {
  /** Env var name -> absolute private directory. Applied on top of the shared host's baseEnvironment(), which
   *  otherwise inherits the gateway's real HOME/USERPROFILE/APPDATA/LOCALAPPDATA (see src/runtime/process-host.ts). */
  env: Readonly<Record<string, string>>;
  /**
   * Candidate "config home" directories, ranked by confidence. docs/research/T03-opencode.md only confirms
   * POSIX-style config paths (`~/.config/opencode/...`); OpenCode's actual Windows path resolution (os.homedir()
   * literally joined with ".config", vs honouring XDG_CONFIG_HOME, vs a Windows-native APPDATA convention) is
   * not verified. The private opencode.json and skills are therefore mirrored under every candidate so discovery
   * does not depend on guessing correctly; see docs/engines/opencode.md for the ranked rationale.
   */
  configRoots: readonly string[];
}
export function buildRedirectPlan(nativeDataDirectory: string, config: OpenCodeEngineConfig): RedirectPlan {
  const base = path.join(nativeDataDirectory, OPENCODE_ROOT_SEGMENT);
  const env: Record<string, string> = {};
  for (const [variable, subdirectory] of Object.entries(config.redirect.variables)) {
    env[variable] = path.join(base, subdirectory);
  }
  const homeDirectory = env["HOME"] ?? path.join(base, "home");
  const xdgConfigHome = env["XDG_CONFIG_HOME"] ?? path.join(base, "xdg-config");
  const configRoots = [...new Set([path.join(homeDirectory, ".config"), xdgConfigHome])];
  return { env, configRoots };
}

function sanitizeEnvSuffix(name: string): string {
  const cleaned = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+/, "").replace(/_+$/, "");
  return cleaned.length > 0 ? cleaned : "HEADER";
}
export interface HeaderEnvMapping {
  /** Original header name -> the `$VARNAME` token to place in the generated config (never the header value). */
  configTokens: Readonly<Record<string, string>>;
  /** Env var name -> the real secret value. Only ever placed in LaunchSpec.env for the child process. */
  secretEnv: Readonly<Record<string, string>>;
  /** Env var backing the provider's `apiKey` field (reuses the Authorization header's var when present). */
  apiKeyEnvName: string;
}
/** Maps every resolved header to its own env var so the private config file never carries a literal secret. */
export function mapHeadersToEnv(headers: Readonly<Record<string, string>>, prefix: string): HeaderEnvMapping {
  const configTokens: Record<string, string> = {};
  const secretEnv: Record<string, string> = {};
  const used = new Set<string>();
  let authorizationEnvName: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    const suffix = sanitizeEnvSuffix(name);
    let envName = `${prefix}${suffix}`;
    let attempt = 2;
    while (used.has(envName)) {
      envName = `${prefix}${suffix}_${String(attempt)}`;
      attempt += 1;
    }
    used.add(envName);
    configTokens[name] = `$${envName}`;
    secretEnv[envName] = value;
    if (name.toLowerCase() === "authorization") authorizationEnvName = envName;
  }
  const apiKeyEnvName = authorizationEnvName ?? `${prefix}APIKEY_UNUSED`;
  if (authorizationEnvName === undefined) secretEnv[apiKeyEnvName] = "unused";
  return { configTokens, secretEnv, apiKeyEnvName };
}

/**
 * OpenCode provider entries pick an `@ai-sdk/*` package (docs/research/G02-internal-model-endpoint-compat.md
 * #16, T03-opencode.md #177). Only protocols with a source-confirmed mapping are supported; anything else fails
 * closed rather than guessing a wire format.
 */
const PROTOCOL_TO_PROVIDER_PACKAGE: Readonly<Record<string, string>> = {
  "openai-chat": "@ai-sdk/openai-compatible",
  "anthropic-messages": "@ai-sdk/anthropic",
};
export function resolveProviderPackage(protocol: ResolvedModel["protocol"]): string {
  const npm = PROTOCOL_TO_PROVIDER_PACKAGE[protocol];
  if (npm === undefined) {
    throw new PnpError("ENGINE_MODEL_PROTOCOL_UNSUPPORTED",
      `OpenCode Pack has no verified provider mapping for model protocol "${protocol}". Supported: ${Object.keys(PROTOCOL_TO_PROVIDER_PACKAGE).join(", ")}.`, 502);
  }
  return npm;
}

export interface NativeConfigPayload {
  json: Json;
  /** Header env vars to merge into LaunchSpec.env. Never present in `json`. */
  secretEnv: Readonly<Record<string, string>>;
}
/**
 * Builds the private opencode.json content. `apiKey` and every provider header are `$VARNAME` tokens
 * (docs/research/G02-internal-model-endpoint-compat.md #46 confirms opencode expands `$VAR` in config values);
 * the real values only ever exist in the child process's environment. `share` is pinned to "disabled": nothing
 * about a competition-session prompt should leave the host via opencode's share links.
 */
export function buildNativeConfigPayload(
  model: ResolvedModel, instructionAbsolutePaths: readonly string[], headerEnvironmentPrefix: string,
): NativeConfigPayload {
  if (model.endpoint === undefined || model.endpoint.length === 0) {
    throw new PnpError("ENGINE_MODEL_ENDPOINT_MISSING", "The resolved model has no endpoint; OpenCode requires provider.options.baseURL.", 502);
  }
  const npm = resolveProviderPackage(model.protocol);
  const headerMapping = mapHeadersToEnv(model.headers, headerEnvironmentPrefix);
  const providerId = model.selection.providerID;
  const modelId = model.selection.modelID;
  const json: Json = {
    "$schema": "https://opencode.ai/config.json",
    model: `${providerId}/${modelId}`,
    share: "disabled",
    provider: {
      [providerId]: {
        npm,
        options: {
          baseURL: model.endpoint,
          apiKey: `$${headerMapping.apiKeyEnvName}`,
          headers: { ...headerMapping.configTokens },
        },
        models: { [modelId]: {} },
      },
    },
    ...(instructionAbsolutePaths.length > 0 ? { instructions: [...instructionAbsolutePaths] } : {}),
  };
  return { json, secretEnv: headerMapping.secretEnv };
}

export interface WrittenNativeConfig {
  redirectEnv: Readonly<Record<string, string>>;
  secretEnv: Readonly<Record<string, string>>;
  /** Every path the config was mirrored to (see RedirectPlan.configRoots). */
  configPaths: readonly string[];
}
/** Ensures every redirected directory exists, then writes the private config to every candidate root. */
export async function writeNativeConfig(
  nativeDataDirectory: string, engineConfig: OpenCodeEngineConfig, model: ResolvedModel,
  instructionAbsolutePaths: readonly string[],
): Promise<WrittenNativeConfig> {
  const plan = buildRedirectPlan(nativeDataDirectory, engineConfig);
  const payload = buildNativeConfigPayload(model, instructionAbsolutePaths, engineConfig.headerEnvironmentPrefix);
  for (const directory of Object.values(plan.env)) await mkdir(directory, { recursive: true });
  const configPaths: string[] = [];
  const serialized = `${JSON.stringify(payload.json, null, 2)}\n`;
  for (const root of plan.configRoots) {
    const directory = path.join(root, OPENCODE_ROOT_SEGMENT);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "opencode.json");
    await writeFile(file, serialized, "utf8");
    configPaths.push(file);
  }
  return { redirectEnv: plan.env, secretEnv: payload.secretEnv, configPaths };
}
