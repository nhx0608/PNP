import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AuthorizationDecision, CommandToolBinding, IntegrationProvider, ModelSelection, PermissionEffect,
  PermissionPolicy, ToolBinding, ToolSideEffect,
} from "../contracts/index.ts";
import { CODE_ROOT, loadPnpSettings, parseSettingsModel, parseSettingsSelection, resolveCodePath, validateRemoteUrl } from "../config/settings.ts";
import type {
  EffectiveSettings, McpServerSettings, McpStreamableHttpServerSettings, SettingsModelDefinition,
} from "../config/settings.ts";
import { PnpError } from "../core/errors.ts";
import { assertConfiguredCapabilitiesApplicable, inspectConfiguredCapabilities } from "../config/capability-readiness.ts";
import { ConfiguredIntegration, type ConfiguredModel } from "./configured/provider.ts";
import { InternalIntegration } from "./internal/provider.ts";
import { MockIntegration } from "./mock/provider.ts";

type IntegrationKind = "internal" | "configured" | "mock";
type JsonObject = Record<string, unknown>;
type Effect = PermissionEffect;
const EFFECTS: readonly Effect[] = ["allow", "deny", "ask"];
/**
 * The integration is shipped configuration, not a code delivery: an operator who follows
 * INSTRUCTION.md gets this profile and the shipped settings without setting anything
 * (docs/engineering-review-3.md section 7, R3). Models, permissions and MCP servers all come from the
 * settings file; this profile is the legacy tool surface, kept for a deployment that names one itself.
 * The settings name environment variables instead of carrying an endpoint or a credential, so the
 * public repository holds no deployment address. Those values only ever exist in the process
 * environment, and `probeIntegration` refuses to start when one of them is missing.
 */
export const DEFAULT_CONFIGURED_PROFILE = path.join(CODE_ROOT, "config", "competition-profile.json");

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
/** An environment variable that holds nothing but blanks names no model, endpoint or path; every
 *  consumer here treats it as unset rather than sending a blank identifier to an endpoint. */
function unset(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}
/**
 * `modelIDEnvironment` applied once, at load: the identifier the intranet endpoint expects is the
 * deployment's fact, not this repository's, so the settings name a variable and the value replaces
 * `selection.modelID` before anything else sees the catalog. One identifier then travels through the
 * whole gateway — `model.resolved`, the trajectory and the driver all show what actually ran.
 *
 * The declared default is rewritten with it, because it names the entry by its settings identifier;
 * leaving it behind would silently bind the deployment to whichever entry happened to be listed
 * first. An entry whose variable is absent keeps its declared identifier and fails when a prompt
 * actually selects it (ConfiguredIntegration.modelIdOf); the effective default fails earlier, at the
 * startup probe, because nothing can run without it.
 */
