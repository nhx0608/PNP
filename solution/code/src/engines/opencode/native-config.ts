import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { Json, PermissionEffect, PermissionPolicy, ResolvedModel } from "../../contracts/index.ts";
import { PnpError } from "../../core/errors.ts";
import type { OpenCodeEngineConfig, OpenCodeNativePermissions } from "./config.ts";

const OPENCODE_ROOT_SEGMENT = "opencode";
const NATIVE_CONFIG_FILENAME = "opencode.json";
const CONFIG_DIRECTORY_SEGMENT = "config";
/**
 * OpenCode's documented "custom path" discovery step (opencode.ai/docs/config/ "Custom path"): it names one
 * exact file and needs no guess about where a config home lives on Windows. Confirmed honoured by a real
 * opencode 1.18.29 process. This is the primary route to the private config; the mirrored config home is only
 * a fallback.
 */
export const OPENCODE_CONFIG_ENVIRONMENT_VARIABLE = "OPENCODE_CONFIG";
/**
 * The documented "Custom directory" step: "Specify a custom config directory using the `OPENCODE_CONFIG_DIR`
 * environment variable. This directory will be searched for agents, commands, modes, and plugins just like the
 * standard `.opencode` directory, and should follow the same structure." (opencode.ai/docs/config/, quoted from
 * the upstream config reference). Together with the XDG redirects it replaces the former HOME/USERPROFILE/APPDATA
 * redirects as the way this Pack keeps OpenCode's own discovery inside the session-private tree: the real user
 * profile now stays visible to anything the model launches (Office COM, Outlook), which those redirects broke.
 */
export const OPENCODE_CONFIG_DIRECTORY_ENVIRONMENT_VARIABLE = "OPENCODE_CONFIG_DIR";
const ALLOW_ALL: PermissionPolicy = { default: "allow", operations: {} };

/** Environment-variable substitution understood by OpenCode's config loader. `$VAR` is NOT expanded. */
export function environmentToken(variableName: string): string {
  return `{env:${variableName}}`;
}

/**
 * Where this session's private OpenCode environment lives, and the env vars that point OpenCode there instead
 * of the operator's real profile. All paths are rooted under `EngineOpenInput.nativeDataDirectory`, never under
 * the user's workspace (`Session.directory`) and never under the gateway host's real HOME/APPDATA.
 */
export interface RedirectPlan {
  /** Env var name -> absolute private directory, from `config/engines/opencode.json#redirect.variables`. Applied
   *  on top of the shared host's baseEnvironment(). HOME/USERPROFILE/APPDATA/LOCALAPPDATA are deliberately NOT
   *  in that list any more: the child must see the operator's real profile so Office COM / Outlook and anything
   *  else the model launches find their per-user state (docs/competition-readiness.md B8, D4). */
  env: Readonly<Record<string, string>>;
  /** The one deterministic file OPENCODE_CONFIG points at. Discovery does not depend on guessing a config home. */
  configFile: string;
  /**
   * The session-private directory OPENCODE_CONFIG_DIR points at, structured like a `.opencode` directory
   * (`skills/`, `agents/`, `commands/`, `plugins/`, ...). Always inside the private native tree.
   */
  configDirectory: string;
  /**
   * "Config home" roots the same config content is mirrored into, one `opencode/opencode.json` per root. This is
   * the second step of OpenCode's documented discovery order (remote `.well-known` -> global
   * `<config home>/opencode/opencode.json` -> `OPENCODE_CONFIG` -> project `opencode.json` -> `.opencode` ->
   * `OPENCODE_CONFIG_CONTENT` -> managed config), not a guess: the engine's global directory module resolves its
   * config home as `XDG_CONFIG_HOME || ~/.config` with no platform branch, so a redirected XDG_CONFIG_HOME *is*
   * the global config location. Verified on a real 1.18.29 process, which loaded this mirror with OPENCODE_CONFIG
   * removed from its environment. Only redirected roots are listed: with HOME no longer redirected, the
   * operator's real `~/.config` must never be written to. See docs/engines/opencode.md #3.
   */
  configRoots: readonly string[];
  /** Every directory a projected skill is copied into, so assets.ts and this module agree without shared state. */
  skillRoots: readonly string[];
}
export function buildRedirectPlan(nativeDataDirectory: string, config: OpenCodeEngineConfig): RedirectPlan {
  const base = path.join(nativeDataDirectory, OPENCODE_ROOT_SEGMENT);
  const env: Record<string, string> = {};
  for (const [variable, subdirectory] of Object.entries(config.redirect.variables)) {
    env[variable] = path.join(base, subdirectory);
  }
  const configDirectory = path.join(base, CONFIG_DIRECTORY_SEGMENT);
  // A config home is only a mirror target when this Pack owns it. `env["HOME"]` is present only if a deployment
  // put HOME back into redirect.variables; the shipped config does not, so the sole mirror is the XDG one.
  const redirectedHome = env["HOME"];
  const configRoots = [...new Set([
    ...(env["XDG_CONFIG_HOME"] === undefined ? [] : [env["XDG_CONFIG_HOME"]]),
    ...(redirectedHome === undefined ? [] : [path.join(redirectedHome, ".config")]),
  ])];
  const skillRoots = [
    path.join(configDirectory, "skills"),
    ...configRoots.map((root) => path.join(root, OPENCODE_ROOT_SEGMENT, "skills")),
  ];
  return { env, configFile: path.join(base, NATIVE_CONFIG_FILENAME), configDirectory, configRoots, skillRoots };
}

