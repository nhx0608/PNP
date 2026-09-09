import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LaunchSpec } from "../../contracts/host.ts";
import type { AssetBinding, Json, ModelSelection, ResolvedModel } from "../../contracts/index.ts";
import { PnpError } from "../../core/errors.ts";
import { baseEnvironment } from "../../runtime/process-host.ts";

/**
 * Locates the `pi` CLI. There is no portable global-install path across npm/pnpm/Windows shims
 * (a `.cmd`/`.ps1` shim is not a directly launchable executable on this platform; see
 * `LocalProcessHost.start`'s "resolve npm shims" check), so the operator must point at a real
 * executable explicitly instead of us guessing an install layout that may be wrong.
 */
export interface PiLaunchConfig {
  /** Absolute path to a Node executable, or to a self-contained `pi` executable when `entry` is unset. */
  readonly node: string;
  /** Absolute path to the pi-coding-agent CLI entry script; omitted when `node` is itself the pi executable. */
  readonly entry?: string;
  readonly extraArgs: readonly string[];
  readonly approve: "always" | "never";
}
/**
 * A misconfigured deployment is not something the HTTP caller can fix by changing its request, so
 * every configuration failure here is 503 (the same status `MODEL_ENVIRONMENT_MISSING` uses), not
 * 400 (docs/engineering-review-3.md section 16 E2).
 */
export function resolvePiLaunchConfig(env: NodeJS.ProcessEnv = process.env): PiLaunchConfig {
  const executable = env.PNP_PI_EXECUTABLE;
  const entry = env.PNP_PI_ENTRY;
  const node = env.PNP_PI_NODE ?? process.execPath;
  const approve: "always" | "never" = env.PNP_PI_APPROVE === "always" ? "always" : "never";
  let extraArgs: readonly string[] = [];
  if (env.PNP_PI_EXTRA_ARGS !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(env.PNP_PI_EXTRA_ARGS); }
    catch { throw new PnpError("ENGINE_CONFIGURATION_ERROR", "PNP_PI_EXTRA_ARGS must be a JSON array of strings.", 503); }
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
      throw new PnpError("ENGINE_CONFIGURATION_ERROR", "PNP_PI_EXTRA_ARGS must be a JSON array of strings.", 503);
    }
    extraArgs = parsed;
  }
  if (executable !== undefined) {
    if (!path.isAbsolute(executable)) throw new PnpError("ENGINE_CONFIGURATION_ERROR", "PNP_PI_EXECUTABLE must be an absolute path.", 503);
    return { node: executable, extraArgs, approve };
  }
  if (entry !== undefined) {
    if (!path.isAbsolute(entry) || !path.isAbsolute(node)) {
      throw new PnpError("ENGINE_CONFIGURATION_ERROR", "PNP_PI_ENTRY and PNP_PI_NODE must be absolute paths.", 503);
    }
    return { node, entry, extraArgs, approve };
  }
  throw new PnpError("ENGINE_UNAVAILABLE", "Pi CLI location is not configured; set PNP_PI_EXECUTABLE or PNP_PI_ENTRY.", 503);
}

export interface PiSessionPaths {
  readonly sessionDir: string;
  readonly sessionFile: string;
  /** Session sidecar listing this session's MCP servers by environment-variable NAME only. */
  readonly toolsFile: string;
  /** Session-private `PI_CODING_AGENT_DIR` target (verified: real pi 0.85.1 uses this env var
   * verbatim as its whole config root — default `~/.pi/agent` — instead of an additive layer,
   * so pointing it here keeps this session's credentials off the operator's real pi config and
   * off every other concurrent session on the same host). */
  readonly agentConfigDir: string;
  readonly modelsConfigFile: string;
  /** pi's own `settings.json` inside the private config root (upstream `docs/windows.md`). */
  readonly settingsFile: string;
}
export function resolveSessionPaths(nativeDataDirectory: string): PiSessionPaths {
  const agentConfigDir = path.join(nativeDataDirectory, "pi-agent");
  return {
    sessionDir: nativeDataDirectory,
    sessionFile: path.join(nativeDataDirectory, "session.jsonl"),
    toolsFile: path.join(nativeDataDirectory, "pnp-tools.json"),
    agentConfigDir,
    modelsConfigFile: path.join(agentConfigDir, "models.json"),
    settingsFile: path.join(agentConfigDir, "settings.json"),
  };
}

