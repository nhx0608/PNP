import { access, readFile, realpath, stat, readdir, lstat, readlink } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Json, ModelSelection, PermissionEffect, PermissionPolicy, ToolSideEffect } from "../contracts/index.ts";
import { PnpError } from "../core/errors.ts";

/** The policy and side-effect shapes are public contract; this module parses into them, never into a copy. */
export type { PermissionEffect, PermissionPolicy, ToolSideEffect };
export interface SettingsModelDefinition {
  selection: ModelSelection;
  endpoint?: string;
  endpointEnvironment?: string;
  protocol: "openai-chat" | "anthropic-messages";
  /** Request header name -> environment variable NAME. Every variable named here is required. */
  headerEnvironment: Readonly<Record<string, string>>;
  /** Variable holding the model name the endpoint expects; it replaces `selection.modelID` at load. */
  modelIDEnvironment?: string;
  /** Variable holding a bare credential, sent as `Authorization: Bearer <value>` when nothing else set one. */
  apiKeyEnvironment?: string;
  /** Variable holding a JSON object of additional request headers (an appid header, for instance). */
  headersEnvironment?: string;
  /** Variable holding the path of a PEM bundle; a relative path resolves against the package root. */
  caFileEnvironment?: string;
}
/** A `model.default` entry: `modelID` may be omitted when the provider has exactly one model. */
export interface SettingsDefaultSelection {
  providerID: string;
  modelID?: string;
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
export interface AssetEntry {
  id: string;
  kind: string;
  path: string;
  layout: "file" | "directory";
  entry?: string;
  required: boolean;
  enabled: boolean;
  engines?: readonly string[];
  parameters?: Json;
  permitted?: boolean;
}
export interface PackSelection {
  id: string;
  enabled: boolean;
  required: boolean;
  root?: string;
  permitNativeExtensions: boolean;
  contributions: Record<string, Record<string, Partial<Pick<AssetEntry, "enabled" | "required" | "parameters">>>>;
}
export interface AssetRoot { name: string; path: string }
export interface SettingsProblem {
  severity: "error" | "warning";
  path: string;
  code: string;
  message: string;
}
export interface SettingsDocumentOptions {
  engineId: string;
  settingsDirectory: string;
  environment?: NodeJS.ProcessEnv;
}
export interface SettingsDocumentValidation {
  ok: boolean;
  problems: SettingsProblem[];
  effective?: EffectiveSettings;
}
export interface EffectiveSettings {
  model: {
    default: ModelSelection;
    models: readonly SettingsModelDefinition[];
  };
  permissions: PermissionPolicy;
  /** Instruction files for this Core, absolute and readable, in declaration order. */
  instructions: readonly string[];
  mcp: {
    servers: readonly McpServerSettings[];
  };
  skills: readonly AssetEntry[];
  assets: Record<string, Record<string, AssetEntry>>;
  packs: readonly PackSelection[];
  native: Record<string, Json>;
  assetRoots: readonly AssetRoot[];
}

type JsonObject = Record<string, unknown>;
const EFFECTS: readonly PermissionEffect[] = ["allow", "deny", "ask"];
const SIDE_EFFECTS: readonly ToolSideEffect[] = ["read", "write", "external"];
/** `src/config/` in the source tree and `dist/config/` in a build both sit one level below the
 *  package root, so this is the directory holding package.json in either shape. It comes from this
 *  module's own location, never from the working directory a launcher happened to start in. */
export const CODE_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const DEFAULT_SETTINGS = path.join(CODE_ROOT, "config", "settings.json");
/**
 * A path a deployment supplies may be written relative to the package root, the one directory it
 * can name without knowing where the delivery was unpacked; an absolute path is used as given. An
 * empty or whitespace-only value is not a path at all, and every caller treats it as unset rather
 * than letting it resolve to the package root itself.
 */
export function resolveCodePath(value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(CODE_ROOT, value);
}
/**
 * The transport rule shared by model endpoints and remote MCP servers: `https` anywhere, `http` on
 * loopback, and never credentials in the URL. An intranet endpoint that only speaks plain HTTP is a
 * deployment decision rather than a default, so one switch — `PNP_ALLOW_HTTP_ENDPOINTS=1` — opens it
 * for both kinds of address at once instead of leaving two half-configured surfaces.
 */
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
export function isApprovedEndpoint(url: URL, environment: NodeJS.ProcessEnv = process.env): boolean {
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return LOOPBACK.includes(url.hostname) || environment.PNP_ALLOW_HTTP_ENDPOINTS === "1";
}
/**
 * The two placeholders a settings file may use where a path is required: the package root, so the
 * shipped file can point at a tool inside the delivery without knowing where it was unpacked, and
 * the running Node executable, so it can start one without a PATH lookup. Anything else is refused
 * rather than passed through — a credential belongs in `env`/`headerEnvironment` by variable name,
 * never expanded into a command line.
 */
function expandPlaceholders(value: string, label: string): string {
  return value.replace(/\$\{([^}]*)\}/g, (_match, name: string) => {
    if (name === "PNP_CODE_ROOT") return CODE_ROOT;
    if (name === "PNP_NODE") return process.execPath;
    throw new PnpError("SETTINGS_INVALID", `${label} uses an unsupported placeholder \${${name}}.`, 400);
  });
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PnpError("SETTINGS_INVALID", `${label} must be an object.`, 400);
  }
  return value as JsonObject;
}
function exactKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new PnpError("SETTINGS_INVALID", `${label}.${unknown} is an unknown field.`, 400);
  }
}
function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PnpError("SETTINGS_INVALID", `${label} must be a non-empty string.`, 400);
  }
  return value;
}
/**
 * A slot that holds the NAME of an environment variable, never its value. Enforcing the identifier
 * shape here is what makes that claim checkable: a deployment that pastes a secret where a name
 * belongs is refused at load with the field's path, instead of storing the secret in settings.json
 * and having every reader treat it as a variable that simply happens not to exist.
 */