function applyModelIdentifierEnvironment(
  models: readonly ConfiguredModel[], defaultSelection: ModelSelection, environment: NodeJS.ProcessEnv,
): { models: ConfiguredModel[]; defaultSelection: ModelSelection } {
  const substituted = new Map<string, ModelSelection>();
  const resolved = models.map((entry) => {
    if (entry.modelIDEnvironment === undefined) return entry;
    const value = environment[entry.modelIDEnvironment];
    if (unset(value)) return entry;
    const selection: ModelSelection = { providerID: entry.selection.providerID, modelID: value!.trim() };
    substituted.set(modelKey(entry.selection), selection);
    return { ...entry, selection };
  });
  if (new Set(resolved.map((entry) => modelKey(entry.selection))).size !== resolved.length) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID",
      "Model identifier environment variables resolve to duplicate selections.", 400);
  }
  return { models: resolved, defaultSelection: substituted.get(modelKey(defaultSelection)) ?? defaultSelection };
}
/** Legacy profile/model-settings parsing keeps the old public error code even though it reuses the new parser. */
function parseLegacyModel(
  value: unknown, label: string, environment: NodeJS.ProcessEnv,
): SettingsModelDefinition {
  try { return parseSettingsModel(value, label, environment); }
  catch (error) {
    if (error instanceof PnpError && error.code === "SETTINGS_INVALID") {
      throw new PnpError("INTEGRATION_CONFIG_INVALID", error.message, 400);
    }
    throw error;
  }
}
function parseLegacySelection(value: unknown, label: string): ModelSelection {
  try { return parseSettingsSelection(value, label); }
  catch (error) {
    if (error instanceof PnpError && error.code === "SETTINGS_INVALID") {
      throw new PnpError("INTEGRATION_CONFIG_INVALID", error.message, 400);
    }
    throw error;
  }
}
async function loadLegacyModelSettings(
  file: string, environment: NodeJS.ProcessEnv,
): Promise<{ models: ConfiguredModel[]; defaultSelection: ModelSelection }> {
  if (!path.isAbsolute(file)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "PNP_MODEL_SETTINGS must be an absolute path.", 400);
  const settings = object(await readJson(file, "Legacy model settings"), "legacy model settings");
  exactKeys(settings, ["default", "models"], "legacy model settings");
  if (!Array.isArray(settings.models) || settings.models.length === 0) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Legacy model settings require at least one model.", 400);
  }
  const models = configuredModels(settings.models.map((entry, index) =>
    parseLegacyModel(entry, `models[${index}]`, environment)));
  const defaultSelection = parseLegacySelection(settings.default, "default");
  if (new Set(models.map((entry) => modelKey(entry.selection))).size !== models.length) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Model selections must be unique.", 400);
  }
  if (!models.some((entry) => modelKey(entry.selection) === modelKey(defaultSelection))) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Default model must exist in model settings.", 400);
  }
  return { models, defaultSelection };
}
function parseLegacyModels(value: unknown, environment: NodeJS.ProcessEnv): ConfiguredModel[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "At least one legacy profile model is required.", 400);
  }
  const models = configuredModels(value.map((entry, index) =>
    parseLegacyModel(entry, `profile.models[${index}]`, environment)));
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
/**
 * Deployment-side operation policy, supplied as JSON in `PNP_CONFIGURED_POLICY_OVERRIDES` so a
 * deployment can put one operation on "ask" without editing the shipped settings. It is the same
 * trust level as the settings file (both are set by whoever runs the gateway) and it is applied at
 * load time, so it can never be reached by a caller, a prompt or a user reply.
 */
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
function tool(value: unknown, environment: NodeJS.ProcessEnv): CommandToolBinding {
  const item = object(value, "tool");
  exactKeys(item, ["id", "transport", "command", "args", "env", "sideEffect", "timeoutMs"], "tool");
  const transport = string(item.transport, "tool.transport") as CommandToolBinding["transport"];
  const sideEffect = string(item.sideEffect, "tool.sideEffect") as ToolSideEffect;
  const command = string(item.command, "tool.command");
  if (!path.isAbsolute(command)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Tool command must be absolute.", 400);
  if (!["mcp-stdio", "cli", "native"].includes(transport)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported tool transport.", 400);
  if (!["read", "write", "external"].includes(sideEffect)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported tool side effect.", 400);
  if (!Array.isArray(item.args) || !item.args.every((arg) => typeof arg === "string")) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Tool args must be strings.", 400);
  }
  const resolvedEnvironment = resolvedValues(stringMap(item.env, "tool.env"), environment);
  const timeoutMs = item.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0)) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Tool timeout must be a positive integer.", 400);
  }
  return {
    id: string(item.id, "tool.id"), transport, command, args: item.args as string[], env: resolvedEnvironment, sideEffect,
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
  };
}
/**
 * Environment-variable NAMES to the values they hold. Both tool sources resolve through this one function so
 * a missing variable fails the same way for both: at load, with the same status, and with a message that
 * carries neither the value nor the variable, because this failure is answered to a caller.
 */
function resolvedValues(names: Readonly<Record<string, string>>, environment: NodeJS.ProcessEnv): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, variable] of Object.entries(names)) {
    const value = environment[variable];
    if (unset(value)) {
      throw new PnpError("INTEGRATION_CONFIG_INVALID",
        `Required tool environment variable is absent: ${variable}.`, 503);
    }
    resolved[name] = value!;
  }
  return resolved;
}
function resolvedHeaders(names: Readonly<Record<string, string>>, environment: NodeJS.ProcessEnv): Record<string, string> {
  const resolved = resolvedValues(names, environment);
  for (const [name, value] of Object.entries(resolved)) {
    if (/[^\t\u0020-\u007e\u0080-\u00ff]/.test(value)) {
      throw new PnpError("INTEGRATION_CONFIG_INVALID",
        `MCP HTTP header environment variable is invalid: ${names[name]}.`, 503);
    }
  }
  return resolved;
}
/**
 * The address of a remote MCP server: the literal one, or whatever its variable holds. Either way the
 * resolved value faces the transport rule that guards a model endpoint, because a settings file cannot
 * check what a variable will contain. The failure names the setting, never the address.
 */
function mcpServerUrl(server: McpStreamableHttpServerSettings, environment: NodeJS.ProcessEnv): string {
  const raw = server.urlEnvironment === undefined ? server.url : environment[server.urlEnvironment];
  if (unset(raw)) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID",
      `Required MCP URL environment variable is absent: ${server.urlEnvironment}.`, 503);
  }
  // The same environment the rest of this load reads, so `PNP_ALLOW_HTTP_ENDPOINTS` means the same
  // thing for a variable-backed MCP address as it does for a literal one in the settings file.
  try { return validateRemoteUrl(raw!, `mcp.servers.${server.id}.url`, environment); }
  catch (error) {
    if (error instanceof PnpError && error.code === "SETTINGS_INVALID") {
      throw new PnpError("INTEGRATION_CONFIG_INVALID", error.message, 400);
    }
    throw error;
  }
}
/**
 * The effective settings' MCP servers as this run's tool bindings (docs/engineering-review-3.md section 13).
 * Variable names become values here, at load, so a deployment that forgot one fails at startup instead of
 * discovering it as a tool that quietly does nothing halfway through a case. A disabled server is simply
 * absent: it was turned off on purpose, so there is nothing to report about it.
 */
