import { fileURLToPath } from "node:url";
import { engineContract } from "../../kit/engine-contract.ts";
import { PiPack } from "../../../src/engines/pi/pack.ts";
import { MockIntegration } from "../../../src/integration/mock/provider.ts";

/**
 * Runs the public `EnginePack` contract (`tests/kit/engine-contract.ts`) against the *real*
 * `LocalProcessHost` (on win32 this drives the actual PowerShell Job Object helper) spawning
 * `fixtures/fake-pi-cli.mjs` as the "pi" process. This proves the RPC driver's framing,
 * correlation, and settle logic work over a genuine OS process/pipe on the target platform.
 *
 * It is deliberately NOT a claim of real-`pi`-binary or real-model verification: the fixture
 * only speaks the documented wire shape, not the actual `earendil-works/pi` implementation.
 * `docs/engines/pi.md` records that distinction; do not cite this test as Windows/real-engine
 * acceptance evidence on its own.
 */
process.env.PNP_PI_ENTRY = fileURLToPath(new URL("./fixtures/fake-pi-cli.mjs", import.meta.url));
process.env.PNP_PI_NODE = process.execPath;
delete process.env.PNP_PI_EXECUTABLE;
process.env.PNP_PI_EXTRA_ARGS = JSON.stringify([]);

engineContract("pi (fake-pi-cli.mjs fixture over the real LocalProcessHost, not the real pi binary)", async () => ({
  pack: new PiPack(),
  integration: new MockIntegration(),
  request: { parts: [{ type: "text", text: "hello from the pi engine-contract fixture test" }], model: { providerID: "test", modelID: "test" } },
}));
