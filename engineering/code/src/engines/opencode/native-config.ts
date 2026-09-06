import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { Json, ResolvedModel } from "../../contracts/index.ts";
import { PnpError } from "../../core/errors.ts";
import type { OpenCodeEngineConfig, OpenCodeNativePermissions } from "./config.ts";

const OPENCODE_ROOT_SEGMENT = "opencode";
const NATIVE_CONFIG_FILENAME = "opencode.json";
/**
 * OpenCode's documented "custom path" discovery step (opencode.ai/docs/config/): it names one exact file and
 * needs no guess about where a config home lives on Windows. Confirmed honoured by a real opencode 1.18.29
 * process. This is the primary route to the private config; the mirrored config homes are only a fallback.
 */
export const OPENCODE_CONFIG_ENVIRONMENT_VARIABLE = "OPENCODE_CONFIG";

/** Environment-variable substitution understood by OpenCode's config loader. `$VAR` is NOT expanded. */
export function environmentToken(variableName: string): string {
  return `{env:${variableName}}`;
}

/**
 * Where this session's private OpenCode environment lives, and the env vars that point OpenCode there instead
 * of the operator's real profile. All paths are rooted under `EngineOpenInput.nativeDataDirectory`, never under
 * the user's workspace (`Session.directory`) and never under the gateway host's real HOME/APPDATA.
 */
export interface RedirectPlan {
  /** Env var name -> absolute private directory. Applied on top of the shared host's baseEnvironment(), which
   *  otherwise inherits the gateway's real HOME/USERPROFILE/APPDATA/LOCALAPPDATA (see src/runtime/process-host.ts). */
  env: Readonly<Record<string, string>>;
  /** The one deterministic file OPENCODE_CONFIG points at. Discovery does not depend on guessing a config home. */
  configFile: string;
  /**
   * Fallback "config home" directories the same content is mirrored into. OpenCode's documented discovery order
   * is remote `.well-known` -> global `~/.config/opencode/opencode.json` -> `OPENCODE_CONFIG` -> project
   * `opencode.json` -> `.opencode` -> `OPENCODE_CONFIG_CONTENT` -> managed `%ProgramData%\opencode`; neither
   * XDG_CONFIG_HOME nor %APPDATA% appears in it. The global entry is what these mirrors cover (HOME is
   * redirected, so `~` is private), and the XDG mirror costs one extra file for the case where the loader turns
   * out to honour XDG_CONFIG_HOME after all. See docs/engines/opencode.md section 3.
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
  return { env, configFile: path.join(base, NATIVE_CONFIG_FILENAME), configRoots };
}

function sanitizeEnvSuffix(name: string): string {
  const cleaned = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+/, "").replace(/_+$/, "");
  return cleaned.length > 0 ? cleaned : "HEADER";
}
/** `Bearer <token>`, case-insensitive, with the separating whitespace consumed. */
const BEARER_SCHEME = /^bearer\s+/i;

export interface HeaderEnvMapping {
  /** Original header name -> the `{env:VARNAME}` token for `options.headers` (never the header value). */
  configTokens: Readonly<Record<string, string>>;
  /** Env var name -> the real secret value. Only ever placed in LaunchSpec.env for the child process. */
  secretEnv: Readonly<Record<string, string>>;
  /** Env var backing the provider's `options.apiKey` field. */
  apiKeyEnvName: string;
  /** Whether apiKey carries a real credential or a non-secret placeholder. */
  apiKeySource: "bearer-token" | "placeholder";
}
/**
 * Maps every resolved header to its own env var so the private config file never carries a literal secret.
 *
 * `Authorization: Bearer <token>` is special-cased, and the reason is measured, not theoretical: the
 * `@ai-sdk/openai-compatible` provider composes `Authorization: Bearer <apiKey>` itself. Feeding it the whole
 * header value produced `Authorization: Bearer Bearer <token>` on the wire against a real opencode 1.18.29 run.
 * So the bearer prefix is stripped, the bare token backs `options.apiKey`, and no `Authorization` entry is
 * emitted in `options.headers` -- the provider writes that header, and a duplicate would fight it.
 *
 * An `Authorization` header with any other scheme is left as an ordinary header (`{env:}` in `options.headers`)
 * and apiKey keeps its non-secret placeholder: that route has not been observed end to end, so it fails visibly
 * rather than silently mangling a credential.
 */
export function mapHeadersToEnv(headers: Readonly<Record<string, string>>, prefix: string): HeaderEnvMapping {
  const configTokens: Record<string, string> = {};
  const secretEnv: Record<string, string> = {};
  const used = new Set<string>();
  const allocate = (suffix: string): string => {
    let envName = `${prefix}${suffix}`;
    let attempt = 2;
    while (used.has(envName)) {
      envName = `${prefix}${suffix}_${String(attempt)}`;
      attempt += 1;
    }
    used.add(envName);
    return envName;
  };
  let apiKeyEnvName: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "authorization" && apiKeyEnvName === undefined) {
      const scheme = BEARER_SCHEME.exec(value);
      if (scheme !== null) {
        apiKeyEnvName = allocate("API_KEY");
        secretEnv[apiKeyEnvName] = value.slice(scheme[0].length);
        continue;
      }
    }
    const envName = allocate(sanitizeEnvSuffix(name));
    configTokens[name] = environmentToken(envName);
    secretEnv[envName] = value;
  }
  if (apiKeyEnvName !== undefined) return { configTokens, secretEnv, apiKeyEnvName, apiKeySource: "bearer-token" };
  const placeholder = allocate("APIKEY_UNUSED");
  secretEnv[placeholder] = "unused";
  return { configTokens, secretEnv, apiKeyEnvName: placeholder, apiKeySource: "placeholder" };
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
 * Builds the private opencode.json content. `apiKey` and every provider header are `{env:VARNAME}` tokens --
 * the substitution syntax OpenCode actually implements; `$VAR` is passed through literally and would ship a
 * useless string to the model endpoint. The real values only ever exist in the child process's environment.
 *
 * A custom OpenAI-compatible provider requires `npm`, a display `name`, `options.baseURL` and a display `name`
 * on each model, so all four are written. `share` is pinned to "disabled": nothing about a competition-session
 * prompt should leave the host via opencode's share links. `permission` is written only when the operator asked
 * for it (nativePermissions "ask"); OpenCode allows everything by default, and without that block it never
 * raises ACP `session/request_permission` at all.
 */