/**
 * Absolute path of the MCP bridge extension pi is asked to load with `-e`.
 *
 * The driver runs both from `src/` (Node's strip-only loader, tests and `npm start` under
 * `--experimental-strip-types`) and from `dist/` (`tsc` output), and pi's jiti loader accepts
 * either `.ts` or `.js`. Deriving the extension path from this module's own URL — same directory
 * layout in both trees, extension suffix taken from whichever suffix this module itself was
 * loaded with — keeps a single source of truth instead of a build-time path constant that is
 * wrong in one of the two trees. The extension must also stay inside the gateway's own package
 * tree: pi loads it in *its* process, and its `@modelcontextprotocol/sdk` import is resolved by
 * walking up from the extension file to `code/node_modules`.
 */
export function resolveBridgeExtensionPath(moduleUrl: string = import.meta.url): string {
  const suffix = moduleUrl.endsWith(".ts") ? ".ts" : ".js";
  return fileURLToPath(new URL(`./extension/pnp-bridge${suffix}`, moduleUrl));
}

/** Generated environment-variable names. Only NAMES are ever written to a file; the resolved
 * values travel exclusively in `LaunchSpec.env` (docs/spec/contracts.md: resolved model and tool
 * configuration is never persisted, logged, or put into an error message). */
export const MODEL_API_KEY_ENVIRONMENT = "PNP_PI_MODEL_API_KEY";
export const MODEL_HEADER_ENVIRONMENT_PREFIX = "PNP_PI_MODEL_HEADER_";
/** Where the bridge extension reads this session's MCP server list from. */
export const BRIDGE_FILE_ENVIRONMENT = "PNP_PI_BRIDGE_FILE";
/** A non-secret stand-in so `models.json` still loads for a keyless endpoint; pi treats models as
 * unavailable in `/model` when a provider has no auth at all (upstream `docs/models.md`). */
const UNUSED_API_KEY = "pnp-unused";
const BEARER_SCHEME = /^bearer\s+/i;

/** Maps a `ResolvedModel.protocol` to pi's `models.json` "api" enum (upstream `docs/models.md`
 * "Supported APIs"; verified against real pi 0.85.1 — see `docs/engines/pi.md`).
 * "custom"/"test" have no pi-compatible wire format, so `writePiModelsConfig` writes no provider
 * entry for them instead of guessing; a real pi process then only has its own built-ins to work
 * with, and a genuinely misconfigured run fails loudly at pi startup rather than silently. */
function piApiFor(protocol: ResolvedModel["protocol"]): "openai-completions" | "anthropic-messages" | undefined {
  if (protocol === "openai-chat") return "openai-completions";
  if (protocol === "anthropic-messages") return "anthropic-messages";
  return undefined;
}
interface PiProviderConfig {
  readonly api: "openai-completions" | "anthropic-messages";
  /** Always a `$NAME` reference, never a credential. */
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Original header name -> `$NAME` reference. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly models: readonly { readonly id: string }[];
}
interface PiModelsConfigFile { readonly providers: Readonly<Record<string, PiProviderConfig>> }

export interface PiModelBinding {
  /** `models.json` content, or undefined when pi has no wire format for this protocol. */
  readonly config: PiModelsConfigFile | undefined;
  /** Generated variable name -> resolved value. Only ever placed in `LaunchSpec.env`. */
  readonly env: Readonly<Record<string, string>>;
  /** Original header name -> generated variable name. Names are not secret; values are absent. */
  readonly headerEnvironmentNames: Readonly<Record<string, string>>;
}

