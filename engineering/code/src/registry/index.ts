import type { EnginePack } from "../contracts/index.ts";
import { PnpError } from "../core/errors.ts";
const factories: Record<string, () => Promise<EnginePack>> = {
  mock: async () => new (await import("../engines/mock/pack.ts")).MockPack(),
  opencode: async () => new (await import("../engines/opencode/pack.ts")).OpenCodePack(),
  hermes: async () => new (await import("../engines/hermes/pack.ts")).HermesPack(),
  pi: async () => new (await import("../engines/pi/pack.ts")).PiPack(),
};
export async function loadEngine(id: string, development: boolean): Promise<EnginePack> {
  const factory = factories[id];
  if (factory === undefined) throw new PnpError("ENGINE_NOT_FOUND", "Unknown engine identifier.", 400);
  const pack = await factory();
  if (pack.descriptor.developmentOnly && !development) throw new PnpError("MOCK_FORBIDDEN", "Test engine requires explicit development mode.", 400);
  if (!pack.descriptor.implementationProvided) throw new PnpError("ENGINE_UNAVAILABLE", "Selected Engine Pack has no implementation.", 503);
  return pack;
}
export function selectEngine(cli: string | undefined, environment: string | undefined): string {
  // An empty variable is how a shell says "unset"; treating it as a value would make --engine
  // unusable whenever a wrapper script exports AGENT_ENGINE without a value.
  const declared = environment === undefined || environment.trim() === "" ? undefined : environment;
  const requested = cli === undefined || cli.trim() === "" ? undefined : cli;
  if (requested !== undefined && declared !== undefined && requested !== declared) {
    throw new PnpError("ENGINE_CONFIGURATION_CONFLICT", "--engine and AGENT_ENGINE disagree.", 400);
  }
  const id = declared ?? requested;
  if (id === undefined) throw new PnpError("ENGINE_NOT_FOUND", "Set AGENT_ENGINE or --engine.", 400);
  return id;
}