/**
 * How the generated config's `shell` value is decided. Injectable so both outcomes are covered by tests on any
 * host OS: the probe never touches the real filesystem in a test, and the Windows branch is exercised on Linux.
 */
export interface NativeShellProbe {
  platform: string;
  environment: Readonly<Record<string, string | undefined>>;
  /** True when the absolute path names an existing file. */
  fileExists: (candidate: string) => boolean;
}
export function defaultShellProbe(): NativeShellProbe {
  return { platform: process.platform, environment: process.env, fileExists: (candidate) => existsSync(candidate) };
}
/** Git for Windows' two shipped bash.exe locations, in the order Git's own installer creates them. */
const WINDOWS_BASH_CANDIDATES: readonly string[] = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
];
const WINDOWS_POWERSHELL_SUFFIX = "System32\\WindowsPowerShell\\v1.0\\powershell.exe";
function withoutTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/, "");
}
/**
 * Decides the `shell` entry of the generated opencode.json.
 *
 * Upstream reference, "Shell" section: "You can configure the shell used for the interactive terminal using the
 * `shell` option. Compatible shells are also used for agent tool calls." and "If not specified, OpenCode will
 * automatically discover and use a sensible default based on your operating system (e.g. `pwsh` or `cmd.exe` on
 * Windows ...). You can provide an absolute path or a short name." (opencode.ai/docs/config/ #Shell.)
 *
 * The competition sandbox cannot be assumed to have Git Bash, and a `bash` tool call that lands on a missing
 * shell is a lost task, not a recoverable error. So on win32 with no bash.exe in either Git for Windows
 * location and none on PATH, the shell is pinned to the absolute path of Windows PowerShell 5.1, which ships
 * with the OS. When bash.exe is present the field is left out and OpenCode keeps its own discovery; off win32
 * the field is left out as well.
 */
export function resolveNativeShell(probe: NativeShellProbe = defaultShellProbe()): string | undefined {
  if (probe.platform !== "win32") return undefined;
  for (const candidate of WINDOWS_BASH_CANDIDATES) if (probe.fileExists(candidate)) return undefined;
  // Windows PATH is ";"-separated regardless of the host this code is compiled on, and entries may be quoted.
  const pathValue = probe.environment["PATH"] ?? probe.environment["Path"] ?? "";
  for (const entry of pathValue.split(";")) {
    const directory = withoutTrailingSeparators(entry.trim().replaceAll('"', ""));
    if (directory.length === 0) continue;
    if (probe.fileExists(`${directory}\\bash.exe`)) return undefined;
  }
  const systemRoot = probe.environment["SystemRoot"] ?? probe.environment["windir"] ?? "C:\\Windows";
  return `${withoutTrailingSeparators(systemRoot)}\\${WINDOWS_POWERSHELL_SUFFIX}`;
}

