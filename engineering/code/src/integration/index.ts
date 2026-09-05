import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AuthorizationDecision, IntegrationProvider, ModelSelection, ToolBinding } from "../contracts/index.ts";
import { PnpError } from "../core/errors.ts";
import { ConfiguredIntegration, type ConfiguredModel } from "./configured/provider.ts";
import { InternalIntegration } from "./internal/provider.ts";
import { MockIntegration } from "./mock/provider.ts";

type IntegrationKind = "internal" | "configured" | "mock";
type JsonObject = Record<string, unknown>;

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
  if (typeof value !== "string" || value.length === 0) throw new PnpError("INTEGRATION_CONFIG_INVALID", `${label} must be a non-empty string.`, 400);
  return value;
}
function selection(value: unknown): ModelSelection {
  const item = object(value, "model.selection");
  exactKeys(item, ["providerID", "modelID"], "model.selection");
  return { providerID: string(item.providerID, "providerID"), modelID: string(item.modelID, "modelID") };
}
function headers(value: unknown): Readonly<Record<string, string>> {
  const item = object(value, "headerEnvironment");
  return Object.fromEntries(Object.entries(item).map(([name, variable]) => [name, string(variable, `headerEnvironment.${name}`)]));
}
function model(value: unknown): ConfiguredModel {
  const item = object(value, "model");
  exactKeys(item, ["selection", "endpoint", "protocol", "headerEnvironment"], "model");
  const protocol = string(item.protocol, "model.protocol");
  if (protocol !== "openai-chat" && protocol !== "anthropic-messages") {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported model protocol.", 400);
  }
  const endpoint = string(item.endpoint, "model.endpoint");
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new PnpError("INTEGRATION_CONFIG_INVALID", "Model endpoint must be a valid URL.", 400); }
  if (!(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Model endpoint is not an approved transport.", 400);
  }
  return { selection: selection(item.selection), endpoint, protocol,
    headerEnvironment: headers(item.headerEnvironment) };
}
function tool(value: unknown, environment: NodeJS.ProcessEnv): ToolBinding {
  const item = object(value, "tool");
  exactKeys(item, ["id", "transport", "command", "args", "env", "sideEffect", "timeoutMs"], "tool");
  const transport = string(item.transport, "tool.transport");
  const sideEffect = string(item.sideEffect, "tool.sideEffect");
  const command = string(item.command, "tool.command");
  if (!path.isAbsolute(command)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Tool command must be absolute.", 400);
  if (!(["mcp-stdio", "cli", "native"] as const).includes(transport as ToolBinding["transport"])) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported tool transport.", 400);
  }
  if (!(["read", "write", "external"] as const).includes(sideEffect as ToolBinding["sideEffect"])) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported tool side effect.", 400);
  }
  if (!Array.isArray(item.args) || !item.args.every((arg) => typeof arg === "string")) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Tool args must be strings.", 400);
  }
  const timeoutMs = item.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0)) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Tool timeout must be a positive integer.", 400);
  }
  const environmentNames = headers(item.env);
  const resolvedEnvironment: Record<string, string> = {};
  for (const [name, variable] of Object.entries(environmentNames)) {
    const resolved = environment[variable];
    if (!resolved) throw new PnpError("INTEGRATION_CONFIG_INVALID", "Required tool environment variable is absent.", 503);
    resolvedEnvironment[name] = resolved;
  }
  return { id: string(item.id, "tool.id"), transport: transport as ToolBinding["transport"], command,
    args: item.args as string[], env: resolvedEnvironment, sideEffect: sideEffect as ToolBinding["sideEffect"],
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }) };
}

export async function loadIntegration(input: {
  kind: string | undefined;
  development: boolean;
  engineDevelopmentOnly: boolean;
  configuredProfile?: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<IntegrationProvider> {
  const kind = input.kind ?? (input.engineDevelopmentOnly ? "mock" : "internal");
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
  if (!input.development) throw new PnpError("CONFIGURED_FORBIDDEN", "Configured integration requires development mode.", 400);
  if (input.configuredProfile === undefined || !path.isAbsolute(input.configuredProfile)) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "PNP_CONFIGURED_PROFILE must be an absolute path.", 400);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(input.configuredProfile, "utf8")); }
  catch { throw new PnpError("INTEGRATION_CONFIG_INVALID", "Configured integration profile could not be loaded.", 400); }
  const profile = object(parsed, "profile");
  exactKeys(profile, ["models", "tools", "policy"], "profile");
  if (!Array.isArray(profile.models) || profile.models.length === 0) throw new PnpError("INTEGRATION_CONFIG_INVALID", "At least one model is required.", 400);
  if (!Array.isArray(profile.tools)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "tools must be an array.", 400);
  const policy = object(profile.policy, "policy");
  exactKeys(policy, ["default", "operations"], "policy");
  const defaultEffect = string(policy.default, "policy.default");
  if (!(["allow", "deny", "ask"] as const).includes(defaultEffect as AuthorizationDecision["effect"])) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported default policy.", 400);
  }
  const operations = object(policy.operations, "policy.operations");
  for (const [operation, configured] of Object.entries(operations)) {
    const effect = string(configured, `policy.operations.${operation}`);
    if (!(["allow", "deny", "ask"] as const).includes(effect as AuthorizationDecision["effect"])) {
      throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported operation policy.", 400);
    }
  }
  const models = profile.models.map(model);
  const environment = input.environment ?? process.env;
  const tools = profile.tools.map((value) => tool(value, environment));
  if (new Set(models.map((entry) => `${entry.selection.providerID}\0${entry.selection.modelID}`)).size !== models.length) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Model selections must be unique.", 400);
  }
  if (new Set(tools.map((entry) => entry.id)).size !== tools.length) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Tool identifiers must be unique.", 400);
  }
  const decide = (operation: string): AuthorizationDecision => {
    const configured = Object.hasOwn(operations, operation) ? operations[operation] : undefined;
    const effect = configured === undefined ? defaultEffect : string(configured, `policy.operations.${operation}`);
    if (!(["allow", "deny", "ask"] as const).includes(effect as AuthorizationDecision["effect"])) {
      return { effect: "deny", reasonCode: "INVALID_OPERATION_POLICY" };
    }
    return { effect: effect as AuthorizationDecision["effect"], reasonCode: configured === undefined ? "CONFIGURED_DEFAULT" : "CONFIGURED_OPERATION" };
  };
  return new ConfiguredIntegration(models, tools, decide, environment);
}