/**
 * Projects a `ResolvedModel` onto pi's custom-provider shape without putting a single resolved
 * value in the file.
 *
 * Header lookup is case-insensitive: the shipped `config/settings.json` emits `Authorization`
 * while this driver used to read `model.headers.authorization`, so the delivered configuration
 * silently dropped the model credential and pi called the endpoint unauthenticated (regression
 * covered in `tests/adapters/pi/launch.test.ts`).
 *
 * `$NAME` is pi's documented environment interpolation for `apiKey`/`headers` (upstream
 * `docs/models.md` "Value Resolution" and "Custom Headers"). The same section is why a literal
 * credential must not be written here even ignoring the on-disk rule: a value starting with `!`
 * is executed as a shell command and `$` sequences are interpolated, so a literal secret can be
 * rewritten or, in the worst case, executed. Nothing is escaped here because nothing but the
 * generated variable names is ever written.
 */
export function buildPiModelBinding(model: ResolvedModel): PiModelBinding {
  const env: Record<string, string> = {};
  const headerEnvironmentNames: Record<string, string> = {};
  const headerTokens: Record<string, string> = {};
  let bearer: string | undefined;
  let index = 0;
  for (const [name, value] of Object.entries(model.headers)) {
    if (bearer === undefined && name.toLowerCase() === "authorization") {
      const scheme = BEARER_SCHEME.exec(value);
      if (scheme !== null) { bearer = value.slice(scheme[0].length); continue; }
    }
    index += 1;
    const variable = `${MODEL_HEADER_ENVIRONMENT_PREFIX}${String(index)}`;
    headerEnvironmentNames[name] = variable;
    headerTokens[name] = `$${variable}`;
    env[variable] = value;
  }
  env[MODEL_API_KEY_ENVIRONMENT] = bearer ?? UNUSED_API_KEY;
  const api = piApiFor(model.protocol);
  if (api === undefined) return { config: undefined, env, headerEnvironmentNames };
  const provider: PiProviderConfig = {
    api,
    apiKey: `$${MODEL_API_KEY_ENVIRONMENT}`,
    ...(model.endpoint === undefined ? {} : { baseUrl: model.endpoint }),
    ...(Object.keys(headerTokens).length === 0 ? {} : { headers: headerTokens }),
    models: [{ id: model.selection.modelID }],
  };
  return { config: { providers: { [model.selection.providerID]: provider } }, env, headerEnvironmentNames };
}

/**
 * Identity of the model binding this session's process environment was built for.
 *
 * `LaunchSpec.env` is fixed when the process starts, so a later run that resolves a different
 * endpoint, header set, or credential cannot be served by `set_model`: the variables its
 * `models.json` references would not exist in the running pi process. The digest is what makes
 * that detectable without keeping the material around — it is safe to retain, the canonical
 * string it is computed from (which contains the resolved values) is never stored or logged.
 */
