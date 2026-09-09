import { LocalProcessHost } from "./process-host.ts";
import type { HostedProcess, LaunchSpec } from "../contracts/host.ts";
import type { ResourceScope } from "../contracts/index.ts";
import { PnpError } from "../core/errors.ts";
export class WindowsJobHost extends LocalProcessHost {
  constructor(dataDirectory = "data") { super(dataDirectory); }
  override async start(spec: LaunchSpec, signal: AbortSignal, resources: ResourceScope): Promise<HostedProcess> {
    if (process.platform !== "win32") throw new PnpError("PLATFORM_UNSUPPORTED", "Windows Job Object host requires Windows.", 503);
    return super.start(spec, signal, resources);
  }
}
