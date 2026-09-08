import type { EngineOpenInput, EnginePack, EngineSessionChannel, PermissionPolicy } from "../../contracts/index.ts";
import { CONTRACT_VERSION } from "../../contracts/index.ts";
import { openAcpChannel } from "../../drivers/acp/channel.ts";
import type { AcpEngineDefinition, AcpLaunchRequest } from "../../drivers/acp/channel.ts";
import { instructionAssetTargetPath, projectOpenCodeAssets } from "./assets.ts";
import { loadOpenCodeEngineConfig } from "./config.ts";
import type { OpenCodeEngineConfig } from "./config.ts";
import { resolveOpenCodeExecutable } from "./executable.ts";
import {
  OPENCODE_CONFIG_DIRECTORY_ENVIRONMENT_VARIABLE, OPENCODE_CONFIG_ENVIRONMENT_VARIABLE, writeNativeConfig,
} from "./native-config.ts";

const CLIENT_INFO = { name: "pnp-gateway-opencode", version: "0.1.0" };
/**
 * The proxy variables an engine process needs to reach an internal model endpoint, or anything else, through
 * the deployment's proxy. The shared ProcessHost's baseEnvironment() allow-list (src/runtime/process-host.ts)
 * deliberately carries only OS-level keys and does not include these, so the child would otherwise start with
 * no proxy configuration at all while the gateway itself has one. Both cases are listed because the
 * conventional variables are case-sensitive on POSIX and tools disagree about which case they read.
 */
export const PROXY_ENVIRONMENT_VARIABLES: readonly string[] = [
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
];
/**
 * Copies the gateway process's proxy configuration for the child. Values are host configuration, not
 * credentials, and are passed through verbatim; an unset or empty variable is left out rather than exported as
 * an empty string, which some clients read as "proxy configured, to nowhere".
 */
export function proxyEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of PROXY_ENVIRONMENT_VARIABLES) {
    const value = source[name];
    if (value !== undefined && value.length > 0) environment[name] = value;
  }
  return environment;
}

/**
 * OpenCode Engine Pack. Fills the ACP v1 Driver's `AcpEngineDefinition` seam (src/drivers/acp/channel.ts):
 * resolves OpenCode's native launch target, writes a session-private OpenCode config, and projects skill /
 * instruction assets into that private directory. See docs/engines/opencode.md for install shape, ACP subcommand
 * evidence and the capability evidence table; see AGENTS.md in this directory for the ownership boundary.
 */
export class OpenCodePack implements EnginePack {
  readonly descriptor: EnginePack["descriptor"] = {
    id: "opencode", channelId: "acp", transport: "acp",
    contractVersion: CONTRACT_VERSION, developmentOnly: false, implementationProvided: true,
  };

  async open(input: EngineOpenInput): Promise<EngineSessionChannel> {
    const config = await loadOpenCodeEngineConfig();
    // The effective policy arrives on the IntegrationContext, overrides already applied. The Pack reads no
    // settings file and no process environment for it: one structure decides and is projected (AGENTS.md
    // "Adapter 只能通过公共契约"; docs/engineering-review-3.md section 12, A). A provider that publishes none
    // has no static policy to project, and OpenCode keeps its own default.
    const permissions: PermissionPolicy = input.integration.permissions ?? { default: "allow", operations: {} };
    const selection = input.integration.model.selection;
    const modelID = `${selection.providerID}/${selection.modelID}`;
    const definition: AcpEngineDefinition = {
      engineId: "opencode",
      channelId: "acp",
      engineVersion: config.engineVersion,
      client: CLIENT_INFO,
      // See config/engines/opencode.json#model.policy and docs/engines/opencode.md section 5. Both routes are
      // real: a live opencode acp session does advertise a model-category session config option whose
      // currentValue is the model pinned by the private config. "launch" ships as the default because it fails
      // closed -- a request for any other model is rejected before a prompt is sent, rather than being answered
      // by whatever model the engine happened to keep. Flip the config field to switch; no code change needed.
      model: config.model.policy === "session-config" ? { kind: "session-config" } : { kind: "launch", modelID },
      timeouts: config.timeouts,
      launch: (openInput) => buildLaunchRequest(config, permissions, openInput),
      projectAssets: (args) => projectOpenCodeAssets(config, args),
    };
    return openAcpChannel(definition, input);
  }
}

/**
 * Builds the process the shared ProcessHost will spawn. Never spawns itself: only returns the executable, args,
 * cwd and env for `EngineOpenInput.host.start()` to launch (docs/spec/contracts.md "Host 注入与所有权").
 */
async function buildLaunchRequest(
  config: OpenCodeEngineConfig,
  permissions: PermissionPolicy,
  input: EngineOpenInput,
): Promise<AcpLaunchRequest> {
  const resolved = await resolveOpenCodeExecutable(config);
  const instructionAbsolutePaths = input.integration.assets
    .filter((asset) => asset.kind === "instruction")
    .map((asset) => instructionAssetTargetPath(input.nativeDataDirectory, asset));
  const written = await writeNativeConfig(
    input.nativeDataDirectory,
    config,
    input.integration.model,
    instructionAbsolutePaths,
    permissions,
  );
  // Proxy first, then redirection, then secrets: a name collision must let the header env var win, never a
  // redirect key, and never a proxy variable.
  const env: Record<string, string> = {
    ...proxyEnvironment(),
    ...written.redirectEnv,
    ...written.secretEnv,
  };
  // The one exception is the pointer to the private config. A header mapped onto that name would send OpenCode
  // back to the operator's real global config, so these two assignments are last and unconditional.
  env[OPENCODE_CONFIG_ENVIRONMENT_VARIABLE] = written.primaryConfigPath;
  env[OPENCODE_CONFIG_DIRECTORY_ENVIRONMENT_VARIABLE] = written.configDirectory;
  if (input.integration.model.caFile !== undefined) {
    // Standard Node.js trust-store extension (docs.node/api/cli#node_extra_ca_certsfile). The shipped exe is a
    // Bun-compiled binary and Bun documents the same variable for its own TLS stack; node-script mode runs
    // under node.exe, where it is native.
    env["NODE_EXTRA_CA_CERTS"] = input.integration.model.caFile;
  }
  if (input.integration.model.tlsInsecure === true) {
    // Last resort for an internal endpoint whose certificate cannot be verified even with a supplied CA file.
    // Only ever set from the resolved model -- an explicit deployment decision that reached this Pack through
    // the IntegrationContext -- never inherited from the gateway's own environment, and never a default.
    env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
  }
  return {
    executable: resolved.executable,
    args: [...resolved.prefixArgs, ...config.acp.subcommandArgs],
    cwd: input.session.directory,
    env,
  };
}