export function fingerprintPiModel(model: ResolvedModel): string {
  const canonical: Json = {
    providerID: model.selection.providerID,
    modelID: model.selection.modelID,
    protocol: model.protocol,
    endpoint: model.endpoint ?? null,
    caFile: model.caFile ?? null,
    tlsInsecure: model.tlsInsecure === true,
    headers: Object.entries(model.headers)
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
      .map(([name, value]) => [name, value]),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Declares `model` as a pi custom provider in this session's private `models.json` (read by pi
 * via `PI_CODING_AGENT_DIR`, see `buildLaunchSpec`). This is pi's only documented mechanism for
 * pointing a provider at an arbitrary internal `baseUrl` plus credential headers — there is no
 * generic `*_BASE_URL` environment override outside the Azure OpenAI provider (verified: a real
 * pi 0.85.1 process launched with `OPENAI_BASE_URL` pointed at a local mock server ignored it
 * and called the real upstream host instead; only `models.json` actually redirected traffic).
 *
 * Returns the environment the process must carry for the file to resolve. The file itself holds
 * variable names only, so it stays readable without exposing anything.
 */
export async function writePiModelsConfig(paths: PiSessionPaths, model: ResolvedModel): Promise<Readonly<Record<string, string>>> {
  // Always ensured, even for a protocol with no pi mapping below: `PI_CODING_AGENT_DIR` (set to
  // this same directory in `buildLaunchSpec`) should point at a real directory before pi starts,
  // rather than relying on pi to create a missing config root itself.
  await mkdir(paths.agentConfigDir, { recursive: true });
  const binding = buildPiModelBinding(model);
  if (binding.config !== undefined) {
    await writeFile(paths.modelsConfigFile, JSON.stringify(binding.config, null, 2), { mode: 0o600 });
  }
  return binding.env;
}

/** The two documented Git for Windows locations plus a PATH lookup, in pi's own order
 * (upstream `docs/windows.md` "Windows Setup"). */
export const WINDOWS_BASH_CANDIDATES: readonly string[] = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
];
/** win32 `defaultTools` minus `bash`; `powershell` replaces it (upstream `docs/windows.md`). */
export const WINDOWS_DEFAULT_TOOLS: readonly string[] = ["read", "powershell", "edit", "write", "grep", "find", "ls"];

function fileExists(candidate: string): boolean {
  try { return statSync(candidate).isFile(); } catch { return false; }
}
/** Default probe: the two Git for Windows paths, then `bash.exe` on PATH. No process is started —
 * an adapter must not spawn anything outside `ProcessHost` — so this is a filesystem test only. */
export function defaultWindowsBashProbe(env: NodeJS.ProcessEnv = process.env): boolean {
  if (WINDOWS_BASH_CANDIDATES.some(fileExists)) return true;
  const search = env.PATH ?? env.Path ?? "";
  return search.split(path.delimiter).filter((entry) => entry.length > 0)
    .some((entry) => fileExists(path.join(entry, "bash.exe")));
}

export interface PiSettingsOptions {
  readonly platform?: NodeJS.Platform;
  /** Injectable so both outcomes are testable without a Git for Windows install. */
  readonly bashAvailable?: () => boolean;
}
/**
 * pi defaults to Git Bash for its `bash` tool on Windows and falls back to `bash.exe` on PATH
 * (upstream `docs/windows.md`); on a sandbox with neither, every `bash` call fails and the model
 * has no shell at all. The same document's remedy is `defaultTools` with the optional
 * `powershell` tool, which runs through `pwsh.exe` when available and Windows PowerShell
 * otherwise. `bash` is added back only when a launchable `bash.exe` was actually found, so a
 * machine that has Git Bash keeps both. Off win32 nothing is pinned: pi's own defaults apply.
 */
export function buildPiSettings(options: PiSettingsOptions = {}): Readonly<Record<string, Json>> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return {};
  const probe = options.bashAvailable ?? (() => defaultWindowsBashProbe());
  const tools = probe() ? [...WINDOWS_DEFAULT_TOOLS, "bash"] : [...WINDOWS_DEFAULT_TOOLS];
  return { defaultTools: tools };
}
export async function writePiSettings(paths: PiSessionPaths, options: PiSettingsOptions = {}): Promise<void> {
  await mkdir(paths.agentConfigDir, { recursive: true });
  await writeFile(paths.settingsFile, `${JSON.stringify(buildPiSettings(options), null, 2)}\n`, { mode: 0o600 });
}

/**
 * Reads this run's instruction assets so they can be appended to pi's system prompt.
 *
 * pi has no config field for extra instruction files; `--append-system-prompt <text>` is the
 * documented route and is repeatable (upstream README "Options"). One joined argv element is used
 * rather than one flag per file so the ordering is explicit and a file whose contents happen to
 * look like a path cannot be re-read by pi as a file argument. Files are separated by a blank
 * line. No instruction asset means no flag at all, never an empty one.
 */
