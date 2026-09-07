import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthorizationDecision, IntegrationProvider, ModelSelection, ToolBinding } from "../contracts/index.ts";
import { loadPnpSettings, parseSettingsModel, parseSettingsSelection } from "../config/settings.ts";
import type { PermissionEffect, PermissionPolicy, SettingsModelDefinition } from "../config/settings.ts";
import { PnpError } from "../core/errors.ts";
import { ConfiguredIntegration, type ConfiguredModel } from "./configured/provider.ts";
import { InternalIntegration } from "./internal/provider.ts";
import { MockIntegration } from "./mock/provider.ts";

type IntegrationKind = "internal" | "configured" | "mock";
type JsonObject = Record<string, unknown>;
type Effect = PermissionEffect;
const EFFECTS: readonly Effect[] = ["allow", "deny", "ask"];
const codeRoot = fileURLToPath(new URL("../../", import.meta.url));
export const DEFAULT_CONFIGURED_PROFILE = path.join(codeRoot, "config", "competition-profile.json");

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", `${label} must be an object.`, 400);
  }
  return value as JsonObject;
}
function exactKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", `${label} contains an unknown field.`, 400);
  }
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", `${label} must be a non-empty string.`, 400);
  }
  return value;
}
function stringMap(value: unknown, label: string): Readonly<Record<string, string>> {
  const item = object(value, label);
  return Object.fromEntries(Object.entries(item).map(([name, configured]) => [
    name,
    string(configured, `${label}.${name}`),
  ]));
}
async function readJson(file: string, label: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch { throw new PnpError("INTEGRATION_CONFIG_INVALID", `${label} could not be loaded.`, 400); }
}
function modelKey(selection: ModelSelection): string {
  return `${selection.providerID}\0${selection.modelID}`;
}
function configuredModels(values: readonly SettingsModelDefinition[]): ConfiguredModel[] {
  return values.map((entry) => ({ ...entry }));
}
async function loadLegacyModelSettings(file: string): Promise<{ models: ConfiguredModel[]; defaultSelection: ModelSelection }> {
  if (!path.isAbsolute(file)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "PNP_MODEL_SETTINGS must be an absolute path.", 400);
  const settings = object(await readJson(file, "Legacy model settings"), "legacy model settings");
  exactKeys(settings, ["default", "models"], "legacy model settings");
  if (!Array.isArray(settings.models) || settings.models.length === 0) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Legacy model settings require at least one model.", 400);
  }
  const models = configuredModels(settings.models.map((entry, index) => parseSettingsModel(entry, `models[${index}]`)));
  const defaultSelection = parseSettingsSelection(settings.default, "default");
  if (new Set(models.map((entry) => modelKey(entry.selection))).size !== models.length) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Model selections must be unique.", 400);
  }
  if (!models.some((entry) => modelKey(entry.selection) === modelKey(defaultSelection))) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Default model must exist in model settings.", 400);
  }
  return { models, defaultSelection };
}
function parseLegacyModels(value: unknown): ConfiguredModel[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "At least one legacy profile model is required.", 400);
  }
  const models = configuredModels(value.map((entry, index) => parseSettingsModel(entry, `profile.models[${index}]`)));
  if (new Set(models.map((entry) => modelKey(entry.selection))).size !== models.length) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Model selections must be unique.", 400);
  }
  return models;
}
function parsePolicy(value: unknown, label: string): PermissionPolicy {
  const policy = object(value, label);
  exactKeys(policy, ["default", "operations"], label);
  const defaultEffect = string(policy.default, `${label}.default`) as Effect;
  if (!EFFECTS.includes(defaultEffect)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported default policy.", 400);
  const configuredOperations: Record<string, Effect> = {};
  for (const [operation, configured] of Object.entries(object(policy.operations, `${label}.operations`))) {
    const effect = string(configured, `${label}.operations.${operation}`) as Effect;
    if (!EFFECTS.includes(effect)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported operation policy.", 400);
    configuredOperations[operation] = effect;
  }
  return { default: defaultEffect, operations: configuredOperations };
}
function overrides(raw: string | undefined): Record<string, Effect> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new PnpError("INTEGRATION_CONFIG_INVALID", "PNP_CONFIGURED_POLICY_OVERRIDES must be valid JSON.", 400); }
  const item = object(parsed, "PNP_CONFIGURED_POLICY_OVERRIDES");
  const result: Record<string, Effect> = {};
  for (const [operation, value] of Object.entries(item)) {
    const effect = string(value, `PNP_CONFIGURED_POLICY_OVERRIDES.${operation}`) as Effect;
    if (!EFFECTS.includes(effect)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported operation policy.", 400);
    result[operation] = effect;
  }
  return result;
}
function tool(value: unknown, environment: NodeJS.ProcessEnv): ToolBinding {
  const item = object(value, "tool");
  exactKeys(item, ["id", "transport", "command", "args", "env", "sideEffect", "timeoutMs"], "tool");
  const transport = string(item.transport, "tool.transport") as ToolBinding["transport"];
  const sideEffect = string(item.sideEffect, "tool.sideEffect") as ToolBinding["sideEffect"];
  const command = string(item.command, "tool.command");
  if (!path.isAbsolute(command)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Tool command must be absolute.", 400);
  if (!["mcp-stdio", "cli", "native"].includes(transport)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported tool transport.", 400);
  if (!["read", "write", "external"].includes(sideEffect)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported tool side effect.", 400);
  if (!Array.isArray(item.args) || !item.args.every((arg) => typeof arg === "string")) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Tool args must be strings.", 400);
  }
  const resolvedEnvironment: Record<string, string> = {};
  for (const [name, variable] of Object.entries(stringMap(item.env, "tool.env"))) {
    const resolved = environment[variable];
    if (!resolved) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Required tool environment variable is absent.", 503);
    resolvedEnvironment[name] = resolved;
  }
  const timeoutMs = item.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0)) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Tool timeout must be a positive integer.", 400);
  }
  return {
    id: string(item.id, "tool.id"), transport, command, args: item.args as string[], env: resolvedEnvironment, sideEffect,
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
  };
}

