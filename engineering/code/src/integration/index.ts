import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthorizationDecision, IntegrationProvider, ModelSelection, ToolBinding } from "../contracts/index.ts";
import { PnpError } from "../core/errors.ts";
import { ConfiguredIntegration, type ConfiguredModel } from "./configured/provider.ts";
import { InternalIntegration } from "./internal/provider.ts";
import { MockIntegration } from "./mock/provider.ts";

type IntegrationKind = "internal" | "configured" | "mock";
type JsonObject = Record<string, unknown>;
type Effect = AuthorizationDecision["effect"];
const EFFECTS: readonly Effect[] = ["allow", "deny", "ask"];
const codeRoot = fileURLToPath(new URL("../../", import.meta.url));
export const DEFAULT_CONFIGURED_PROFILE = path.join(codeRoot, "config", "competition-profile.json");
export const DEFAULT_MODEL_SETTINGS = path.join(codeRoot, "config", "model-settings.json");

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PnpError("INTEGRATION_CONFIG_INVALID", `${label} must be an object.`, 400);
  return value as JsonObject;
}
function exactKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new PnpError("INTEGRATION_CONFIG_INVALID", `${label} contains an unknown field.`, 400);
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new PnpError("INTEGRATION_CONFIG_INVALID", `${label} must be a non-empty string.`, 400);
  return value;
}
function selection(value: unknown): ModelSelection {
  const item = object(value, "model.selection"); exactKeys(item, ["providerID", "modelID"], "model.selection");
  return { providerID: string(item.providerID, "providerID"), modelID: string(item.modelID, "modelID") };
}
function headers(value: unknown): Readonly<Record<string, string>> {
  const item = object(value, "headerEnvironment");
  return Object.fromEntries(Object.entries(item).map(([name, variable]) => [name, string(variable, `headerEnvironment.${name}`)]));
}
function model(value: unknown): ConfiguredModel {
  const item = object(value, "model"); exactKeys(item, ["selection", "endpoint", "endpointEnvironment", "protocol", "headerEnvironment"], "model");
  const protocol = string(item.protocol, "model.protocol");
  if (protocol !== "openai-chat" && protocol !== "anthropic-messages") throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported model protocol.", 400);
  const hasEndpoint = Object.hasOwn(item, "endpoint"); const hasEndpointEnvironment = Object.hasOwn(item, "endpointEnvironment");
  if (hasEndpoint === hasEndpointEnvironment) throw new PnpError("INTEGRATION_CONFIG_INVALID", "A model needs exactly one of endpoint and endpointEnvironment.", 400);
  const common = { selection: selection(item.selection), protocol: protocol as ConfiguredModel["protocol"], headerEnvironment: headers(item.headerEnvironment) };
  if (hasEndpointEnvironment) return { ...common, endpointEnvironment: string(item.endpointEnvironment, "model.endpointEnvironment") };
  const endpoint = string(item.endpoint, "model.endpoint");
  let url: URL; try { url = new URL(endpoint); } catch { throw new PnpError("INTEGRATION_CONFIG_INVALID", "Model endpoint must be a valid URL.", 400); }
  if (!(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Model endpoint is not an approved transport.", 400);
  return { ...common, endpoint };
}
async function readJson(file: string, label: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch { throw new PnpError("INTEGRATION_CONFIG_INVALID", `${label} could not be loaded.`, 400); }
}
async function loadModelSettings(file: string): Promise<{ models: ConfiguredModel[]; defaultSelection: ModelSelection }> {
  if (!path.isAbsolute(file)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "PNP_MODEL_SETTINGS must be an absolute path.", 400);
  const settings = object(await readJson(file, "Model settings"), "model settings"); exactKeys(settings, ["default", "models"], "model settings");
  if (!Array.isArray(settings.models) || settings.models.length === 0) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Model settings require at least one model.", 400);
  const models = settings.models.map(model); const defaultSelection = selection(settings.default);
  if (!models.some((entry) => entry.selection.providerID === defaultSelection.providerID && entry.selection.modelID === defaultSelection.modelID)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Default model must exist in model settings.", 400);
  if (new Set(models.map((entry) => `${entry.selection.providerID}\0${entry.selection.modelID}`)).size !== models.length) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Model selections must be unique.", 400);
  return { models, defaultSelection };
}
function overrides(raw: string | undefined): Record<string, Effect> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new PnpError("INTEGRATION_CONFIG_INVALID", "PNP_CONFIGURED_POLICY_OVERRIDES must be valid JSON.", 400); }
  const item = object(parsed, "PNP_CONFIGURED_POLICY_OVERRIDES"); const result: Record<string, Effect> = {};
  for (const [operation, value] of Object.entries(item)) { const effect = string(value, operation); if (!EFFECTS.includes(effect as Effect)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported operation policy.", 400); result[operation] = effect as Effect; }
  return result;
}
function tool(value: unknown, environment: NodeJS.ProcessEnv): ToolBinding {
  const item = object(value, "tool"); exactKeys(item, ["id", "transport", "command", "args", "env", "sideEffect", "timeoutMs"], "tool");
  const transport = string(item.transport, "tool.transport") as ToolBinding["transport"]; const sideEffect = string(item.sideEffect, "tool.sideEffect") as ToolBinding["sideEffect"]; const command = string(item.command, "tool.command");
  if (!path.isAbsolute(command)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Tool command must be absolute.", 400);
  if (!["mcp-stdio", "cli", "native"].includes(transport)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported tool transport.", 400);
  if (!["read", "write", "external"].includes(sideEffect)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported tool side effect.", 400);
  if (!Array.isArray(item.args) || !item.args.every((arg) => typeof arg === "string")) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Tool args must be strings.", 400);
  const resolvedEnvironment: Record<string, string> = {};
  for (const [name, variable] of Object.entries(headers(item.env))) { const resolved = environment[variable]; if (!resolved) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Required tool environment variable is absent.", 503); resolvedEnvironment[name] = resolved; }
  const timeoutMs = item.timeoutMs; if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Tool timeout must be a positive integer.", 400);
  return { id: string(item.id, "tool.id"), transport, command, args: item.args as string[], env: resolvedEnvironment, sideEffect, ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }) };
}

export async function loadIntegration(input: { kind: string | undefined; development: boolean; engineDevelopmentOnly: boolean; configuredProfile?: string; modelSettings?: string; environment?: NodeJS.ProcessEnv }): Promise<IntegrationProvider> {
  const kind = input.kind ?? (input.engineDevelopmentOnly ? "mock" : "configured");
  if (!(["internal", "configured", "mock"] as const).includes(kind as IntegrationKind)) throw new PnpError("INTEGRATION_NOT_FOUND", "Unknown integration profile.", 400);
  if (kind === "internal") return new InternalIntegration();
  if (kind === "mock") { if (!input.development || !input.engineDevelopmentOnly) throw new PnpError("MOCK_FORBIDDEN", "Mock integration requires the development mock engine.", 400); return new MockIntegration(); }
  const environment = input.environment ?? process.env;
  const explicitProfile = input.configuredProfile !== undefined && input.configuredProfile.trim() !== "";
  const profilePath = explicitProfile ? input.configuredProfile! : DEFAULT_CONFIGURED_PROFILE;
  if (!path.isAbsolute(profilePath)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "PNP_CONFIGURED_PROFILE must be an absolute path.", 400);
  const profile = object(await readJson(profilePath, "Configured integration profile"), "profile"); exactKeys(profile, ["models", "tools", "policy"], "profile");
  if (!Array.isArray(profile.tools)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "tools must be an array.", 400);
  const policy = object(profile.policy, "policy"); exactKeys(policy, ["default", "operations"], "policy");
  const defaultEffect = string(policy.default, "policy.default"); if (!EFFECTS.includes(defaultEffect as Effect)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported default policy.", 400);
  const configuredOperations: Record<string, Effect> = {};
  for (const [operation, configured] of Object.entries(object(policy.operations, "policy.operations"))) { const effect = string(configured, operation); if (!EFFECTS.includes(effect as Effect)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported operation policy.", 400); configuredOperations[operation] = effect as Effect; }
  const useSettings = input.modelSettings !== undefined && input.modelSettings.trim() !== "" ? input.modelSettings : (!explicitProfile ? DEFAULT_MODEL_SETTINGS : undefined);
  let models: ConfiguredModel[]; let defaultSelection: ModelSelection | undefined;
  if (useSettings !== undefined) ({ models, defaultSelection } = await loadModelSettings(useSettings));
  else {
    if (!Array.isArray(profile.models) || profile.models.length === 0) throw new PnpError("INTEGRATION_CONFIG_INVALID", "At least one model is required.", 400);
    models = profile.models.map(model);
    if (new Set(models.map((entry) => `${entry.selection.providerID}\0${entry.selection.modelID}`)).size !== models.length) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Model selections must be unique.", 400);
  }
  const tools = profile.tools.map((value) => tool(value, environment)); const operationOverrides = overrides(environment.PNP_CONFIGURED_POLICY_OVERRIDES);
  const decide = (operation: string): AuthorizationDecision => { const effect = operationOverrides[operation] ?? configuredOperations[operation] ?? defaultEffect as Effect; return { effect, reasonCode: operationOverrides[operation] !== undefined ? "CONFIGURED_OVERRIDE" : configuredOperations[operation] !== undefined ? "CONFIGURED_OPERATION" : "CONFIGURED_DEFAULT" }; };
  return new ConfiguredIntegration(models, tools, decide, environment, environment.PNP_MODEL_STRICT === "1", defaultSelection);
}

export interface ProbeableIntegration extends IntegrationProvider { probe?(): Promise<void> }
export async function probeIntegration(provider: IntegrationProvider): Promise<void> {
  if (provider instanceof InternalIntegration) throw new PnpError("INTEGRATION_UNAVAILABLE", "Internal model, tool and policy integration is not implemented; refusing to start.", 503);
  const probeable = provider as ProbeableIntegration; if (typeof probeable.probe === "function") await probeable.probe();
}