function variableName(value: unknown, label: string): string {
  const name = nonEmptyString(value, label);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new PnpError("SETTINGS_INVALID", `${label} must name an environment variable, not hold its value.`, 400);
  }
  return name;
}
function optionalStringMap(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  const item = object(value, label);
  return Object.fromEntries(Object.entries(item).map(([name, variable]) => [
    name,
    variableName(variable, `${label}.${name}`),
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
/**
 * The default may name only its provider. A deployment that ships one model per provider then says
 * so once, instead of repeating an identifier that the environment replaces at load anyway
 * (`modelIDEnvironment`). Which entry it means is decided against the effective catalog, not here.
 */
function parseDefaultSelection(value: unknown, label: string): SettingsDefaultSelection {
  const item = object(value, label);
  exactKeys(item, ["providerID", "modelID"], label);
  const providerID = nonEmptyString(item.providerID, `${label}.providerID`);
  if (!Object.hasOwn(item, "modelID")) return { providerID };
  return { providerID, modelID: nonEmptyString(item.modelID, `${label}.modelID`) };
}
function headerEnvironment(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  const item = object(value, label);
  const headerName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  const parsed: Record<string, string> = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();
  for (const [name, variable] of Object.entries(item)) {
    const normalized = name.toLowerCase();
    if (!headerName.test(name) || seen.has(normalized)) {
      throw new PnpError("SETTINGS_INVALID", `${label} contains an invalid or duplicate HTTP header name.`, 400);
    }
    seen.add(normalized);
    parsed[name] = variableName(variable, `${label}.${name}`);
  }
  // Collected on a null prototype so a header literally named __proto__ becomes an own property
  // instead of reaching Object.prototype; spread hands back an ordinary object, because every
  // existing caller (and test) compares this map against a plain object literal.
  return { ...parsed };
}
/**
 * A model declares its endpoint either literally or, like its headers, by the NAME of an
 * environment variable holding it. Exactly one form is allowed. A literal endpoint is checked
 * against the transport rule here; a variable-backed one is checked against the same rule the
 * moment it resolves (ConfiguredIntegration.endpointOf), because its value exists only in the
 * process environment.
 */
export function parseSettingsModel(
  value: unknown, label = "model", environment: NodeJS.ProcessEnv = process.env,
): SettingsModelDefinition {
  const item = object(value, label);
  exactKeys(item, [
    "selection", "endpoint", "endpointEnvironment", "protocol", "headerEnvironment",
    "modelIDEnvironment", "apiKeyEnvironment", "headersEnvironment", "caFileEnvironment",
  ], label);
  const protocol = nonEmptyString(item.protocol, `${label}.protocol`);
  if (protocol !== "openai-chat" && protocol !== "anthropic-messages") {
    throw new PnpError("SETTINGS_INVALID", `${label}.protocol is unsupported.`, 400);
  }
  const hasEndpoint = Object.hasOwn(item, "endpoint");
  const hasEndpointEnvironment = Object.hasOwn(item, "endpointEnvironment");
  if (hasEndpoint === hasEndpointEnvironment) {
    throw new PnpError("SETTINGS_INVALID", `${label} needs exactly one of endpoint and endpointEnvironment.`, 400);
  }
  const modelIDEnvironment = item.modelIDEnvironment;
  const apiKeyEnvironment = item.apiKeyEnvironment;
  const headersEnvironment = item.headersEnvironment;
  const caFileEnvironment = item.caFileEnvironment;
  const common = {
    selection: parseSettingsSelection(item.selection, `${label}.selection`),
    protocol,
    headerEnvironment: headerEnvironment(item.headerEnvironment, `${label}.headerEnvironment`),
    ...(modelIDEnvironment === undefined ? {} : { modelIDEnvironment: variableName(modelIDEnvironment, `${label}.modelIDEnvironment`) }),
    ...(apiKeyEnvironment === undefined ? {} : { apiKeyEnvironment: variableName(apiKeyEnvironment, `${label}.apiKeyEnvironment`) }),
    ...(headersEnvironment === undefined ? {} : { headersEnvironment: variableName(headersEnvironment, `${label}.headersEnvironment`) }),
    ...(caFileEnvironment === undefined ? {} : { caFileEnvironment: variableName(caFileEnvironment, `${label}.caFileEnvironment`) }),
  } as const;
  if (hasEndpointEnvironment) {
    return { ...common, endpointEnvironment: variableName(item.endpointEnvironment, `${label}.endpointEnvironment`) };
  }
  const endpoint = nonEmptyString(item.endpoint, `${label}.endpoint`);
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new PnpError("SETTINGS_INVALID", `${label}.endpoint must be a valid URL.`, 400); }
  if (!isApprovedEndpoint(url, environment)) {
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
  default?: SettingsDefaultSelection;
  models: SettingsModelDefinition[];
}
function parseModelSection(
  value: unknown, label: string, requireDefault: boolean, environment: NodeJS.ProcessEnv,
): ModelSection {
  const item = object(value, label);
  exactKeys(item, ["default", "models"], label);
  const defaultSelection = item.default === undefined ? undefined : parseDefaultSelection(item.default, `${label}.default`);
  if (requireDefault && defaultSelection === undefined) {
    throw new PnpError("SETTINGS_INVALID", `${label}.default is required.`, 400);
  }
  let models: SettingsModelDefinition[] = [];
  if (item.models !== undefined) {
    if (!Array.isArray(item.models)) throw new PnpError("SETTINGS_INVALID", `${label}.models must be an array.`, 400);
    models = item.models.map((entry, index) => parseSettingsModel(entry, `${label}.models[${index}]`, environment));
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
/**
 * The effective default as one concrete selection. A default that names only its provider means the
 * single entry that provider has: with none there is nothing to run, and with several the file has
 * not said which, and guessing would silently bind a deployment to whichever entry was listed first.
 */
function resolveDefaultSelection(
  selection: SettingsDefaultSelection, models: readonly SettingsModelDefinition[], engineId: string,
): ModelSelection {
  if (selection.modelID !== undefined) {
    const wanted = { providerID: selection.providerID, modelID: selection.modelID };
    if (!models.some((entry) => modelKey(entry.selection) === modelKey(wanted))) {
      throw new PnpError("SETTINGS_INVALID", `Effective default model for ${engineId} is not configured.`, 400);
    }
    return wanted;
  }
  const candidates = models.filter((entry) => entry.selection.providerID === selection.providerID);
  if (candidates.length !== 1) {
    throw new PnpError("SETTINGS_INVALID",
      `Effective default model for ${engineId} names a provider with ${candidates.length} models; name modelID.`, 400);
  }
  return { ...candidates[0]!.selection };
}
/**
 * Instruction files, in declaration order, as absolute paths. They are written relative to the
 * directory holding the settings file — the file and the text it points at travel together — and an
 * absolute path is honoured for a deployment that keeps its instructions elsewhere. A Core's list
 * REPLACES the common one rather than extending it, so a Core can also state "no instructions".
 */
function parseInstructions(value: unknown, label: string, settingsDirectory: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new PnpError("SETTINGS_INVALID", `${label} must be an array of paths.`, 400);
  return value.map((entry, index) => {
    const file = nonEmptyString(entry, `${label}[${index}]`);
    return path.isAbsolute(file) ? path.normalize(file) : path.resolve(settingsDirectory, file);
  });
}
/** The file a settings entry names is part of the deployment, so the failure names it: it is
 *  configuration an operator wrote, never a credential and never a caller's input. */
async function assertInstructionsReadable(files: readonly string[]): Promise<void> {
  for (const file of files) {
    try { await access(file, constants.R_OK); }
    catch { throw new PnpError("SETTINGS_INVALID", `Instruction file is missing or unreadable: ${file}`, 400); }
  }
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
export function validateRemoteUrl(raw: string, label: string, environment: NodeJS.ProcessEnv = process.env): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new PnpError("SETTINGS_INVALID", `${label} must be a valid URL.`, 400); }
  if (!isApprovedEndpoint(url, environment)) {
    throw new PnpError("SETTINGS_INVALID", `${label} is not an approved transport.`, 400);
  }
  return raw;
}
function parseMcpServer(id: string, value: unknown, label: string, environment: NodeJS.ProcessEnv): McpServerSettings {
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
    // Expanded before anything else looks at them: the absolute-command rule and every later
    // consumer see the real path, and a shipped settings file can point inside the delivery.
    const command = expandPlaceholders(nonEmptyString(item.command, `${label}.command`), `${label}.command`);
    const args = optionalStringArray(item.args, `${label}.args`)
      .map((argument, index) => expandPlaceholders(argument, `${label}.args[${index}]`));
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
    const headerEnv = headerEnvironment(item.headerEnvironment, `${label}.headerEnvironment`);
    if (hasUrlEnvironment) {
      return {
        id, transport, urlEnvironment: variableName(item.urlEnvironment, `${label}.urlEnvironment`),
        headerEnvironment: headerEnv, enabled, sideEffect,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      };
    }
    const url = expandPlaceholders(nonEmptyString(item.url, `${label}.url`), `${label}.url`);
    return {
      id, transport, url: validateRemoteUrl(url, `${label}.url`, environment),
      headerEnvironment: headerEnv, enabled, sideEffect,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }
  throw new PnpError("SETTINGS_INVALID", `${label}.transport must be stdio or streamable-http.`, 400);
}
function resolveMcp(
  commonValue: unknown, coreValue: unknown, engineId: string, environment: NodeJS.ProcessEnv,
): McpServerSettings[] {
  const commonServers = mcpServerObjects(commonValue, "common.mcp");
  const coreServers = mcpServerObjects(coreValue, `cores.${engineId}.mcp`);
  const ids = [...new Set([...Object.keys(commonServers), ...Object.keys(coreServers)])];
  return ids.map((id) => parseMcpServer(
    id,
    mergedServerObject(own(commonServers, id), own(coreServers, id), `mcp.servers.${id}`),
    `effective.mcp.servers.${id}`,
    environment,
  ));
}

async function readSettingsFile(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch { throw new PnpError("SETTINGS_INVALID", "PNP settings could not be loaded.", 400); }
}

const SETTINGS_KEYS = ["model", "permissions", "instructions", "mcp", "skills", "assets", "packs", "native"];
const ASSET_KEYS = ["path", "layout", "entry", "required", "enabled", "engines", "parameters", "permitted"];
function own(value: JsonObject, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}
function mapObject(value: unknown, label: string): JsonObject {
  return value === undefined ? {} : object(value, label);
}
function json(value: unknown, label: string, ancestors = new Set<object>()): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null || ancestors.has(value)) {
    throw new PnpError("SETTINGS_INVALID", `${label} must contain JSON values.`, 400);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new PnpError("SETTINGS_INVALID", `${label} must contain JSON values.`, 400);
  }
  ancestors.add(value);
  const parsed = Array.isArray(value)
    ? value.map((item, index) => json(item, `${label}[${index}]`, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item, `${label}.${key}`, ancestors)]));
  ancestors.delete(value);
  return parsed;
}
function nativeObject(value: unknown, label: string): Record<string, Json> {
  return json(mapObject(value, label), label) as Record<string, Json>;
}
function mergeParameters(base: JsonObject, override: JsonObject, label: string): JsonObject {
  const merged = { ...base, ...override };
  if (Object.hasOwn(base, "parameters")) json(base.parameters, `${label}.parameters`);
  if (Object.hasOwn(override, "parameters")) json(override.parameters, `${label}.parameters`);
  const left = base.parameters;
  const right = override.parameters;
  if (typeof left === "object" && left !== null && !Array.isArray(left)
    && typeof right === "object" && right !== null && !Array.isArray(right)) {
    merged.parameters = { ...left, ...right };
  }
  return merged;
}
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
/** Resolve a missing leaf through its nearest existing ancestor as well: an optional missing file
 * beneath a junction must not turn into a way of approving a path outside the deployment roots. */
async function canonicalPath(target: string, label: string, depth = 0): Promise<string> {
  if (depth > 128) throw new PnpError("SETTINGS_INVALID", `${label} contains too many path links.`, 400);
  try { return await realpath(target); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
      throw new PnpError("SETTINGS_INVALID", `${label} cannot be resolved.`, 400);
    }
    // realpath also reports ENOENT for dangling links. Follow the link text before falling back
    // to an existing ancestor, otherwise a missing external target would appear to be in-root.
    let link = false;
    try { link = (await lstat(target)).isSymbolicLink(); }
    catch (missing) {
      if (!(missing instanceof Error) || !("code" in missing) || (missing.code !== "ENOENT" && missing.code !== "ENOTDIR")) {
        throw new PnpError("SETTINGS_INVALID", `${label} cannot be resolved.`, 400);
      }
    }
    if (link) return canonicalPath(path.resolve(path.dirname(target), await readlink(target)), label, depth + 1);
    const parent = path.dirname(target);
    if (parent === target) throw new PnpError("SETTINGS_INVALID", `${label} cannot be resolved.`, 400);
    return path.join(await canonicalPath(parent, label, depth + 1), path.basename(target));
  }
}
export async function resolveAssetRoots(
  settingsDirectory: string, environment: NodeJS.ProcessEnv = process.env,
): Promise<AssetRoot[]> {
  const roots: AssetRoot[] = [
    { name: "delivery", path: path.join(CODE_ROOT, "assets", "packs") },
    { name: "config", path: path.resolve(settingsDirectory) },
  ];
  const configured = environment.PNP_PACK_ROOTS;
  if (configured !== undefined && configured.trim() !== "") {
    for (const [index, value] of configured.split(";").entries()) {
      const directory = value.trim();
      if (!path.isAbsolute(directory)) {
        throw new PnpError("SETTINGS_INVALID", `PNP_PACK_ROOTS[${index}] must be an absolute path.`, 400);
      }
      roots.push({ name: `extra:${index}`, path: path.normalize(directory) });
    }
  }
  return Promise.all(roots.map(async (root) => ({ ...root, path: await canonicalPath(root.path, root.name) })));
}
async function assetPath(file: string, roots: readonly AssetRoot[], label: string): Promise<string> {
  const canonical = await canonicalPath(file, label);
  if (!roots.some((root) => within(root.path, canonical))) {
    throw new PnpError("ASSET_OUTSIDE_ROOT", `${label} is outside the approved asset roots.`, 403);
  }
  return canonical;
}
function relativeEntry(value: unknown, label: string): string {
  const entry = nonEmptyString(value, label);
  if (path.isAbsolute(entry) || path.win32.isAbsolute(entry) || entry.includes(":")
    || entry.split(/[\\/]/).some((part) => part === ".." || part === "" || part === ".")) {
    throw new PnpError("ASSET_OUTSIDE_ROOT", `${label} must be a relative path within its asset directory.`, 403);
  }
  return entry;
}
function validateAssetFields(item: JsonObject, label: string): void {
  exactKeys(item, ASSET_KEYS, label);
  for (const field of ["enabled", "required", "permitted"]) optionalBoolean(item[field], `${label}.${field}`, false);
  if (item.path !== undefined) nonEmptyString(item.path, `${label}.path`);
  if (item.layout !== undefined && item.layout !== "file" && item.layout !== "directory") {
    throw new PnpError("SETTINGS_INVALID", `${label}.layout must be file or directory.`, 400);
  }
  if (item.entry !== undefined) relativeEntry(item.entry, `${label}.entry`);
  if (item.engines !== undefined) {
    for (const engine of optionalStringArray(item.engines, `${label}.engines`)) nonEmptyString(engine, `${label}.engines`);
  }
  if (Object.hasOwn(item, "parameters")) json(item.parameters, `${label}.parameters`);
}
async function resolveAssetMap(
  commonValue: unknown, coreValue: unknown, kind: string, commonLabel: string, coreLabel: string,
  directory: string, roots: readonly AssetRoot[],
): Promise<Record<string, AssetEntry>> {
  const common = mapObject(commonValue, commonLabel);
  const core = mapObject(coreValue, coreLabel);
  const result: [string, AssetEntry][] = [];
  for (const id of new Set([...Object.keys(common), ...Object.keys(core)])) {
    const label = `${Object.hasOwn(core, id) ? coreLabel : commonLabel}.${id}`;
    nonEmptyString(id, label);
    if (kind === "skill" && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
      throw new PnpError("SETTINGS_INVALID", `${label} has an invalid skill id.`, 400);
    }
    const base = mapObject(own(common, id), `${commonLabel}.${id}`);
    const override = mapObject(own(core, id), `${coreLabel}.${id}`);
    validateAssetFields(base, `${commonLabel}.${id}`);
    validateAssetFields(override, `${coreLabel}.${id}`);
    const merged = mergeParameters(base, override, label);
    if (merged.enabled === false) {
      if (merged.path !== undefined) await assetPath(path.resolve(directory, nonEmptyString(merged.path, `${label}.path`)), roots, `${label}.path`);
      continue;
    }
    const declared = nonEmptyString(merged.path, `${label}.path`);
    const resolved = await assetPath(path.resolve(directory, declared), roots, `${label}.path`);
    const layout = merged.layout ?? (kind === "skill" ? "directory" : "file");
    if (layout === "file" && merged.entry !== undefined) {
      throw new PnpError("SETTINGS_INVALID", `${label}.entry is only allowed with directory layout.`, 400);
    }
    const entry = layout === "directory" ? relativeEntry(merged.entry ?? "SKILL.md", `${label}.entry`) : undefined;
    if (entry !== undefined) {
      const target = await assetPath(path.resolve(resolved, entry), roots, `${label}.entry`);
      if (!within(resolved, target)) throw new PnpError("ASSET_OUTSIDE_ROOT", `${label}.entry escapes its asset directory.`, 403);
    }
    result.push([id, {
      id, kind, path: resolved, layout: layout as "file" | "directory",
      ...(entry === undefined ? {} : { entry }),
      required: optionalBoolean(merged.required, `${label}.required`, false), enabled: true,
      ...(merged.engines === undefined ? {} : { engines: optionalStringArray(merged.engines, `${label}.engines`) }),
      ...(Object.hasOwn(merged, "parameters") ? { parameters: json(merged.parameters, `${label}.parameters`) } : {}),
      ...(merged.permitted === undefined ? {} : { permitted: optionalBoolean(merged.permitted, `${label}.permitted`, false) }),
    }]);
  }
  return Object.fromEntries(result);
}
async function resolveAssets(
  commonValue: unknown, coreValue: unknown, engineId: string, directory: string, roots: readonly AssetRoot[],
): Promise<Record<string, Record<string, AssetEntry>>> {
  const common = mapObject(commonValue, "common.assets");
  const core = mapObject(coreValue, `cores.${engineId}.assets`);
  const entries: [string, Record<string, AssetEntry>][] = [];
  for (const kind of new Set([...Object.keys(common), ...Object.keys(core)])) {
    nonEmptyString(kind, "assets domain");
    if (kind === "instruction" || kind === "skill") {
      const label = Object.hasOwn(core, kind) ? `cores.${engineId}.assets.${kind}` : `common.assets.${kind}`;
      throw new PnpError("SETTINGS_INVALID", `${label} is an alias; use ${kind === "skill" ? "skills" : "instructions"} instead.`, 400);
    }
    entries.push([kind, await resolveAssetMap(own(common, kind), own(core, kind), kind,
      `common.assets.${kind}`, `cores.${engineId}.assets.${kind}`, directory, roots)]);
  }
  return Object.fromEntries(entries);
}
function contributionMap(value: unknown, label: string): PackSelection["contributions"] {
  return Object.fromEntries(Object.entries(mapObject(value, label)).map(([kind, entries]) => [kind,
    Object.fromEntries(Object.entries(object(entries, `${label}.${kind}`)).map(([id, value]) => {
      nonEmptyString(kind, label);
      nonEmptyString(id, `${label}.${kind}`);
      const item = object(value, `${label}.${kind}.${id}`);
      exactKeys(item, ["enabled", "required", "parameters"], `${label}.${kind}.${id}`);
      return [id, {
        ...(item.enabled === undefined ? {} : { enabled: optionalBoolean(item.enabled, `${label}.${kind}.${id}.enabled`, true) }),
        ...(item.required === undefined ? {} : { required: optionalBoolean(item.required, `${label}.${kind}.${id}.required`, false) }),
        ...(Object.hasOwn(item, "parameters") ? { parameters: json(item.parameters, `${label}.${kind}.${id}.parameters`) } : {}),
      }];
    })),
  ]));
}
function resolvePacks(commonValue: unknown, coreValue: unknown, engineId: string, roots: readonly AssetRoot[]): PackSelection[] {
  const common = mapObject(commonValue, "common.packs");
  const core = mapObject(coreValue, `cores.${engineId}.packs`);
  return [...new Set([...Object.keys(common), ...Object.keys(core)])].flatMap((id) => {
    const label = `${Object.hasOwn(core, id) ? `cores.${engineId}` : "common"}.packs.${id}`;
    if (!/^[a-z0-9-]+$/.test(id)) throw new PnpError("SETTINGS_INVALID", `${label} has an invalid pack id.`, 400);
    const base = mapObject(own(common, id), `common.packs.${id}`);
    const override = mapObject(own(core, id), `cores.${engineId}.packs.${id}`);
    for (const [item, itemLabel] of [[base, `common.packs.${id}`], [override, `cores.${engineId}.packs.${id}`]] as const) {
      exactKeys(item, ["enabled", "required", "root", "permitNativeExtensions", "contributions"], itemLabel);
      for (const field of ["enabled", "required", "permitNativeExtensions"]) optionalBoolean(item[field], `${itemLabel}.${field}`, false);
      if (item.root !== undefined && !roots.some((root) => root.name === item.root)) {
        throw new PnpError("SETTINGS_INVALID", `${itemLabel}.root must name an approved asset root.`, 400);
      }
    }
    const left = contributionMap(base.contributions, `common.packs.${id}.contributions`);
    const right = contributionMap(override.contributions, `cores.${engineId}.packs.${id}.contributions`);
    const contributions = Object.fromEntries([...new Set([...Object.keys(left), ...Object.keys(right)])].map((kind) => {
      const a = mapObject(own(left, kind), label);
      const b = mapObject(own(right, kind), label);
      return [kind, Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((entryId) => [entryId,
        mergeParameters(mapObject(own(a, entryId), label), mapObject(own(b, entryId), label), label),
      ]))];
    })) as PackSelection["contributions"];
    const merged = { ...base, ...override };
    return merged.enabled === false ? [] : [{
      id, enabled: true, required: optionalBoolean(merged.required, `${label}.required`, false),
      ...(merged.root === undefined ? {} : { root: nonEmptyString(merged.root, `${label}.root`) }),
      permitNativeExtensions: optionalBoolean(merged.permitNativeExtensions, `${label}.permitNativeExtensions`, false), contributions,
    }];
  });
}

