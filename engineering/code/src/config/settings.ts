import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelSelection, PermissionEffect, PermissionPolicy, ToolSideEffect } from "../contracts/index.ts";
import { PnpError } from "../core/errors.ts";

/** The policy and side-effect shapes are public contract; this module parses into them, never into a copy. */
export type { PermissionEffect, PermissionPolicy, ToolSideEffect };
export interface SettingsModelDefinition {
  selection: ModelSelection;
  endpoint?: string;
  endpointEnvironment?: string;
  protocol: "openai-chat" | "anthropic-messages";
  headerEnvironment: Readonly<Record<string, string>>;
}
export interface McpStdioServerSettings {
  id: string;
  transport: "stdio";
  /** Absolute path: the integration layer refuses a relative command instead of searching PATH. */
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  enabled: boolean;
  /** What the server's calls do, which is what the organizational policy judges. "external" unless declared. */
  sideEffect: ToolSideEffect;
  timeoutMs?: number;
}
export interface McpStreamableHttpServerSettings {
  id: string;
  transport: "streamable-http";
  url?: string;
  urlEnvironment?: string;
  headerEnvironment: Readonly<Record<string, string>>;
  enabled: boolean;
  sideEffect: ToolSideEffect;
  timeoutMs?: number;
}
export type McpServerSettings = McpStdioServerSettings | McpStreamableHttpServerSettings;
export interface EffectiveSettings {
  model: {
    default: ModelSelection;
    models: readonly SettingsModelDefinition[];
  };
  permissions: PermissionPolicy;
  mcp: {
    servers: readonly McpServerSettings[];
  };
}

type JsonObject = Record<string, unknown>;
const EFFECTS: readonly PermissionEffect[] = ["allow", "deny", "ask"];
const SIDE_EFFECTS: readonly ToolSideEffect[] = ["read", "write", "external"];
const codeRoot = fileURLToPath(new URL("../../", import.meta.url));
export const DEFAULT_SETTINGS = path.join(codeRoot, "config", "settings.json");

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PnpError("SETTINGS_INVALID", `${label} must be an object.`, 400);
  }
  return value as JsonObject;
}
function exactKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new PnpError("SETTINGS_INVALID", `${label} contains an unknown field.`, 400);
  }
}
function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PnpError("SETTINGS_INVALID", `${label} must be a non-empty string.`, 400);
  }
  return value;
}
function optionalStringMap(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  const item = object(value, label);
  return Object.fromEntries(Object.entries(item).map(([name, variable]) => [
    name,
    nonEmptyString(variable, `${label}.${name}`),
  ]));
}
function optionalStringArray(value: unknown, label: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new PnpError("SETTINGS_INVALID", `${label} must be an array of strings.`, 400);
  }
  return value;
}
function optionalBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new PnpError("SETTINGS_INVALID", `${label} must be a boolean.`, 400);
  return value;
}
/**
 * An MCP server that does not say what its calls do is treated as reaching outside the machine, which is the
 * strongest of the three and therefore the only safe default: a policy that asks for "external" must not be
 * bypassed by a server that simply omitted the field.
 */
function optionalSideEffect(value: unknown, label: string): ToolSideEffect {
  if (value === undefined) return "external";
  const parsed = nonEmptyString(value, label) as ToolSideEffect;
  if (!SIDE_EFFECTS.includes(parsed)) {
    throw new PnpError("SETTINGS_INVALID", `${label} must be read, write, or external.`, 400);
  }
  return parsed;
}
function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new PnpError("SETTINGS_INVALID", `${label} must be a positive integer.`, 400);
  }
  return value as number;
}
export function parseSettingsSelection(value: unknown, label = "model selection"): ModelSelection {
  const item = object(value, label);
  exactKeys(item, ["providerID", "modelID"], label);
  return {
    providerID: nonEmptyString(item.providerID, `${label}.providerID`),
    modelID: nonEmptyString(item.modelID, `${label}.modelID`),
  };
}
function headerEnvironment(value: unknown, label: string): Readonly<Record<string, string>> {
  const item = object(value, label);
  return Object.fromEntries(Object.entries(item).map(([name, variable]) => [
    name,
    nonEmptyString(variable, `${label}.${name}`),
  ]));
}
/**
 * A model declares its endpoint either literally or, like its headers, by the NAME of an
 * environment variable holding it. Exactly one form is allowed. A literal endpoint is checked
 * against the transport rule here; a variable-backed one is checked against the same rule the
 * moment it resolves (ConfiguredIntegration.endpointOf), because its value exists only in the
 * process environment.
 */
