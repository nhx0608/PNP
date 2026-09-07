import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelSelection } from "../contracts/index.ts";
import { PnpError } from "../core/errors.ts";

export type PermissionEffect = "allow" | "deny" | "ask";
export interface PermissionPolicy {
  default: PermissionEffect;
  operations: Readonly<Record<string, PermissionEffect>>;
}
export interface SettingsModelDefinition {
  selection: ModelSelection;
  endpoint?: string;
  endpointEnvironment?: string;
  protocol: "openai-chat" | "anthropic-messages";
  headerEnvironment: Readonly<Record<string, string>>;
}
export interface EffectiveSettings {
  model: {
    default: ModelSelection;
    models: readonly SettingsModelDefinition[];
  };
  permissions: PermissionPolicy;
}

type JsonObject = Record<string, unknown>;
const EFFECTS: readonly PermissionEffect[] = ["allow", "deny", "ask"];
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
 * their common definition for that Core, while permission operations are merged by operation name. Nothing here
 * resolves credentials: model endpoints/headers still reference environment variable names and are resolved by
 * the IntegrationProvider per prompt.
 */
export async function loadPnpSettings(input: { engineId: string; settingsPath?: string }): Promise<EffectiveSettings> {
  const file = settingsPath(input.settingsPath);
  const root = object(await readSettingsFile(file), "settings");
  exactKeys(root, ["version", "common", "cores"], "settings");
  if (root.version !== 1) throw new PnpError("SETTINGS_INVALID", "settings.version must be 1.", 400);

  const common = object(root.common, "common");
  exactKeys(common, ["model", "permissions"], "common");
  const commonModel = parseModelSection(common.model, "common.model", true);
  const commonPermissions = parseCommonPermissions(common.permissions);

  const cores = object(root.cores, "cores");
  for (const [engineId, value] of Object.entries(cores)) {
    const core = object(value, `cores.${engineId}`);
    exactKeys(core, ["model", "permissions"], `cores.${engineId}`);
    if (core.model !== undefined) parseModelSection(core.model, `cores.${engineId}.model`, false);
    parseCorePermissions(core.permissions, engineId);
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
  };
}