function sanitizeEnvSuffix(name: string): string {
  const cleaned = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+/, "").replace(/_+$/, "");
  return cleaned.length > 0 ? cleaned : "HEADER";
}
/** `Bearer <token>`, case-insensitive, with the separating whitespace consumed. */
const BEARER_SCHEME = /^bearer\s+/i;

export interface HeaderEnvMapping {
  /** Original header name -> the `{env:VARNAME}` token for `options.headers` (never the header value). */
  configTokens: Readonly<Record<string, string>>;
  /** Env var name -> the real secret value. Only ever placed in LaunchSpec.env for the child process. */
  secretEnv: Readonly<Record<string, string>>;
  /** Env var backing the provider's `options.apiKey` field. */
  apiKeyEnvName: string;
  /** Whether apiKey carries a real credential or a non-secret placeholder. */
  apiKeySource: "bearer-token" | "placeholder";
}
/**
 * Maps every resolved header to its own env var so the private config file never carries a literal secret.
 *
 * `Authorization: Bearer <token>` is special-cased, and the reason is measured, not theoretical: the
 * `@ai-sdk/openai-compatible` provider composes `Authorization: Bearer <apiKey>` itself. Feeding it the whole
 * header value produced `Authorization: Bearer Bearer <token>` on the wire against a real opencode 1.18.29 run.
 * So the bearer prefix is stripped, the bare token backs `options.apiKey`, and no `Authorization` entry is
 * emitted in `options.headers` -- the provider writes that header, and a duplicate would fight it.
 *
 * An `Authorization` header with any other scheme is left as an ordinary header (`{env:}` in `options.headers`)
 * and apiKey keeps its non-secret placeholder: that route has not been observed end to end, so it fails visibly
 * rather than silently mangling a credential.
 */
export function mapHeadersToEnv(headers: Readonly<Record<string, string>>, prefix: string): HeaderEnvMapping {
  const configTokens: Record<string, string> = {};
  const secretEnv: Record<string, string> = {};
  const used = new Set<string>();
  const allocate = (suffix: string): string => {
    let envName = `${prefix}${suffix}`;
    let attempt = 2;
    while (used.has(envName)) {
      envName = `${prefix}${suffix}_${String(attempt)}`;
      attempt += 1;
    }
    used.add(envName);
    return envName;
  };
  let apiKeyEnvName: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "authorization" && apiKeyEnvName === undefined) {
      const scheme = BEARER_SCHEME.exec(value);
      if (scheme !== null) {
        apiKeyEnvName = allocate("API_KEY");
        secretEnv[apiKeyEnvName] = value.slice(scheme[0].length);
        continue;
      }
    }
    const envName = allocate(sanitizeEnvSuffix(name));
    configTokens[name] = environmentToken(envName);
    secretEnv[envName] = value;
  }
  if (apiKeyEnvName !== undefined) return { configTokens, secretEnv, apiKeyEnvName, apiKeySource: "bearer-token" };
  const placeholder = allocate("APIKEY_UNUSED");
  secretEnv[placeholder] = "unused";
  return { configTokens, secretEnv, apiKeyEnvName: placeholder, apiKeySource: "placeholder" };
}

/**
 * OpenCode provider entries pick an `@ai-sdk/*` package (docs/research/G02-internal-model-endpoint-compat.md
 * #16, T03-opencode.md #177). Only protocols with a source-confirmed mapping are supported; anything else fails
 * closed rather than guessing a wire format.
 */
