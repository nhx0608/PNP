import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PnpError } from "../../core/errors.ts";

/**
 * Shape of `config/engines/opencode.json`. This is trusted, operator-authored configuration (never user input):
 * it names candidate executable locations and redirection keys, it never carries a credential (see docs/engines/opencode.md).
 */
export interface OpenCodeExecutableSource {
  configuredPath: string | null;
  environmentVariable: string;
  wellKnownPaths: readonly string[];
}
export interface OpenCodeNodeSource extends OpenCodeExecutableSource {
  fallbackToHostRuntime: boolean;
}
/**
 * Whether the generated private config asks OpenCode to request permission before editing or running commands.
 * OpenCode allows every operation by default, so "engine-default" writes no `permission` block and the engine
 * never raises ACP `session/request_permission`; "ask" writes `{"edit":"ask","bash":"ask"}` so the request
 * actually reaches the gateway and its policy layer decides allow/ask/deny.
 */
export type OpenCodeNativePermissions = "engine-default" | "ask";
/**
 * Deployment override for `nativePermissions`, read when the engine config is loaded. Turning engine-side
 * prompting on is a deployment decision (a smoke run that has to exercise the approval loop, an operator who
 * wants every edit approved) and it must not require editing a file that is checked in. Unset or empty means
 * "use the file"; anything but the two documented values is a configuration error, never a silent default.
 */
export const NATIVE_PERMISSIONS_ENVIRONMENT_VARIABLE = "PNP_OPENCODE_NATIVE_PERMISSIONS";
export interface OpenCodeEngineConfig {
  id: "opencode";
  channel: "acp";
  implementationEntry: string;
  engineVersion: string;
  engineVersionLocked: boolean;
  protocolVersion: number;
  distribution: {
    kind: string;
    packageNameCandidates: readonly string[];
    windowsNativeSupport: string;
  };
  acp: { subcommandArgs: readonly string[] };
  executable: {
    kindEnvironmentVariable: string;
    defaultKind: "exe" | "node-script";
    exe: OpenCodeExecutableSource;
    node: OpenCodeNodeSource;
    script: OpenCodeExecutableSource;
  };
  /** Optional in the file; absent means "engine-default". */
  nativePermissions: OpenCodeNativePermissions;
  redirect: { variables: Readonly<Record<string, string>> };
  model: { policy: "launch" | "session-config" };
  headerEnvironmentPrefix: string;
  timeouts: { requestMs: number; cancelGraceMs: number; cancelAckMs: number };
  capabilityEvidence: "declared" | "probed" | "verified" | "unverified";
}

function invalid(detail: string): never {
  throw new PnpError("ENGINE_CONFIG_INVALID", `config/engines/opencode.json is invalid: ${detail}`, 500);
}
function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(`"${field}" must be a non-empty string.`);
  return value as string;
}
function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) invalid(`"${field}" must be an array of strings.`);
  return value as string[];
}
function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`"${field}" must be an object.`);
  return value as Record<string, unknown>;
}
function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(`"${field}" must be a boolean.`);
  return value as boolean;
}
function requireNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requireString(value, field);
}
function requireExecutableSource(value: unknown, field: string): OpenCodeExecutableSource {
  const raw = requireObject(value, field);
  return {
    configuredPath: requireNullableString(raw["configuredPath"], `${field}.configuredPath`),
    environmentVariable: requireString(raw["environmentVariable"], `${field}.environmentVariable`),
    wellKnownPaths: requireStringArray(raw["wellKnownPaths"], `${field}.wellKnownPaths`),
  };
}
function requireNodeSource(value: unknown, field: string): OpenCodeNodeSource {
  const raw = requireObject(value, field);
  return {
    ...requireExecutableSource(raw, field),
    fallbackToHostRuntime: requireBoolean(raw["fallbackToHostRuntime"], `${field}.fallbackToHostRuntime`),
  };
}

