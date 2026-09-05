import type { EnginePack, EngineOpenInput, EngineSessionChannel } from "../../contracts/index.ts";
import { CONTRACT_VERSION } from "../../contracts/index.ts";
import { PnpError } from "../../core/errors.ts";
/** Implementation boundary assigned in docs/team/work-packages.md. */
export class OpenCodePack implements EnginePack {
  readonly descriptor: EnginePack["descriptor"] = {
    id: "opencode", channelId: "acp", transport: "acp",
    contractVersion: CONTRACT_VERSION, developmentOnly: false, implementationProvided: false,
  };
  async open(_input: EngineOpenInput): Promise<EngineSessionChannel> {
    throw new PnpError("ENGINE_UNAVAILABLE", "opencode/acp implementation is required.", 503);
  }
}
