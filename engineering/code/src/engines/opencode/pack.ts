import type { EngineOpenInput, EnginePack, EngineSessionChannel } from "../../contracts/index.ts";
import { CONTRACT_VERSION } from "../../contracts/index.ts";
import { openAcpChannel } from "../../drivers/acp/channel.ts";
import type { AcpEngineDefinition, AcpLaunchRequest } from "../../drivers/acp/channel.ts";
import { instructionAssetTargetPath, projectOpenCodeAssets } from "./assets.ts";
import { loadOpenCodeEngineConfig } from "./config.ts";
import type { OpenCodeEngineConfig } from "./config.ts";
import { resolveOpenCodeExecutable } from "./executable.ts";
import { writeNativeConfig } from "./native-config.ts";

const CLIENT_INFO = { name: "pnp-gateway-opencode", version: "0.1.0" };

/**
 * OpenCode Engine Pack. Fills the ACP v1 Driver's `AcpEngineDefinition` seam (src/drivers/acp/channel.ts):
 * resolves OpenCode's Windows launch target, writes a session-private OpenCode config, and projects skill /
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
    const selection = input.integration.model.selection;
    const modelID = `${selection.providerID}/${selection.modelID}`;
    const definition: AcpEngineDefinition = {
      engineId: "opencode",
      channelId: "acp",
      engineVersion: config.engineVersion,
      client: CLIENT_INFO,
      // See config/engines/opencode.json#model.policy and docs/engines/opencode.md for why "launch" is the
      // shipped default: opencode acp exposing a model-category session config option is unverified, so pinning
      // fails closed (rejects an unsupported model up front) instead of assuming a runtime surface that may not
      // exist. Flip config/engines/opencode.json#model.policy to "session-config" only after that is confirmed
      // against a real opencode acp session's NewSessionResponse.configOptions.
      model: config.model.policy === "session-config" ? { kind: "session-config" } : { kind: "launch", modelID },
      timeouts: config.timeouts,
      launch: (openInput) => buildLaunchRequest(config, openInput),
      projectAssets: (args) => projectOpenCodeAssets(config, args),
    };
    return openAcpChannel(definition, input);
  }
}

/**
 * Builds the process the shared ProcessHost will spawn. Never spawns itself: only returns the executable, args,
 * cwd and env for `EngineOpenInput.host.start()` to launch (docs/spec/contracts.md "Host 注入与所有权").
 */
async function buildLaunchRequest(config: OpenCodeEngineConfig, input: EngineOpenInput): Promise<AcpLaunchRequest> {
  const resolved = await resolveOpenCodeExecutable(config);
  const instructionAbsolutePaths = input.integration.assets
    .filter((asset) => asset.kind === "instruction")
    .map((asset) => instructionAssetTargetPath(input.nativeDataDirectory, asset));
  const written = await writeNativeConfig(input.nativeDataDirectory, config, input.integration.model, instructionAbsolutePaths);
  // Redirection first, then secrets: a name collision must let the header env var win, never a redirect key.
  const env: Record<string, string> = { ...written.redirectEnv, ...written.secretEnv };
  if (input.integration.model.caFile !== undefined) {
    // Standard Node.js trust-store extension (docs.node/api/cli#node_extra_ca_certsfile); node-script mode always
    // runs under node.exe, and Bun documents the same variable for its own TLS stack in exe mode.
    env["NODE_EXTRA_CA_CERTS"] = input.integration.model.caFile;
  }
  return {
    executable: resolved.executable,
    args: [...resolved.prefixArgs, ...config.acp.subcommandArgs],
    cwd: input.session.directory,
    env,
  };
}
