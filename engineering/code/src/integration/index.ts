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

/** `src/integration/` in the source tree and `dist/integration/` in a build both sit one level
 *  below the package root, so the shipped profile is found the same way in either. */
const codeRoot = fileURLToPath(new URL("../../", import.meta.url));
/**
 * The integration is shipped configuration, not a code delivery: an operator who follows
 * INSTRUCTION.md gets this profile without setting anything (docs/engineering-review-3.md section
 * 7, R3). It names environment variables instead of carrying an endpoint or a credential, so the
 * public repository holds no deployment address; the values only ever exist in the process
 * environment, and `probeIntegration` refuses to start when one of them is missing.
 */
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
/**
 * A model declares its endpoint either literally or, like its headers, by the NAME of an
 * environment variable holding it. Exactly one form is allowed. A literal endpoint is checked
 * against the transport rule here; a variable-backed one is checked against the same rule the
 * moment it resolves (ConfiguredIntegration.endpointOf), because its value exists only in the
 * process environment.
 */
function model(value: unknown): ConfiguredModel {
  const item = object(value, "model");
  exactKeys(item, ["selection", "endpoint", "endpointEnvironment", "protocol", "headerEnvironment"], "model");
  const protocol = string(item.protocol, "model.protocol");
  if (protocol !== "openai-chat" && protocol !== "anthropic-messages") {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported model protocol.", 400);
  }
  const hasEndpoint = Object.hasOwn(item, "endpoint");
  const hasEndpointEnvironment = Object.hasOwn(item, "endpointEnvironment");
  if (hasEndpoint === hasEndpointEnvironment) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "A model needs exactly one of endpoint and endpointEnvironment.", 400);
  }
  const common: Pick<ConfiguredModel, "selection" | "protocol" | "headerEnvironment"> = {
    selection: selection(item.selection), protocol, headerEnvironment: headers(item.headerEnvironment),
  };
  if (hasEndpointEnvironment) {
    return { ...common, endpointEnvironment: string(item.endpointEnvironment, "model.endpointEnvironment") };
  }
  const endpoint = string(item.endpoint, "model.endpoint");
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new PnpError("INTEGRATION_CONFIG_INVALID", "Model endpoint must be a valid URL.", 400); }
  if (!(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Model endpoint is not an approved transport.", 400);
  }
  return { ...common, endpoint };
}

/**
 * Deployment-side operation policy, supplied as JSON in `PNP_CONFIGURED_POLICY_OVERRIDES` so a
 * deployment can put one operation on "ask" without forking the shipped profile. It is the same
 * trust level as the profile file (both are set by whoever runs the gateway) and it is applied at
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
    const effect = string(value, `PNP_CONFIGURED_POLICY_OVERRIDES.${operation}`);
    if (!EFFECTS.includes(effect as Effect)) {
      throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported operation policy.", 400);
    }
    result[operation] = effect as Effect;
  }
  return result;
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
  // Unlike mock, configured carries no development-mode gate: it reads its profile from an
  // absolute path, references secrets only by environment variable name, and restricts model
  // endpoints to https or loopback — the same trust model as the internal provider. A real
  // (non-mock) engine must have a usable model path in a non-development deployment, and
  // configured is currently the only one that is actually implemented.
  // An unset PNP_CONFIGURED_PROFILE (or an empty one) means the shipped profile; an explicit
  // absolute path still wins.
  const environment = input.environment ?? process.env;
  const profilePath = input.configuredProfile === undefined || input.configuredProfile.trim() === ""
    ? DEFAULT_CONFIGURED_PROFILE : input.configuredProfile;
  if (!path.isAbsolute(profilePath)) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "PNP_CONFIGURED_PROFILE must be an absolute path.", 400);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(profilePath, "utf8")); }
  catch { throw new PnpError("INTEGRATION_CONFIG_INVALID", "Configured integration profile could not be loaded.", 400); }
  const profile = object(parsed, "profile");
  exactKeys(profile, ["models", "tools", "policy"], "profile");
  if (!Array.isArray(profile.models) || profile.models.length === 0) throw new PnpError("INTEGRATION_CONFIG_INVALID", "At least one model is required.", 400);
  if (!Array.isArray(profile.tools)) throw new PnpError("INTEGRATION_CONFIG_INVALID", "tools must be an array.", 400);
  const policy = object(profile.policy, "policy");
  exactKeys(policy, ["default", "operations"], "policy");
  const defaultEffect = string(policy.default, "policy.default");
  if (!EFFECTS.includes(defaultEffect as Effect)) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported default policy.", 400);
  }
  const configuredOperations: Record<string, Effect> = {};
  for (const [operation, configured] of Object.entries(object(policy.operations, "policy.operations"))) {
    const effect = string(configured, `policy.operations.${operation}`);
    if (!EFFECTS.includes(effect as Effect)) {
      throw new PnpError("INTEGRATION_CONFIG_INVALID", "Unsupported operation policy.", 400);
    }
    configuredOperations[operation] = effect as Effect;
  }
  const operationOverrides = overrides(environment.PNP_CONFIGURED_POLICY_OVERRIDES);
  const models = profile.models.map(model);
  const tools = profile.tools.map((value) => tool(value, environment));
  if (new Set(models.map((entry) => `${entry.selection.providerID}\0${entry.selection.modelID}`)).size !== models.length) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Model selections must be unique.", 400);
  }
  if (new Set(tools.map((entry) => entry.id)).size !== tools.length) {
    throw new PnpError("INTEGRATION_CONFIG_INVALID", "Tool identifiers must be unique.", 400);
  }
  const decide = (operation: string): AuthorizationDecision => {
    const overridden = operationOverrides[operation];
    if (overridden !== undefined) return { effect: overridden, reasonCode: "CONFIGURED_OVERRIDE" };
    const configured = configuredOperations[operation];
    if (configured !== undefined) return { effect: configured, reasonCode: "CONFIGURED_OPERATION" };
    return { effect: defaultEffect as Effect, reasonCode: "CONFIGURED_DEFAULT" };
  };
  // The evaluator supplies model identifiers this deployment does not control, so an unconfigured
  // selection falls back to the profile's default model (docs/engineering-review-3.md section 7,
  // R2). A deployment that would rather answer 403 sets PNP_MODEL_STRICT=1.
  const strictModel = environment.PNP_MODEL_STRICT === "1";
  return new ConfiguredIntegration(models, tools, decide, environment, strictModel);
}

/**
 * A provider may optionally implement a startup reachability probe. `IntegrationProvider` itself
 * is not extended with this method (that interface lives in ../contracts/index.ts, outside this
 * package's edit boundary); callers that want to probe use this local, duck-typed extension.
 */
export interface ProbeableIntegration extends IntegrationProvider {
  probe?(): Promise<void>;
}

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