/** Pure validation, exercised directly by tests without touching the filesystem. */
export function parseOpenCodeEngineConfig(raw: unknown): OpenCodeEngineConfig {
  const root = requireObject(raw, "$");
  if (root["id"] !== "opencode") invalid('"id" must be "opencode".');
  if (root["channel"] !== "acp") invalid('"channel" must be "acp".');
  const distributionRaw = requireObject(root["distribution"], "distribution");
  const acpRaw = requireObject(root["acp"], "acp");
  const executableRaw = requireObject(root["executable"], "executable");
  const nodeSource = requireNodeSource(executableRaw["node"], "executable.node");
  const redirectRaw = requireObject(root["redirect"], "redirect");
  const variablesRaw = requireObject(redirectRaw["variables"], "redirect.variables");
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(variablesRaw)) variables[key] = requireString(value, `redirect.variables.${key}`);
  const modelRaw = requireObject(root["model"], "model");
  const modelPolicy = modelRaw["policy"];
  if (modelPolicy !== "launch" && modelPolicy !== "session-config") invalid('"model.policy" must be "launch" or "session-config".');
  const nativePermissionsRaw = root["nativePermissions"];
  if (nativePermissionsRaw !== undefined && nativePermissionsRaw !== "engine-default" && nativePermissionsRaw !== "ask") {
    invalid('"nativePermissions" must be "engine-default" or "ask" when present.');
  }
  const timeoutsRaw = requireObject(root["timeouts"], "timeouts");
  const defaultKind = executableRaw["defaultKind"];
  if (defaultKind !== "exe" && defaultKind !== "node-script") invalid('"executable.defaultKind" must be "exe" or "node-script".');
  const evidence = root["capabilityEvidence"];
  if (evidence !== "declared" && evidence !== "probed" && evidence !== "verified" && evidence !== "unverified") {
    invalid('"capabilityEvidence" must be one of declared|probed|verified|unverified.');
  }
  return {
    id: "opencode",
    channel: "acp",
    implementationEntry: requireString(root["implementationEntry"], "implementationEntry"),
    engineVersion: requireString(root["engineVersion"], "engineVersion"),
    engineVersionLocked: requireBoolean(root["engineVersionLocked"], "engineVersionLocked"),
    protocolVersion: (() => {
      const value = root["protocolVersion"];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) invalid('"protocolVersion" must be a positive integer.');
      return value as number;
    })(),
    distribution: {
      kind: requireString(distributionRaw["kind"], "distribution.kind"),
      packageNameCandidates: requireStringArray(distributionRaw["packageNameCandidates"], "distribution.packageNameCandidates"),
      windowsNativeSupport: requireString(distributionRaw["windowsNativeSupport"], "distribution.windowsNativeSupport"),
    },
    acp: { subcommandArgs: requireStringArray(acpRaw["subcommandArgs"], "acp.subcommandArgs") },
    executable: {
      kindEnvironmentVariable: requireString(executableRaw["kindEnvironmentVariable"], "executable.kindEnvironmentVariable"),
      defaultKind,
      exe: requireExecutableSource(executableRaw["exe"], "executable.exe"),
      node: nodeSource,
      script: requireExecutableSource(executableRaw["script"], "executable.script"),
    },
    nativePermissions: nativePermissionsRaw === "ask" ? "ask" : "engine-default",
    redirect: { variables },
    model: { policy: modelPolicy },
    headerEnvironmentPrefix: requireString(root["headerEnvironmentPrefix"], "headerEnvironmentPrefix"),
    timeouts: {
      requestMs: requireTimeout(timeoutsRaw["requestMs"], "timeouts.requestMs"),
      cancelGraceMs: requireTimeout(timeoutsRaw["cancelGraceMs"], "timeouts.cancelGraceMs"),
      cancelAckMs: requireTimeout(timeoutsRaw["cancelAckMs"], "timeouts.cancelAckMs"),
    },
    capabilityEvidence: evidence,
  };
}
function requireTimeout(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) invalid(`"${field}" must be a positive number.`);
  return value as number;
}

/**
 * Applies the `PNP_OPENCODE_NATIVE_PERMISSIONS` override to a parsed config. Pure, so the precedence is
 * testable without a filesystem: an unset or empty variable leaves the file's value alone, a valid one replaces
 * it, and an unrecognised one fails the load instead of being rounded down to "engine-default" — an operator
 * who asked for prompting must never get an engine that silently allows everything.
 */
export function applyOpenCodeEnvironmentOverrides(config: OpenCodeEngineConfig,
  environment: Readonly<Record<string, string | undefined>>): OpenCodeEngineConfig {
  const requested = environment[NATIVE_PERMISSIONS_ENVIRONMENT_VARIABLE];
  if (requested === undefined || requested === "") return config;
  if (requested !== "engine-default" && requested !== "ask") {
    throw new PnpError("ENGINE_CONFIG_INVALID",
      `${NATIVE_PERMISSIONS_ENVIRONMENT_VARIABLE} must be "engine-default" or "ask" when set.`, 500);
  }
  if (requested === config.nativePermissions) return config;
  return { ...config, nativePermissions: requested };
}

const CONFIG_URL = new URL("../../../config/engines/opencode.json", import.meta.url);

/**
 * Loads and validates the operator-authored engine config, then applies the environment overrides. Never caches
 * across calls: config is cheap to re-read, tests must see edits, and the environment can change between runs.
 */
export async function loadOpenCodeEngineConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env): Promise<OpenCodeEngineConfig> {
  let text: string;
  try {
    text = await readFile(fileURLToPath(CONFIG_URL), "utf8");
  } catch (error) {
    throw new PnpError("ENGINE_CONFIG_MISSING", `config/engines/opencode.json could not be read: ${error instanceof Error ? error.message : String(error)}`, 500);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PnpError("ENGINE_CONFIG_INVALID", `config/engines/opencode.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 500);
  }
  return applyOpenCodeEnvironmentOverrides(parseOpenCodeEngineConfig(raw), environment);
}