const PROTOCOL_TO_PROVIDER_PACKAGE: Readonly<Record<string, string>> = {
  "openai-chat": "@ai-sdk/openai-compatible",
  "anthropic-messages": "@ai-sdk/anthropic",
};
export function resolveProviderPackage(protocol: ResolvedModel["protocol"]): string {
  const npm = PROTOCOL_TO_PROVIDER_PACKAGE[protocol];
  if (npm === undefined) {
    throw new PnpError("ENGINE_MODEL_PROTOCOL_UNSUPPORTED",
      `OpenCode Pack has no verified provider mapping for model protocol "${protocol}". Supported: ${Object.keys(PROTOCOL_TO_PROVIDER_PACKAGE).join(", ")}.`, 502);
  }
  return npm;
}

/**
 * PNP permissions are resolved before the Engine Pack. OpenCode still needs a native permission block for any
 * operation that must reach the gateway: for most operations OpenCode's own default is allow, so the gateway
 * would never get a chance to apply an `ask` or `deny` policy. A PNP deny is therefore projected as native
 * `ask`; the gateway remains the authority and returns the denial. Core-specific operation names are preferred.
 * A few stable aliases are mapped to OpenCode's names so common settings can cover the obvious file/shell cases.
 */
function openCodePermissionName(operation: string): string {
  const aliases: Readonly<Record<string, string>> = {
    write: "edit",
    patch: "edit",
    "file.write": "edit",
    "file.read": "read",
    shell: "bash",
    "shell.execute": "bash",
    "web.fetch": "webfetch",
    "web.search": "websearch",
    subagent: "task",
  };
  return aliases[operation] ?? operation;
}
function nativeEffect(effect: PermissionEffect): "allow" | "ask" {
  return effect === "allow" ? "allow" : "ask";
}
/** OpenCode's permission key for touching paths outside the session directory (T03-opencode.md line 151). */
const EXTERNAL_DIRECTORY_PERMISSION = "external_directory";
/** OpenCode's name for the tool that asks the user a question; always disabled, see buildNativeConfigPayload. */
export const QUESTION_TOOL = "question";
/**
 * Projects the effective PNP policy into OpenCode's `permission` block.
 *
 * "OpenCode allows everything by default" -- which is what the upstream config reference says under
 * "Permissions" ("By default, opencode **allows all operations** without requiring explicit approval") -- is
 * not literally true, and the difference decides whether an unattended run can do its job: `external_directory`
 * and `doom_loop` default to `ask`, and reading `.env` defaults to `deny` (docs/research/T03-opencode.md line
 * 151, cross-checked against opencode's permissions docs). `external_directory` is the one that matters here,
 * because every evaluation task reads or writes absolute paths outside the session directory and there is
 * nobody at the keyboard to answer. So whenever the effective policy default is `allow` and no operation names
 * `external_directory`, it is written out explicitly as `allow`. A policy that does name that operation, or one
 * whose default is not `allow`, is projected untouched: an operator who asked for prompting never gets it
 * silently removed.
 *
 * `external_directory` is also the one name for which an explicit `allow` under an `allow` default is not
 * redundant, so it is the one name the generic "same as the default, leave it out" rule does not drop.
 */
export function buildNativePermissionConfig(
  policy: PermissionPolicy,
  legacyNativePermissions: OpenCodeNativePermissions = "engine-default",
): Json | undefined {
  const projected: Record<string, "allow" | "ask"> = {};
  if (policy.default !== "allow") projected["*"] = "ask";
  for (const [operation, effect] of Object.entries(policy.operations)) {
    const name = openCodePermissionName(operation);
    const value = nativeEffect(effect);
    // Redundant with the default for every other key; for external_directory the engine default is `ask`, so
    // dropping an explicit allow here would silently turn the operator's allow into a prompt nobody answers.
    if (policy.default === "allow" && value === "allow" && name !== EXTERNAL_DIRECTORY_PERMISSION) continue;
    const existing = projected[name];
    projected[name] = existing === "ask" || value === "ask" ? "ask" : "allow";
  }
  const namesExternalDirectory = Object.keys(policy.operations)
    .some((operation) => openCodePermissionName(operation) === EXTERNAL_DIRECTORY_PERMISSION);
  if (policy.default === "allow" && !namesExternalDirectory) projected[EXTERNAL_DIRECTORY_PERMISSION] = "allow";
  // Compatibility with the old deployment switch. It can force prompts on, but it can no longer turn off
  // prompts required by unified settings.
  if (legacyNativePermissions === "ask") {
    projected.edit = "ask";
    projected.bash = "ask";
  }
  return Object.keys(projected).length === 0 ? undefined : projected;
}

