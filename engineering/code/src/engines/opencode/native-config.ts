import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { Json, PermissionEffect, PermissionPolicy, ResolvedModel } from "../../contracts/index.ts";
import { PnpError } from "../../core/errors.ts";
import type { OpenCodeEngineConfig, OpenCodeNativePermissions } from "./config.ts";

const OPENCODE_ROOT_SEGMENT = "opencode";
const NATIVE_CONFIG_FILENAME = "opencode.json";
export const OPENCODE_CONFIG_ENVIRONMENT_VARIABLE = "OPENCODE_CONFIG";
const ALLOW_ALL: PermissionPolicy = { default: "allow", operations: {} };

export function environmentToken(variableName: string): string {
  return `{env:${variableName}}`;
}

export interface RedirectPlan {
  env: Readonly<Record<string, string>>;
  configFile: string;
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
const BEARER_SCHEME = /^bearer\s+/i;

export interface HeaderEnvMapping {
  configTokens: Readonly<Record<string, string>>;
  secretEnv: Readonly<Record<string, string>>;
  apiKeyEnvName: string;
  apiKeySource: "bearer-token" | "placeholder";
}
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

/**
 * PNP permissions are resolved before the Engine Pack. OpenCode still needs a native permission block for any
 * operation that must reach the gateway: without it OpenCode's own default is allow, so the gateway would never
 * get a chance to apply an `ask` or `deny` policy. A PNP deny is therefore projected as native `ask`; the gateway
 * remains the authority and returns the denial. Core-specific operation names are preferred. A few stable aliases
 * are mapped to OpenCode's names so common settings can cover the obvious file/shell cases.
 */
function openCodePermissionName(operation: string): string {
  const aliases: Readonly<Record<string, string>> = {
    write: "edit",
    patch: "edit",
    "file.write": "edit",
    "file.read": "read",
    shell: "bash",
    "shell.execute": "bash",
    "web.fetch": "webfetch",
    "web.search": "websearch",
    subagent: "task",
  };
  return aliases[operation] ?? operation;
}
function nativeEffect(effect: PermissionEffect): "allow" | "ask" {
  return effect === "allow" ? "allow" : "ask";
}
export function buildNativePermissionConfig(
  policy: PermissionPolicy,
  legacyNativePermissions: OpenCodeNativePermissions = "engine-default",
): Json | undefined {
  const projected: Record<string, "allow" | "ask"> = {};
  if (policy.default !== "allow") projected["*"] = "ask";
  for (const [operation, effect] of Object.entries(policy.operations)) {
    const name = openCodePermissionName(operation);
    const value = nativeEffect(effect);
    if (policy.default === "allow" && value === "allow") continue;
    const existing = projected[name];
    projected[name] = existing === "ask" || value === "ask" ? "ask" : "allow";
  }
  // Compatibility with the old deployment switch. It can force prompts on, but it can no longer turn off
  // prompts required by unified settings.
  if (legacyNativePermissions === "ask") {
    projected.edit = "ask";
    projected.bash = "ask";
  }
  return Object.keys(projected).length === 0 ? undefined : projected;
}

export interface NativeConfigPayload {
  json: Json;
  secretEnv: Readonly<Record<string, string>>;
}
export function buildNativeConfigPayload(
  model: ResolvedModel,
  instructionAbsolutePaths: readonly string[],
  headerEnvironmentPrefix: string,
  nativePermissions: OpenCodeNativePermissions = "engine-default",
  permissionPolicy: PermissionPolicy = ALLOW_ALL,
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
  const permission = buildNativePermissionConfig(permissionPolicy, nativePermissions);
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
    ...(permission === undefined ? {} : { permission }),
    ...(instructionAbsolutePaths.length > 0 ? { instructions: [...instructionAbsolutePaths] } : {}),
  };
  return { json, secretEnv: headerMapping.secretEnv };
}

export interface WrittenNativeConfig {
  redirectEnv: Readonly<Record<string, string>>;
  secretEnv: Readonly<Record<string, string>>;
  primaryConfigPath: string;
  configPaths: readonly string[];
}
export async function writeNativeConfig(
  nativeDataDirectory: string,
  engineConfig: OpenCodeEngineConfig,
  model: ResolvedModel,
  instructionAbsolutePaths: readonly string[],
  permissionPolicy: PermissionPolicy = ALLOW_ALL,
): Promise<WrittenNativeConfig> {
  const plan = buildRedirectPlan(nativeDataDirectory, engineConfig);
  const payload = buildNativeConfigPayload(
    model,
    instructionAbsolutePaths,
    engineConfig.headerEnvironmentPrefix,
    engineConfig.nativePermissions,
    permissionPolicy,
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