export async function loadIntegration(input: {
  kind: string | undefined;
  development: boolean;
  engineDevelopmentOnly: boolean;
  engineId?: string;
  configuredProfile?: string;
  settingsPath?: string;
  /** Deprecated model-only settings file. `PNP_SETTINGS` is the unified replacement. */
  modelSettings?: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<IntegrationProvider> {
  const kind = input.kind ?? (input.engineDevelopmentOnly ? "mock" : "configured");
  if (!(["internal", "configured", "mock"] as const).includes(kind as IntegrationKind)) {
    throw new PnpError("INTEGRATION_NOT_FOUND", "Unknown integration profile.", 400);
  }
  if (kind === "internal") return new InternalIntegration();
  if (kind === "mock") {
    if (!input.development || !input.engineDevelopmentOnly) {
      throw new PnpError("MOCK_FORBIDDEN", "Mock integration requires the development mock engine.", 400);
    }
    return new MockIntegration();
  }

  const environment = input.environment ?? process.env;
  const explicitProfile = input.configuredProfile !== undefined && input.configuredProfile.trim() !== "";
  const explicitSettings = input.settingsPath !== undefined && input.settingsPath.trim() !== "";
  const profilePath = explicitProfile ? input.configuredProfile! : DEFAULT_CONFIGURED_PROFILE;
  if (!path.isAbsolute(profilePath)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "PNP_CONFIGURED_PROFILE must be an absolute path.", 400);
  const profile = object(await readJson(profilePath, "Configured integration profile"), "profile");
  exactKeys(profile, ["models", "tools", "policy"], "profile");
  const rawTools = profile.tools ?? [];
  if (!Array.isArray(rawTools)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "tools must be an array.", 400);

  const unified = await loadPnpSettings({ engineId: input.engineId ?? "", settingsPath: input.settingsPath });
  let models = configuredModels(unified.model.models);
  let defaultSelection = unified.model.default;
  let permissionPolicy = unified.permissions;

  // Existing explicit configured profiles remain a compatibility surface. Once PNP_SETTINGS is explicitly
  // supplied, the unified file is authoritative for model/permission settings and the profile contributes tools
  // only. The shipped default profile contains only tools, so normal operation has one settings source.
  if (explicitProfile && !explicitSettings) {
    if (profile.models !== undefined) {
      models = parseLegacyModels(profile.models);
      defaultSelection = models[0]!.selection;
    }
    if (profile.policy !== undefined) permissionPolicy = parsePolicy(profile.policy, "profile.policy");
  }

  // Backward compatibility for the model-only file introduced before unified settings. It is model-only and
  // intentionally cannot override permissions; new deployments should use PNP_SETTINGS instead.
  if (input.modelSettings !== undefined && input.modelSettings.trim() !== "") {
    ({ models, defaultSelection } = await loadLegacyModelSettings(input.modelSettings));
  }

  const tools = rawTools.map((value) => tool(value, environment));
  if (new Set(tools.map((entry) => entry.id)).size !== tools.length) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Tool identifiers must be unique.", 400);
  }
  const operationOverrides = overrides(environment.PNP_CONFIGURED_POLICY_OVERRIDES);
  const decide = (operation: string): AuthorizationDecision => {
    const overridden = operationOverrides[operation];
    if (overridden !== undefined) return { effect: overridden, reasonCode: "CONFIGURED_OVERRIDE" };
    const configured = permissionPolicy.operations[operation];
    if (configured !== undefined) return { effect: configured, reasonCode: "SETTINGS_OPERATION" };
    return { effect: permissionPolicy.default, reasonCode: "SETTINGS_DEFAULT" };
  };
  return new ConfiguredIntegration(
    models, tools, decide, environment, environment.PNP_MODEL_STRICT === "1", defaultSelection,
  );
}

export interface ProbeableIntegration extends IntegrationProvider { probe?(): Promise<void> }
export async function probeIntegration(provider: IntegrationProvider): Promise<void> {
  if (provider instanceof InternalIntegration) {
    throw new PnpError("INTEGRATION_UNAVAILABLE", "Internal model, tool and policy integration is not implemented; refusing to start.", 503);
  }
  const probeable = provider as ProbeableIntegration;
  if (typeof probeable.probe === "function") await probeable.probe();
}