function mcpToolBindings(servers: readonly McpServerSettings[], environment: NodeJS.ProcessEnv): ToolBinding[] {
  const bindings: ToolBinding[] = [];
  for (const server of servers) {
    if (!server.enabled) continue;
    const timeout = server.timeoutMs === undefined ? {} : { timeoutMs: server.timeoutMs };
    if (server.transport === "stdio") {
      // The legacy profile's rule, unchanged: an absolute path, never a PATH lookup, so a settings file
      // cannot be turned into "whatever is first on PATH on this machine".
      if (!path.isAbsolute(server.command)) {
        throw new PnpError("INTEGRATION_CONFIG_INVALID", "Tool command must be absolute.", 400);
      }
      bindings.push({
        id: server.id, transport: "mcp-stdio", command: server.command, args: [...server.args],
        env: resolvedValues(server.env, environment), sideEffect: server.sideEffect, ...timeout,
      });
      continue;
    }
    bindings.push({
      id: server.id, transport: "mcp-http", url: mcpServerUrl(server, environment),
      headers: resolvedHeaders(server.headerEnvironment, environment), sideEffect: server.sideEffect, ...timeout,
    });
  }
  return bindings;
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
  // A real engine defaults to the shipped configured profile. `internal` stays selectable, and it
  // is the explicit choice — never a default — that fails while it has no implementation.
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

  // Unlike mock, configured carries no development-mode gate: it reads its files from absolute
  // paths, references secrets only by environment variable name, and restricts model endpoints to
  // https or loopback — the same trust model as the internal provider. A real (non-mock) engine
  // must have a usable model path in a non-development deployment, and configured is currently the
  // only one that is actually implemented.
  // An unset PNP_CONFIGURED_PROFILE (or an empty one) means the shipped profile; a path the
  // deployment names wins. PNP_SETTINGS works the same way for the unified settings file.
  const environment = input.environment ?? process.env;
  const explicitProfile = input.configuredProfile !== undefined && input.configuredProfile.trim() !== "";
  const explicitSettings = input.settingsPath !== undefined && input.settingsPath.trim() !== "";
  // A deployment names this file relative to the package root when it keeps it inside the delivery:
  // the unpack location is not known when the value is written. An absolute path is used as given,
  // and an empty value is not a path at all — it means the shipped profile (`explicitProfile`).
  const profilePath = explicitProfile ? resolveCodePath(input.configuredProfile!.trim()) : DEFAULT_CONFIGURED_PROFILE;
  const profile = object(await readJson(profilePath, "Configured integration profile"), "profile");
  exactKeys(profile, ["models", "tools", "policy"], "profile");
  const rawTools = profile.tools ?? [];
  if (!Array.isArray(rawTools)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "tools must be an array.", 400);

  // Existing explicit configured profiles remain a compatibility surface, and one rule decides all three
  // parts: a profile the deployment named itself, with no explicit PNP_SETTINGS, is read the old way for
  // models, policy AND tools; anything else takes them from the unified settings file. Tools used to be the
  // exception, which meant the shipped `{"tools": []}` silently outranked `common.mcp.servers`
  // (docs/engineering-review-3.md section 13).
  const legacyOnly = explicitProfile && !explicitSettings;
  const legacyModels = legacyOnly && profile.models !== undefined
    ? parseLegacyModels(profile.models, environment) : undefined;
  const legacyPolicy = legacyOnly && profile.policy !== undefined ? parsePolicy(profile.policy, "profile.policy") : undefined;
  // Backward compatibility for the model-only file introduced before unified settings. It is model-only and
  // intentionally cannot override permissions; new deployments should use PNP_SETTINGS instead.
  const legacyModelSettings = input.modelSettings !== undefined && input.modelSettings.trim() !== ""
    ? await loadLegacyModelSettings(input.modelSettings.trim(), environment) : undefined;

  // The unified settings file is read only when something above has not already supplied that part. A
  // deployment that names its own legacy profile with inline models and policy depends on nothing else, so a
  // missing default settings.json must not fail it (docs/engineering-review-3.md section 12, 记录).
  let unified: EffectiveSettings | undefined;
  const settings = async (): Promise<EffectiveSettings> => {
    unified ??= await loadPnpSettings({
      engineId: input.engineId ?? "", settingsPath: input.settingsPath, environment,
    });
    return unified;
  };
  let declaredModels: ConfiguredModel[];
  let declaredDefault: ModelSelection;
  if (legacyModelSettings !== undefined) ({ models: declaredModels, defaultSelection: declaredDefault } = legacyModelSettings);
  else if (legacyModels !== undefined) { declaredModels = legacyModels; declaredDefault = legacyModels[0]!.selection; }
  else {
    const effective = await settings();
    declaredModels = configuredModels(effective.model.models);
    declaredDefault = effective.model.default;
  }
  const { models, defaultSelection } = applyModelIdentifierEnvironment(declaredModels, declaredDefault, environment);
  const configuredPolicy = legacyPolicy ?? (await settings()).permissions;

  const tools: ToolBinding[] = legacyOnly
    ? rawTools.map((value) => tool(value, environment))
    : mcpToolBindings((await settings()).mcp.servers, environment);
  // Instruction files follow the same rule as the tools above: a deployment that names its own
  // legacy profile without an explicit PNP_SETTINGS is the whole source, and that profile shape has
  // no instructions. Every other deployment takes them from the unified settings file.
  const instructions = legacyOnly ? [] : (await settings()).instructions;
  // P2 makes arbitrary domains parseable. Applying them still requires real native
  // projectors; reject required gaps before an EnginePack can create a channel.
  const capabilityReport = legacyOnly ? undefined : inspectConfiguredCapabilities(await settings(), input.engineId ?? "");
  if (capabilityReport !== undefined) {
    assertConfiguredCapabilitiesApplicable(capabilityReport);
    if (capabilityReport.skipped.length > 0) {
      console.warn(JSON.stringify({ event: "configuration.capabilities.skipped", ...capabilityReport }));
    }
  }
  if (new Set(tools.map((entry) => entry.id)).size !== tools.length) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Tool identifiers must be unique.", 400);
  }
  // One structure for both consumers: `authorize()` answers from it, and the same object is published on the
  // IntegrationContext for an Engine Pack to project into its native permission block. Deriving the decision
  // from anything else is what let a deployment override reach the gateway but not the engine.
  const operationOverrides = overrides(environment.PNP_CONFIGURED_POLICY_OVERRIDES);
  const permissionPolicy: PermissionPolicy = {
    default: configuredPolicy.default,
    operations: { ...configuredPolicy.operations, ...operationOverrides },
  };
  const decide = (operation: string): AuthorizationDecision => {
    const effect = permissionPolicy.operations[operation];
    if (effect === undefined) return { effect: permissionPolicy.default, reasonCode: "SETTINGS_DEFAULT" };
    return { effect, reasonCode: Object.hasOwn(operationOverrides, operation) ? "CONFIGURED_OVERRIDE" : "SETTINGS_OPERATION" };
  };
  // The evaluator supplies model identifiers this deployment does not control, so an unconfigured
  // selection falls back to the effective default model (docs/engineering-review-3.md section 7,
  // R2). A deployment that would rather answer 403 sets PNP_MODEL_STRICT=1.
  const strictModel = environment.PNP_MODEL_STRICT === "1";
  return new ConfiguredIntegration(
    models, tools, decide, environment, strictModel, defaultSelection, permissionPolicy, instructions, capabilityReport,
  );
}