export function parseSettingsModel(value: unknown, label = "model"): SettingsModelDefinition {
  const item = object(value, label);
  exactKeys(item, ["selection", "endpoint", "endpointEnvironment", "protocol", "headerEnvironment"], label);
  const protocol = nonEmptyString(item.protocol, `${label}.protocol`);
  if (protocol !== "openai-chat" && protocol !== "anthropic-messages") {
    throw new PnpError("SETTINGS_INVALID", `${label}.protocol is unsupported.`, 400);
  }
  const hasEndpoint = Object.hasOwn(item, "endpoint");
  const hasEndpointEnvironment = Object.hasOwn(item, "endpointEnvironment");
  if (hasEndpoint === hasEndpointEnvironment) {
    throw new PnpError("SETTINGS_INVALID", `${label} needs exactly one of endpoint and endpointEnvironment.`, 400);
  }
  const common = {
    selection: parseSettingsSelection(item.selection, `${label}.selection`),
    protocol,
    headerEnvironment: headerEnvironment(item.headerEnvironment, `${label}.headerEnvironment`),
  } as const;
  if (hasEndpointEnvironment) {
    return { ...common, endpointEnvironment: nonEmptyString(item.endpointEnvironment, `${label}.endpointEnvironment`) };
  }
  const endpoint = nonEmptyString(item.endpoint, `${label}.endpoint`);
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new PnpError("SETTINGS_INVALID", `${label}.endpoint must be a valid URL.`, 400); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password) {
    throw new PnpError("SETTINGS_INVALID", `${label}.endpoint is not an approved transport.`, 400);
  }
  return { ...common, endpoint };
}

function effect(value: unknown, label: string): PermissionEffect {
  const parsed = nonEmptyString(value, label) as PermissionEffect;
  if (!EFFECTS.includes(parsed)) throw new PnpError("SETTINGS_INVALID", `${label} must be allow, deny, or ask.`, 400);
  return parsed;
}
function operations(value: unknown, label: string): Record<string, PermissionEffect> {
  if (value === undefined) return {};
  const item = object(value, label);
  return Object.fromEntries(Object.entries(item).map(([operation, configured]) => [
    operation,
    effect(configured, `${label}.${operation}`),
  ]));
}
function parseCommonPermissions(value: unknown): PermissionPolicy {
  const item = object(value, "common.permissions");
  exactKeys(item, ["default", "operations"], "common.permissions");
  return {
    default: effect(item.default, "common.permissions.default"),
    operations: operations(item.operations, "common.permissions.operations"),
  };
}
interface PartialPermissionPolicy {
  default?: PermissionEffect;
  operations: Record<string, PermissionEffect>;
}
function parseCorePermissions(value: unknown, engineId: string): PartialPermissionPolicy {
  if (value === undefined) return { operations: {} };
  const label = `cores.${engineId}.permissions`;
  const item = object(value, label);
  exactKeys(item, ["default", "operations"], label);
  return {
    ...(item.default === undefined ? {} : { default: effect(item.default, `${label}.default`) }),
    operations: operations(item.operations, `${label}.operations`),
  };
}

