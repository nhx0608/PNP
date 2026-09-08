import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
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
    ...(modelIDEnvironment === undefined ? {} : { modelIDEnvironment: nonEmptyString(modelIDEnvironment, `${label}.modelIDEnvironment`) }),
    ...(apiKeyEnvironment === undefined ? {} : { apiKeyEnvironment: nonEmptyString(apiKeyEnvironment, `${label}.apiKeyEnvironment`) }),
    ...(headersEnvironment === undefined ? {} : { headersEnvironment: nonEmptyString(headersEnvironment, `${label}.headersEnvironment`) }),
    ...(caFileEnvironment === undefined ? {} : { caFileEnvironment: nonEmptyString(caFileEnvironment, `${label}.caFileEnvironment`) }),
  } as const;
  if (hasEndpointEnvironment) {
    return { ...common, endpointEnvironment: nonEmptyString(item.endpointEnvironment, `${label}.endpointEnvironment`) };
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
    const headerEnv = optionalStringMap(item.headerEnvironment, `${label}.headerEnvironment`);
    if (hasUrlEnvironment) {
      return {
        id, transport, urlEnvironment: nonEmptyString(item.urlEnvironment, `${label}.urlEnvironment`),
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
    mergedServerObject(commonServers[id], coreServers[id], `mcp.servers.${id}`),
    `effective.mcp.servers.${id}`,
    environment,
  ));
}

async function readSettingsFile(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch { throw new PnpError("SETTINGS_INVALID", "PNP settings could not be loaded.", 400); }
}
/** An unset or empty `PNP_SETTINGS` means the shipped file; anything else is a path, and a relative
 *  one is taken from the package root so a deployment can write `config/settings.json`. */
function settingsPath(explicit: string | undefined): string {
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
  const environment = input.environment ?? process.env;
  const file = settingsPath(input.settingsPath);
  const directory = path.dirname(file);
  const root = object(await readSettingsFile(file), "settings");
  exactKeys(root, ["version", "common", "cores"], "settings");
  if (root.version !== 1) throw new PnpError("SETTINGS_INVALID", "settings.version must be 1.", 400);

  const common = object(root.common, "common");
  exactKeys(common, ["model", "permissions", "instructions", "mcp"], "common");
  const commonModel = parseModelSection(common.model, "common.model", true, environment);
  const commonPermissions = parseCommonPermissions(common.permissions);
  const commonInstructions = parseInstructions(common.instructions, "common.instructions", directory) ?? [];

  const cores = object(root.cores, "cores");
  for (const [engineId, value] of Object.entries(cores)) {
    const core = object(value, `cores.${engineId}`);
    exactKeys(core, ["model", "permissions", "instructions", "mcp"], `cores.${engineId}`);
    if (core.model !== undefined) parseModelSection(core.model, `cores.${engineId}.model`, false, environment);
    parseCorePermissions(core.permissions, engineId);
    parseInstructions(core.instructions, `cores.${engineId}.instructions`, directory);
    resolveMcp(common.mcp, core.mcp, engineId, environment);
  }

  const selected = cores[input.engineId] === undefined ? undefined : object(cores[input.engineId], `cores.${input.engineId}`);
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

  return {
    model: { default: defaultSelection, models },
    permissions: {
      default: corePermissions.default ?? commonPermissions.default,
      operations: { ...commonPermissions.operations, ...corePermissions.operations },
    },
    instructions,
    mcp: { servers: resolveMcp(common.mcp, selected?.mcp, input.engineId, environment) },
  };
}