export interface NativeConfigPayload {
  json: Json;
  /** Header env vars to merge into LaunchSpec.env. Never present in `json`. */
  secretEnv: Readonly<Record<string, string>>;
}
/**
 * Builds the private opencode.json content. `apiKey` and every provider header are `{env:VARNAME}` tokens --
 * the substitution syntax OpenCode actually implements; `$VAR` is passed through literally and would ship a
 * useless string to the model endpoint. The real values only ever exist in the child process's environment.
 *
 * A custom OpenAI-compatible provider requires `npm`, a display `name`, `options.baseURL` and a display `name`
 * on each model, so all four are written. `share` is pinned to "disabled": nothing about a competition-session
 * prompt should leave the host via opencode's share links. `permission` carries the projected policy plus the
 * explicit `external_directory` allow (see buildNativePermissionConfig); with no block at all the engine never
 * raises ACP `session/request_permission`, and `external_directory` would stay at its native `ask`.
 *
 * `tools` disables the `question` tool. Two independent sources fix the shape and the name. The upstream config
 * reference, "Tools" section: "You can manage the tools an LLM can use through the `tools` option", with the
 * example `"tools": { "write": false, "bash": false }` -- a map of tool name -> boolean (opencode.ai/docs/config/
 * #Tools). And the config schema the 1.18.29 binary itself publishes, where `tools` is
 * `{"type":"object","additionalProperties":{"type":"boolean"}}` and `question` is one of the named permission
 * keys next to `external_directory`, `doom_loop`, `bash` and the rest; the TUI in the same binary registers a
 * renderer under `{name:"question"}`, and the channel is `question.asked` + `POST /question/{id}/reply`
 * (docs/research/T03-opencode.md lines 40, 151, 161). The gateway runs unattended: a question would block the run
 * until the interaction deadline and then be answered as a refusal, so the tool must not exist for the model in
 * the first place. This is a guard, not an observed removal -- a real 1.18.29 ACP run on Linux offered the model
 * `bash, edit, glob, grep, read, skill, task, todowrite, webfetch, write` and no `question` with or without the
 * key, so the ACP route may not register it at all; the config is accepted either way.
 *
 * `shell` is written only when resolveNativeShell decides one is needed (win32 without bash.exe).
 *
 * `instructions` lists the absolute path of every instruction asset this Pack projected, in the order the
 * assets arrived, deduplicated. The paths are the copies under the private native directory
 * (assets.ts#instructionAssetTargetPath), so the file the engine reads is one this Pack wrote and can vouch
 * for -- never a path that only exists on the gateway host.
 */