/**
 * A provider may optionally implement a startup reachability probe. `IntegrationProvider` itself
 * is not extended with this method (that interface lives in ../contracts/index.ts, outside this
 * package's edit boundary); callers that want to probe use this local, duck-typed extension.
 */
export interface ProbeableIntegration extends IntegrationProvider { probe?(): Promise<void> }
/**
 * Startup-time reachability check for the loaded integration provider. Call this once, after
 * `loadIntegration()` and before the gateway starts listening, so an unusable provider fails fast
 * at boot instead of on the first prompt (see docs/engineering-review-2.md §3 and §6.3).
 *
 * `InternalIntegration` has no real implementation yet — its `prepare()` unconditionally throws
 * 503 — so it is always reported as unavailable here, regardless of whether a `probe` method is
 * ever added to it. Other providers are probed via their optional `probe()` method, if present;
 * providers without one (e.g. `MockIntegration`) are treated as available.
 *
 * Wiring note for main.ts: call `await probeIntegration(provider)` right after
 * `await loadIntegration(...)` and before `app.listen(...)`; let a thrown PnpError abort startup
 * the same way other boot-time failures already do.
 */
export async function probeIntegration(provider: IntegrationProvider): Promise<void> {
  if (provider instanceof InternalIntegration) {
    throw new PnpError("INTEGRATION_UNAVAILABLE", "Internal model, tool and policy integration is not implemented; refusing to start.", 503);
  }
  const probeable = provider as ProbeableIntegration;
  if (typeof probeable.probe === "function") await probeable.probe();
}
