import type { EnginePack, EngineOpenInput, EngineSessionChannel } from "../../contracts/index.ts";
import { CONTRACT_VERSION } from "../../contracts/index.ts";
import { PnpError } from "../../core/errors.ts";
/** Implementation boundary assigned in docs/team/work-packages.md. */
export class PiPack implements EnginePack {
  readonly descriptor: EnginePack["descriptor"] = {
    id: "pi", channelId: "rpc", transport: "pi-rpc",
    contractVersion: CONTRACT_VERSION, developmentOnly: false, implementationProvided: false,
  };
  async open(_input: EngineOpenInput): Promise<EngineSessionChannel> {
    throw new PnpError("ENGINE_UNAVAILABLE", "pi/rpc implementation is required.", 503);
  }
}