async function inspectAsset(entry: AssetEntry, roots: readonly AssetRoot[], label: string, problems?: SettingsProblem[]): Promise<void> {
  let information;
  try { information = await stat(entry.path); }
  catch {
    if (entry.required) throw new PnpError("SETTINGS_INVALID", `${label}.path is missing or unreadable.`, 400);
    problems?.push({ severity: "warning", path: `${label}.path`, code: "ASSET_MISSING", message: `${label}.path is missing or unreadable; optional asset will be skipped.` });
    return;
  }
  if (entry.layout === "directory" ? !information.isDirectory() : !information.isFile()) {
    throw new PnpError("SETTINGS_INVALID", `${label}.path does not match its layout.`, 400);
  }
  if (entry.layout === "directory") {
    let count = 0;
    const visited = new Set<string>();
    async function inspectTree(directory: string): Promise<void> {
      const canonical = await assetPath(directory, roots, `${label}.path`);
      if (!within(entry.path, canonical)) throw new PnpError("ASSET_OUTSIDE_ROOT", `${label}.path contains a link outside its directory.`, 403);
      if (visited.has(canonical)) throw new PnpError("SETTINGS_INVALID", `${label}.path contains a directory cycle.`, 400);
      visited.add(canonical);
      for (const child of await readdir(canonical, { withFileTypes: true })) {
        if (++count > 512) throw new PnpError("SETTINGS_INVALID", `${label}.path exceeds 512 entries.`, 400);
        const file = await assetPath(path.join(canonical, child.name), roots, `${label}.path`);
        if (!within(entry.path, file)) throw new PnpError("ASSET_OUTSIDE_ROOT", `${label}.path contains a link outside its directory.`, 403);
        if ((await stat(file)).isDirectory()) await inspectTree(file);
      }
    }
    await inspectTree(entry.path);
  }
  const file = entry.layout === "directory" ? path.join(entry.path, entry.entry!) : entry.path;
  let text: string;
  try {
    await access(file, constants.R_OK);
    if (entry.kind !== "skill") return;
    if ((await stat(file)).size > 1024 * 1024) throw new PnpError("SETTINGS_INVALID", `${label}.entry exceeds 1 MiB.`, 400);
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof PnpError) throw error;
    if (entry.required) throw new PnpError("SETTINGS_INVALID", `${label}.entry is missing or unreadable.`, 400);
    problems?.push({ severity: "warning", path: `${label}.entry`, code: "ASSET_MISSING", message: `${label}.entry is missing or unreadable; optional asset will be skipped.` });
    return;
  }
  const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  const name = frontmatter?.match(/^name:\s*([^\r\n]+)$/m)?.[1]?.trim();
  const description = frontmatter?.match(/^description:\s*([^\r\n]+)$/m)?.[1]?.trim();
  if (!name || !description || ["''", '""'].includes(name) || ["''", '""'].includes(description)) {
    throw new PnpError("SETTINGS_INVALID", `${label}.entry is missing Agent Skills frontmatter (name, description).`, 400);
  }
  if (name.replace(/^['"]|['"]$/g, "") !== entry.id) problems?.push({
    severity: "warning", path: `${label}.entry`, code: "SKILL_NAME_MISMATCH", message: `${label}.entry frontmatter name differs from the configured id.`,
  });
}
/** An unset or empty `PNP_SETTINGS` means the shipped file; anything else is a path, and a relative
 *  one is taken from the package root so a deployment can write `config/settings.json`. */