export function buildNativeConfigPayload(
  model: ResolvedModel, instructionAbsolutePaths: readonly string[], headerEnvironmentPrefix: string,
  nativePermissions: OpenCodeNativePermissions = "engine-default",
): NativeConfigPayload {
  if (model.endpoint === undefined || model.endpoint.length === 0) {
    throw new PnpError("ENGINE_MODEL_ENDPOINT_MISSING", "The resolved model has no endpoint; OpenCode requires provider.options.baseURL.", 502);
  }
  const npm = resolveProviderPackage(model.protocol);
  const headerMapping = mapHeadersToEnv(model.headers, headerEnvironmentPrefix);
  const providerId = model.selection.providerID;
  const modelId = model.selection.modelID;
  const options: Json = {
    baseURL: model.endpoint,
    apiKey: environmentToken(headerMapping.apiKeyEnvName),
    ...(Object.keys(headerMapping.configTokens).length > 0 ? { headers: { ...headerMapping.configTokens } } : {}),
  };
  const json: Json = {
    "$schema": "https://opencode.ai/config.json",
    model: `${providerId}/${modelId}`,
    share: "disabled",
    provider: {
      [providerId]: {
        npm,
        name: `PNP ${providerId}`,
        options,
        models: { [modelId]: { name: modelId } },
      },
    },
    ...(nativePermissions === "ask" ? { permission: { edit: "ask", bash: "ask" } } : {}),
    ...(instructionAbsolutePaths.length > 0 ? { instructions: [...instructionAbsolutePaths] } : {}),
  };
  return { json, secretEnv: headerMapping.secretEnv };
}

export interface WrittenNativeConfig {
  /** Redirect variables plus OPENCODE_CONFIG, which names primaryConfigPath. */
  redirectEnv: Readonly<Record<string, string>>;
  secretEnv: Readonly<Record<string, string>>;
  /** The file OPENCODE_CONFIG points at. */
  primaryConfigPath: string;
  /** Every path the config was written to: primaryConfigPath first, then the fallback mirrors. */
  configPaths: readonly string[];
}
/**
 * Ensures every redirected directory exists, writes the private config to the deterministic OPENCODE_CONFIG
 * path, and mirrors identical content into the fallback config homes.
 */
export async function writeNativeConfig(
  nativeDataDirectory: string, engineConfig: OpenCodeEngineConfig, model: ResolvedModel,
  instructionAbsolutePaths: readonly string[],
): Promise<WrittenNativeConfig> {
  const plan = buildRedirectPlan(nativeDataDirectory, engineConfig);
  const payload = buildNativeConfigPayload(
    model, instructionAbsolutePaths, engineConfig.headerEnvironmentPrefix, engineConfig.nativePermissions,
  );
  for (const directory of Object.values(plan.env)) await mkdir(directory, { recursive: true });
  const serialized = `${JSON.stringify(payload.json, null, 2)}\n`;
  await mkdir(path.dirname(plan.configFile), { recursive: true });
  await writeFile(plan.configFile, serialized, "utf8");
  const configPaths: string[] = [plan.configFile];
  for (const root of plan.configRoots) {
    const directory = path.join(root, OPENCODE_ROOT_SEGMENT);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, NATIVE_CONFIG_FILENAME);
    await writeFile(file, serialized, "utf8");
    configPaths.push(file);
  }
  return {
    redirectEnv: { ...plan.env, [OPENCODE_CONFIG_ENVIRONMENT_VARIABLE]: plan.configFile },
    secretEnv: payload.secretEnv,
    primaryConfigPath: plan.configFile,
    configPaths,
  };
}