interface ModelSection {
  default?: ModelSelection;
  models: SettingsModelDefinition[];
}
function parseModelSection(value: unknown, label: string, requireDefault: boolean): ModelSection {
  const item = object(value, label);
  exactKeys(item, ["default", "models"], label);
  const defaultSelection = item.default === undefined ? undefined : parseSettingsSelection(item.default, `${label}.default`);
  if (requireDefault && defaultSelection === undefined) {
    throw new PnpError("SETTINGS_INVALID", `${label}.default is required.`, 400);
  }
  let models: SettingsModelDefinition[] = [];
  if (item.models !== undefined) {
    if (!Array.isArray(item.models)) throw new PnpError("SETTINGS_INVALID", `${label}.models must be an array.`, 400);
    models = item.models.map((entry, index) => parseSettingsModel(entry, `${label}.models[${index}]`));
  }
  if (requireDefault && models.length === 0) {
    throw new PnpError("SETTINGS_INVALID", `${label}.models requires at least one model.`, 400);
  }
  const keys = models.map((entry) => modelKey(entry.selection));
  if (new Set(keys).size !== keys.length) throw new PnpError("SETTINGS_INVALID", `${label}.models contains duplicate selections.`, 400);
  return { ...(defaultSelection === undefined ? {} : { default: defaultSelection }), models };
}
function modelKey(selection: ModelSelection): string {
  return `${selection.providerID}\0${selection.modelID}`;
}
function mergeModels(common: readonly SettingsModelDefinition[], core: readonly SettingsModelDefinition[]): SettingsModelDefinition[] {
  const merged = new Map(common.map((entry) => [modelKey(entry.selection), entry]));
  for (const entry of core) merged.set(modelKey(entry.selection), entry);
  return [...merged.values()];
}

function mcpServerObjects(value: unknown, label: string): JsonObject {
  if (value === undefined) return {};
  const section = object(value, label);
  exactKeys(section, ["servers"], label);
  if (section.servers === undefined) return {};
  return object(section.servers, `${label}.servers`);
}
function mergedServerObject(baseValue: unknown, overrideValue: unknown, label: string): JsonObject {
  const base = baseValue === undefined ? {} : object(baseValue, `${label}.common`);
  const override = overrideValue === undefined ? {} : object(overrideValue, `${label}.override`);
  const merged: JsonObject = { ...base, ...override };
  for (const key of ["env", "headerEnvironment"] as const) {
    if (base[key] !== undefined || override[key] !== undefined) {
      const baseMap = base[key] === undefined ? {} : object(base[key], `${label}.${key}.common`);
      const overrideMap = override[key] === undefined ? {} : object(override[key], `${label}.${key}.override`);
      merged[key] = { ...baseMap, ...overrideMap };
    }
  }
  return merged;
}
/**
 * The transport rule for a remote address, shared by a literal `url` here and by a variable-backed one
 * the integration layer resolves at load. `label` names the setting, never the value: a deployment
 * address must not reach an error message.
 */