export function resolveSettingsPath(explicit: string | undefined): string {
  if (explicit === undefined || explicit.trim() === "") return DEFAULT_SETTINGS;
  return resolveCodePath(explicit.trim());
}

/**
 * Resolves one effective runtime settings view for an Engine Core. `common` is the baseline; the selected
 * `cores.<engineId>` section is an additive override. Model definitions with the same provider/model key replace
 * their common definition, permission operations merge by operation name, and MCP servers merge by server id.
 * A Core can therefore disable or partially override a common MCP server without copying the whole definition.
 * This layer preserves environment-variable NAMES; it never resolves model or MCP secrets.
 */
export async function loadPnpSettings(input: {
  engineId: string;
  settingsPath?: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<EffectiveSettings> {
  const file = resolveSettingsPath(input.settingsPath);
  return resolvePnpSettingsDocument(await readSettingsFile(file), {
    engineId: input.engineId, settingsDirectory: path.dirname(file), environment: input.environment,
  });
}

export async function resolvePnpSettingsDocument(document: unknown, input: SettingsDocumentOptions): Promise<EffectiveSettings> {
  return resolveDocument(document, input);
}

async function resolveDocument(document: unknown, input: SettingsDocumentOptions, problems?: SettingsProblem[]): Promise<EffectiveSettings> {
  const environment = input.environment ?? process.env;
  const directory = path.resolve(input.settingsDirectory);
  const root = object(document, "settings");
  exactKeys(root, ["version", "common", "cores"], "settings");
  if (root.version !== 1) throw new PnpError("SETTINGS_INVALID", "settings.version must be 1.", 400);

  const common = object(root.common, "common");
  exactKeys(common, SETTINGS_KEYS, "common");
  const commonModel = parseModelSection(common.model, "common.model", true, environment);
  const commonPermissions = parseCommonPermissions(common.permissions);
  const commonInstructions = parseInstructions(common.instructions, "common.instructions", directory) ?? [];
  const roots = await resolveAssetRoots(directory, environment);
  const commonNative = nativeObject(common.native, "common.native");

  const cores = object(root.cores, "cores");
  for (const [engineId, value] of Object.entries(cores)) {
    const core = object(value, `cores.${engineId}`);
    exactKeys(core, SETTINGS_KEYS, `cores.${engineId}`);
    if (core.model !== undefined) parseModelSection(core.model, `cores.${engineId}.model`, false, environment);
    parseCorePermissions(core.permissions, engineId);
    parseInstructions(core.instructions, `cores.${engineId}.instructions`, directory);
    resolveMcp(common.mcp, core.mcp, engineId, environment);
    nativeObject(core.native, `cores.${engineId}.native`);
    await resolveAssetMap(common.skills, core.skills, "skill", "common.skills", `cores.${engineId}.skills`, directory, roots);
    await resolveAssets(common.assets, core.assets, engineId, directory, roots);
    resolvePacks(common.packs, core.packs, engineId, roots);
  }

  const selectedValue = own(cores, input.engineId);
  const selected = selectedValue === undefined ? undefined : object(selectedValue, `cores.${input.engineId}`);
  const coreModel = selected?.model === undefined ? { models: [] } : parseModelSection(selected.model, `cores.${input.engineId}.model`, false, environment);
  const corePermissions = parseCorePermissions(selected?.permissions, input.engineId);
  const models = mergeModels(commonModel.models, coreModel.models);
  const declaredDefault = coreModel.default ?? commonModel.default;
  if (declaredDefault === undefined) {
    throw new PnpError("SETTINGS_INVALID", `Effective default model for ${input.engineId} is not configured.`, 400);
  }
  const defaultSelection = resolveDefaultSelection(declaredDefault, models, input.engineId);
  const instructions = parseInstructions(selected?.instructions, `cores.${input.engineId}.instructions`, directory)
    ?? commonInstructions;
  // Checked once, here, so a deployment that misspelled a path learns it at startup instead of
  // handing the engine an instruction set that silently lost a file.
  await assertInstructionsReadable(instructions);

  const skills = Object.values(await resolveAssetMap(common.skills, selected?.skills, "skill", "common.skills", `cores.${input.engineId}.skills`, directory, roots));
  const assets = await resolveAssets(common.assets, selected?.assets, input.engineId, directory, roots);
  const packs = resolvePacks(common.packs, selected?.packs, input.engineId, roots);
  for (const entry of [...skills, ...Object.values(assets).flatMap((domain) => Object.values(domain))]) {
    if (entry.engines !== undefined && !entry.engines.includes(input.engineId)) continue;
    const section = entry.kind === "skill" ? "skills" : "assets";
    const selectedMap = mapObject(selected?.[section], `cores.${input.engineId}.${section}`);
    const defined = entry.kind === "skill" ? Object.hasOwn(selectedMap, entry.id)
      : Object.hasOwn(mapObject(own(selectedMap, entry.kind), section), entry.id);
    const label = `${defined ? `cores.${input.engineId}` : "common"}.${section}${entry.kind === "skill" ? "" : `.${entry.kind}`}.${entry.id}`;
    await inspectAsset(entry, roots, label, problems);
  }

  return {
    model: { default: defaultSelection, models },
    permissions: {
      default: corePermissions.default ?? commonPermissions.default,
      operations: { ...commonPermissions.operations, ...corePermissions.operations },
    },
    instructions,
    mcp: { servers: resolveMcp(common.mcp, selected?.mcp, input.engineId, environment) },
    skills, assets, packs, assetRoots: roots,
    native: { ...commonNative, ...nativeObject(selected?.native, `cores.${input.engineId}.native`) },
  };
}

/** Read-only validation uses the same section parsers as runtime loading. Independent sections
 * are checked separately so one bad field does not hide a second section's error. */
export async function validatePnpSettingsDocument(document: unknown, input: SettingsDocumentOptions): Promise<SettingsDocumentValidation> {
  const problems: SettingsProblem[] = [];
  const environment = input.environment ?? process.env;
  const directory = path.resolve(input.settingsDirectory);
  async function check<T>(label: string, operation: () => T | Promise<T>): Promise<T | undefined> {
    try { return await operation(); }
    catch (error) {
      const failure = error instanceof PnpError ? error : new PnpError("SETTINGS_INVALID", `${label} could not be validated.`, 400);
      const leading = /^(common(?:\.[^\s]+)?|cores(?:\.[^\s]+)?|settings(?:\.[^\s]+)?|PNP_PACK_ROOTS\[\d+\])/.exec(failure.message)?.[1];
      const problem = { severity: "error" as const, path: leading ?? label, code: failure.code, message: failure.message };
      if (!problems.some((existing) => existing.path === problem.path && existing.message === problem.message)) problems.push(problem);
      return undefined;
    }
  }
  const root = await check("settings", () => {
    const value = object(document, "settings");
    exactKeys(value, ["version", "common", "cores"], "settings");
    if (value.version !== 1) throw new PnpError("SETTINGS_INVALID", "settings.version must be 1.", 400);
    return value;
  });
  if (root === undefined) return { ok: false, problems };
  const common = await check("common", () => object(root.common, "common"));
  const cores = await check("cores", () => object(root.cores, "cores"));
  const roots = await check("PNP_PACK_ROOTS", () => resolveAssetRoots(directory, environment));
  if (common !== undefined) {
    await check("common", () => exactKeys(common, SETTINGS_KEYS, "common"));
    await check("common.model", () => parseModelSection(common.model, "common.model", true, environment));
    await check("common.permissions", () => parseCommonPermissions(common.permissions));
    await check("common.instructions", () => parseInstructions(common.instructions, "common.instructions", directory));
    await check("common.native", () => nativeObject(common.native, "common.native"));
    await check("common.mcp", () => resolveMcp(common.mcp, undefined, input.engineId, environment));
  }
  for (const [engineId, value] of Object.entries(cores ?? {})) {
    const label = `cores.${engineId}`;
    const core = await check(label, () => object(value, label));
    if (core === undefined) continue;
    await check(label, () => exactKeys(core, SETTINGS_KEYS, label));
    await check(`${label}.model`, () => core.model === undefined ? undefined : parseModelSection(core.model, `${label}.model`, false, environment));
    await check(`${label}.permissions`, () => parseCorePermissions(core.permissions, engineId));
    await check(`${label}.instructions`, () => parseInstructions(core.instructions, `${label}.instructions`, directory));
    await check(`${label}.native`, () => nativeObject(core.native, `${label}.native`));
    await check(`${label}.mcp`, () => resolveMcp(common?.mcp, core.mcp, engineId, environment));
  }
  // Common entries may intentionally be disabled/partially overridden by a Core. Validate their
  // effective form, as the runtime parser does, instead of requiring complete override entries.
  const targets = cores === undefined ? [] : [...new Set([...Object.keys(cores), input.engineId])];
  for (const engineId of targets) {
    const coreValue = own(cores!, engineId);
    if (coreValue !== undefined && (typeof coreValue !== "object" || coreValue === null || Array.isArray(coreValue))) continue;
    const core = coreValue as JsonObject | undefined;
    if (roots === undefined) continue;
    await check(`cores.${engineId}.skills`, () => resolveAssetMap(common?.skills, core?.skills, "skill", "common.skills", `cores.${engineId}.skills`, directory, roots));
    await check(`cores.${engineId}.assets`, () => resolveAssets(common?.assets, core?.assets, engineId, directory, roots));
    await check(`cores.${engineId}.packs`, () => resolvePacks(common?.packs, core?.packs, engineId, roots));
  }
  if (problems.some((problem) => problem.severity === "error")) return { ok: false, problems };
  const effective = await check("settings", () => resolveDocument(document, input, problems));
  return { ok: effective !== undefined, problems, ...(effective === undefined ? {} : { effective }) };
}
