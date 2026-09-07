import type { EngineOpenInput, EnginePack, EngineSessionChannel } from "../../contracts/index.ts";
import { CONTRACT_VERSION } from "../../contracts/index.ts";
import { loadPnpSettings } from "../../config/settings.ts";
import type { PermissionPolicy } from "../../config/settings.ts";
import { openAcpChannel } from "../../drivers/acp/channel.ts";
import type { AcpEngineDefinition, AcpLaunchRequest } from "../../drivers/acp/channel.ts";
import { instructionAssetTargetPath, projectOpenCodeAssets } from "./assets.ts";
import { loadOpenCodeEngineConfig } from "./config.ts";
import type { OpenCodeEngineConfig } from "./config.ts";
import { resolveOpenCodeExecutable } from "./executable.ts";
import { OPENCODE_CONFIG_ENVIRONMENT_VARIABLE, writeNativeConfig } from "./native-config.ts";

const CLIENT_INFO = { name: "pnp-gateway-opencode", version: "0.1.0" };

export class OpenCodePack implements EnginePack {
  readonly descriptor: EnginePack["descriptor"] = {
    id: "opencode", channelId: "acp", transport: "acp",
    contractVersion: CONTRACT_VERSION, developmentOnly: false, implementationProvided: true,
  };

  async open(input: EngineOpenInput): Promise<EngineSessionChannel> {
    const [config, settings] = await Promise.all([
      loadOpenCodeEngineConfig(),
      loadPnpSettings({ engineId: "opencode", settingsPath: process.env.PNP_SETTINGS }),
    ]);
    const selection = input.integration.model.selection;
    const modelID = `${selection.providerID}/${selection.modelID}`;
    const definition: AcpEngineDefinition = {
      engineId: "opencode",
      channelId: "acp",
      engineVersion: config.engineVersion,
      client: CLIENT_INFO,
      model: config.model.policy === "session-config" ? { kind: "session-config" } : { kind: "launch", modelID },
      timeouts: config.timeouts,
      launch: (openInput) => buildLaunchRequest(config, settings.permissions, openInput),
      projectAssets: (args) => projectOpenCodeAssets(config, args),
    };
    return openAcpChannel(definition, input);
  }
}

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
  const env: Record<string, string> = { ...written.redirectEnv, ...written.secretEnv };
  env[OPENCODE_CONFIG_ENVIRONMENT_VARIABLE] = written.primaryConfigPath;
  if (input.integration.model.caFile !== undefined) env["NODE_EXTRA_CA_CERTS"] = input.integration.model.caFile;
  return {
    executable: resolved.executable,
    args: [...resolved.prefixArgs, ...config.acp.subcommandArgs],
    cwd: input.session.directory,
    env,
  };
}