export function validateRemoteUrl(raw: string, label: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new PnpError("SETTINGS_INVALID", `${label} must be a valid URL.`, 400); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password) {
    throw new PnpError("SETTINGS_INVALID", `${label} is not an approved transport.`, 400);
  }
  return raw;
}
function parseMcpServer(id: string, value: unknown, label: string): McpServerSettings {
  if (id.length === 0) throw new PnpError("SETTINGS_INVALID", `${label} server id must be non-empty.`, 400);
  const item = object(value, label);
  exactKeys(item, [
    "transport", "command", "args", "env", "url", "urlEnvironment", "headerEnvironment", "enabled", "sideEffect",
    "timeoutMs",
  ], label);
  const transport = nonEmptyString(item.transport, `${label}.transport`);
  const enabled = optionalBoolean(item.enabled, `${label}.enabled`, true);
  const sideEffect = optionalSideEffect(item.sideEffect, `${label}.sideEffect`);
  const timeoutMs = optionalPositiveInteger(item.timeoutMs, `${label}.timeoutMs`);
  if (transport === "stdio") {
    if (item.url !== undefined || item.urlEnvironment !== undefined || item.headerEnvironment !== undefined) {
      throw new PnpError("SETTINGS_INVALID", `${label} stdio server cannot define HTTP fields.`, 400);
    }
    const command = nonEmptyString(item.command, `${label}.command`);
    const args = optionalStringArray(item.args, `${label}.args`);
    const env = optionalStringMap(item.env, `${label}.env`);
    return {
      id, transport, command, args, env, enabled, sideEffect,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }
  if (transport === "streamable-http") {
    if (item.command !== undefined || item.args !== undefined || item.env !== undefined) {
      throw new PnpError("SETTINGS_INVALID", `${label} streamable-http server cannot define stdio fields.`, 400);
    }
    const hasUrl = Object.hasOwn(item, "url");
    const hasUrlEnvironment = Object.hasOwn(item, "urlEnvironment");
    if (hasUrl === hasUrlEnvironment) {
      throw new PnpError("SETTINGS_INVALID", `${label} needs exactly one of url and urlEnvironment.`, 400);
    }
    const headerEnv = optionalStringMap(item.headerEnvironment, `${label}.headerEnvironment`);
    if (hasUrlEnvironment) {
      return {
        id, transport, urlEnvironment: nonEmptyString(item.urlEnvironment, `${label}.urlEnvironment`),
        headerEnvironment: headerEnv, enabled, sideEffect,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      };
    }
    return {
      id, transport, url: validateRemoteUrl(nonEmptyString(item.url, `${label}.url`), `${label}.url`),
      headerEnvironment: headerEnv, enabled, sideEffect,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }
  throw new PnpError("SETTINGS_INVALID", `${label}.transport must be stdio or streamable-http.`, 400);
}
function resolveMcp(commonValue: unknown, coreValue: unknown, engineId: string): McpServerSettings[] {
  const commonServers = mcpServerObjects(commonValue, "common.mcp");
  const coreServers = mcpServerObjects(coreValue, `cores.${engineId}.mcp`);
  const ids = [...new Set([...Object.keys(commonServers), ...Object.keys(coreServers)])];
  return ids.map((id) => parseMcpServer(
    id,
    mergedServerObject(commonServers[id], coreServers[id], `mcp.servers.${id}`),
    `effective.mcp.servers.${id}`,
  ));
}

async function readSettingsFile(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch { throw new PnpError("SETTINGS_INVALID", "PNP settings could not be loaded.", 400); }
}
function settingsPath(explicit: string | undefined): string {
  if (explicit === undefined || explicit.trim() === "") return DEFAULT_SETTINGS;
  if (!path.isAbsolute(explicit)) throw new PnpError("SETTINGS_INVALID", "PNP_SETTINGS must be an absolute path.", 400);
  return explicit;
}

/**
 * Resolves one effective runtime settings view for an Engine Core. `common` is the baseline; the selected
 * `cores.<engineId>` section is an additive override. Model definitions with the same provider/model key replace
 * their common definition, permission operations merge by operation name, and MCP servers merge by server id.
 * A Core can therefore disable or partially override a common MCP server without copying the whole definition.
 * This layer preserves environment-variable NAMES; it never resolves model or MCP secrets.
 */
export async function loadPnpSettings(input: { engineId: string; settingsPath?: string }): Promise<EffectiveSettings> {
  const file = settingsPath(input.settingsPath);
  const root = object(await readSettingsFile(file), "settings");
  exactKeys(root, ["version", "common", "cores"], "settings");
  if (root.version !== 1) throw new PnpError("SETTINGS_INVALID", "settings.version must be 1.", 400);

  const common = object(root.common, "common");
  exactKeys(common, ["model", "permissions", "mcp"], "common");
  const commonModel = parseModelSection(common.model, "common.model", true);
  const commonPermissions = parseCommonPermissions(common.permissions);

  const cores = object(root.cores, "cores");
  for (const [engineId, value] of Object.entries(cores)) {
    const core = object(value, `cores.${engineId}`);
    exactKeys(core, ["model", "permissions", "mcp"], `cores.${engineId}`);
    if (core.model !== undefined) parseModelSection(core.model, `cores.${engineId}.model`, false);
    parseCorePermissions(core.permissions, engineId);
    resolveMcp(common.mcp, core.mcp, engineId);
  }

  const selected = cores[input.engineId] === undefined ? undefined : object(cores[input.engineId], `cores.${input.engineId}`);
  const coreModel = selected?.model === undefined ? { models: [] } : parseModelSection(selected.model, `cores.${input.engineId}.model`, false);
  const corePermissions = parseCorePermissions(selected?.permissions, input.engineId);
  const models = mergeModels(commonModel.models, coreModel.models);
  const defaultSelection = coreModel.default ?? commonModel.default;
  if (defaultSelection === undefined || !models.some((entry) => modelKey(entry.selection) === modelKey(defaultSelection))) {
    throw new PnpError("SETTINGS_INVALID", `Effective default model for ${input.engineId} is not configured.`, 400);
  }

  return {
    model: { default: defaultSelection, models },
    permissions: {
      default: corePermissions.default ?? commonPermissions.default,
      operations: { ...commonPermissions.operations, ...corePermissions.operations },
    },
    mcp: { servers: resolveMcp(common.mcp, selected?.mcp, input.engineId) },
  };
}
