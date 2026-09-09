import type { EnginePack, EngineOpenInput, EngineSessionChannel } from "../../contracts/index.ts";
import { CONTRACT_VERSION } from "../../contracts/index.ts";
import { PnpError } from "../../core/errors.ts";
/** Implementation boundary assigned in docs/team/work-packages.md. */
export class HermesPack implements EnginePack {
  readonly descriptor: EnginePack["descriptor"] = {
    id: "hermes", channelId: "acp", transport: "acp",
    contractVersion: CONTRACT_VERSION, developmentOnly: false, implementationProvided: false,
  };
  async open(_input: EngineOpenInput): Promise<EngineSessionChannel> {
    throw new PnpError("ENGINE_UNAVAILABLE", "hermes/acp implementation is required.", 503);
  }
}