export async function readInstructionText(assets: readonly AssetBinding[]): Promise<string | undefined> {
  const instructions = assets.filter((asset) => asset.kind === "instruction");
  if (instructions.length === 0) return undefined;
  const parts: string[] = [];
  for (const asset of instructions) {
    const text = (await readFile(asset.path, "utf8")).trim();
    if (text.length > 0) parts.push(text);
  }
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

/** Forwarded verbatim when the gateway itself has them: an internal deployment reaches its model
 * endpoint and its HTTP MCP servers through the same proxy the gateway was configured with, and
 * `baseEnvironment()`'s allow-list (which exists to keep credentials out of engine processes)
 * does not carry them. */
const PROXY_VARIABLES: readonly string[] = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
export function proxyEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(PROXY_VARIABLES.flatMap((key) => {
    const value = source[key];
    return value === undefined || value.length === 0 ? [] : [[key, value] as const];
  }));
}

export interface PiLaunchInput {
  readonly sessionId: string;
  readonly ownerToken: string;
  readonly cwd: string;
  readonly paths: PiSessionPaths;
  /** Always set in production: the bridge carries the `tool_call` policy hook even with no MCP servers. */
  readonly extensionPath?: string;
  /** Written when this session has at least one MCP server; absent otherwise. */
  readonly bridgeFile?: string;
  readonly model: ResolvedModel;
  /** Generated variable name -> resolved value, from `writePiModelsConfig`. */
  readonly modelEnv: Readonly<Record<string, string>>;
  /** Generated variable name -> resolved value, from the tool sidecar projection. */
  readonly toolEnv?: Readonly<Record<string, string>>;
  readonly appendSystemPrompt?: string;
  readonly gatewayEnv?: NodeJS.ProcessEnv;
}
export function buildLaunchSpec(config: PiLaunchConfig, input: PiLaunchInput): LaunchSpec {
  const model = input.model;
  const flags = [
    "--mode", "rpc",
    "--session", input.paths.sessionFile,
    "--session-dir", input.paths.sessionDir,
    config.approve === "always" ? "--approve" : "--no-approve",
    ...buildModelArgs(model.selection),
    ...(input.appendSystemPrompt === undefined ? [] : ["--append-system-prompt", input.appendSystemPrompt]),
    ...(input.extensionPath === undefined ? [] : ["-e", input.extensionPath]),
    ...config.extraArgs,
  ];
  const args = config.entry === undefined ? flags : [config.entry, ...flags];
  return {
    executable: config.node,
    args,
    cwd: input.cwd,
    env: {
      ...baseEnvironment(input.gatewayEnv),
      ...proxyEnvironment(input.gatewayEnv),
      PI_TELEMETRY: "0",
      PI_CODING_AGENT_DIR: input.paths.agentConfigDir,
      ...(input.bridgeFile === undefined ? {} : { [BRIDGE_FILE_ENVIRONMENT]: input.bridgeFile }),
      // Node reads both at startup; they are the only TLS knobs a pi process exposes to us.
      ...(model.caFile === undefined ? {} : { NODE_EXTRA_CA_CERTS: model.caFile }),
      ...(model.tlsInsecure === true ? { NODE_TLS_REJECT_UNAUTHORIZED: "0" } : {}),
      ...input.modelEnv,
      ...(input.toolEnv ?? {}),
    },
    sessionId: input.sessionId,
    ownerToken: input.ownerToken,
  };
}

/** `--provider`/`--model` are the documented pi CLI selectors (docs/research/T02-pi-harness.md
 * §"接入方式选择"), verified against real pi 0.85.1 together with `writePiModelsConfig` above. */
export function buildModelArgs(selection: ModelSelection): readonly string[] {
  return ["--provider", selection.providerID, "--model", selection.modelID];
}
