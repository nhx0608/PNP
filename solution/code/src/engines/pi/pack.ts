import { rm } from "node:fs/promises";
import type { EngineOpenInput, EnginePack, EngineSessionChannel } from "../../contracts/index.ts";
import { CONTRACT_VERSION } from "../../contracts/index.ts";
import { openPiSession } from "../../drivers/pi-rpc/channel.ts";
import { resolveSessionPaths } from "../../drivers/pi-rpc/launch.ts";

/** Implementation boundary assigned in docs/team/work-packages.md (owner B).
 * `implementationProvided: true` states that the RPC driver code exists; it is not a claim that
 * a real `pi` binary, Windows target, or internal model was exercised (verification.md /
 * `docs/engines/pi.md` record the declared vs. probed vs. verified evidence separately). */
export class PiPack implements EnginePack {
  readonly descriptor: EnginePack["descriptor"] = {
    id: "pi", channelId: "rpc", transport: "pi-rpc",
    contractVersion: CONTRACT_VERSION, developmentOnly: false, implementationProvided: true,
  };
  async open(input: EngineOpenInput): Promise<EngineSessionChannel> {
    return openPiSession(input);
  }
  /** The pi session file, the tool sidecar and this session's private pi config root all live
   * inside `nativeDataDirectory`, which `GatewayCore.deleteSession` already removes; nothing lives
   * outside it to purge. This hook only defends against a future layout change leaving an orphan.
   *
   * Neither file holds a resolved value any more -- both carry generated environment-variable
   * names -- but the private config root still records this session's endpoint and header names,
   * which should not outlive the session they were written for. The bridge extension itself is a
   * build artefact in the gateway's own tree and is never copied here, so there is nothing of it
   * to delete. */
  async purge(input: { nativeDataDirectory: string }): Promise<void> {
    const paths = resolveSessionPaths(input.nativeDataDirectory);
    await rm(paths.toolsFile, { force: true });
    await rm(paths.agentConfigDir, { force: true, recursive: true });
  }
}