export function buildNativeConfigPayload(
  model: ResolvedModel,
  instructionAbsolutePaths: readonly string[],
  headerEnvironmentPrefix: string,
  nativePermissions: OpenCodeNativePermissions = "engine-default",
  permissionPolicy: PermissionPolicy = ALLOW_ALL,
  shell: string | undefined = undefined,
): NativeConfigPayload {
  if (model.endpoint === undefined || model.endpoint.length === 0) {
    throw new PnpError("ENGINE_MODEL_ENDPOINT_MISSING", "The resolved model has no endpoint; OpenCode requires provider.options.baseURL.", 502);
  }
  const npm = resolveProviderPackage(model.protocol);
  const headerMapping = mapHeadersToEnv(model.headers, headerEnvironmentPrefix);
  const providerId = model.selection.providerID;
  const modelId = model.selection.modelID;
  const options: Json = {
    baseURL: model.endpoint,
    apiKey: environmentToken(headerMapping.apiKeyEnvName),
    ...(Object.keys(headerMapping.configTokens).length > 0 ? { headers: { ...headerMapping.configTokens } } : {}),
  };
  const permission = buildNativePermissionConfig(permissionPolicy, nativePermissions);
  // path.resolve normalizes and guarantees an absolute entry: a relative path in `instructions` would be
  // resolved against the config file's directory by OpenCode, which is not where the asset was copied.
  const instructions = [...new Set(instructionAbsolutePaths.map((entry) => path.resolve(entry)))];
  const json: Json = {
    "$schema": "https://opencode.ai/config.json",
    model: `${providerId}/${modelId}`,
    share: "disabled",
    provider: {
      [providerId]: {
        npm,
        name: `PNP ${providerId}`,
        options,
        models: { [modelId]: { name: modelId } },
      },
    },
    ...(permission === undefined ? {} : { permission }),
    tools: { [QUESTION_TOOL]: false },
    ...(shell === undefined ? {} : { shell }),
    ...(instructions.length > 0 ? { instructions } : {}),
  };
  return { json, secretEnv: headerMapping.secretEnv };
}

export interface WrittenNativeConfig {
  /** Redirect variables plus OPENCODE_CONFIG (names primaryConfigPath) and OPENCODE_CONFIG_DIR. */
  redirectEnv: Readonly<Record<string, string>>;
  secretEnv: Readonly<Record<string, string>>;
  /** The file OPENCODE_CONFIG points at. */
  primaryConfigPath: string;
  /** The directory OPENCODE_CONFIG_DIR points at. */
  configDirectory: string;
  /** Every path the config was written to: primaryConfigPath first, then the fallback mirrors. */
  configPaths: readonly string[];
}
/**
 * Ensures every redirected directory exists, writes the private config to the deterministic OPENCODE_CONFIG
 * path, and mirrors identical content into the fallback config homes.
 *
 * `shell` defaults to the real probe (resolveNativeShell), which reads the host platform and PATH; pass an
 * explicit value -- including `undefined` via an injected probe result -- to keep a test off the real host.
 */
export async function writeNativeConfig(
  nativeDataDirectory: string,
  engineConfig: OpenCodeEngineConfig,
  model: ResolvedModel,
  instructionAbsolutePaths: readonly string[],
  permissionPolicy: PermissionPolicy = ALLOW_ALL,
  shell: string | undefined = resolveNativeShell(),
): Promise<WrittenNativeConfig> {
  const plan = buildRedirectPlan(nativeDataDirectory, engineConfig);
  const payload = buildNativeConfigPayload(
    model,
    instructionAbsolutePaths,
    engineConfig.headerEnvironmentPrefix,
    engineConfig.nativePermissions,
    permissionPolicy,
    shell,
  );
  for (const directory of Object.values(plan.env)) await mkdir(directory, { recursive: true });
  await mkdir(plan.configDirectory, { recursive: true });
  const serialized = `${JSON.stringify(payload.json, null, 2)}\n`;
  await mkdir(path.dirname(plan.configFile), { recursive: true });
  await writeFile(plan.configFile, serialized, "utf8");
  const configPaths: string[] = [plan.configFile];
  for (const root of plan.configRoots) {
    const directory = path.join(root, OPENCODE_ROOT_SEGMENT);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, NATIVE_CONFIG_FILENAME);
    await writeFile(file, serialized, "utf8");
    configPaths.push(file);
  }
  return {
    redirectEnv: {
      ...plan.env,
      [OPENCODE_CONFIG_ENVIRONMENT_VARIABLE]: plan.configFile,
      [OPENCODE_CONFIG_DIRECTORY_ENVIRONMENT_VARIABLE]: plan.configDirectory,
    },
    secretEnv: payload.secretEnv,
    primaryConfigPath: plan.configFile,
    configDirectory: plan.configDirectory,
    configPaths,
  };
}
