import type { HostedProcess } from "../../../../src/contracts/host.ts";
import type { StopEvidence } from "../../../../src/contracts/index.ts";
import { PnpError } from "../../../../src/core/errors.ts";

/**
 * In-memory stand-in for a `HostedProcess`, used by the driver-level tests in this directory to
 * control frame timing/ordering precisely (no real OS process, no real `pi` binary). The
 * subprocess-backed integration test lives in `engine-contract.test.ts` and uses the real
 * `LocalProcessHost` with `fixtures/fake-pi-cli.mjs` instead.
 */
export interface FakeHostedProcess extends HostedProcess {
  readonly writes: string[];
  push(line: string): void;
  exit(code: number | null, signal: string | null): void;
  terminateCalls: number;
}
export function createFakeHostedProcess(): FakeHostedProcess {
  const frameListeners = new Set<(frame: string) => void>();
  const exitListeners = new Set<(exit: { code: number | null; signal: string | null }) => void>();
  let exited: { code: number | null; signal: string | null } | undefined;
  const fake: FakeHostedProcess = {
    hostId: "fake-host", generation: 1,
    writes: [],
    terminateCalls: 0,
    async write(frame: string): Promise<void> {
      if (exited !== undefined) throw new PnpError("HOST_EXITED", "Process is unavailable.", 502);
      fake.writes.push(frame);
    },
    onFrame(listener) { frameListeners.add(listener); return () => frameListeners.delete(listener); },
    onExit(listener) { exitListeners.add(listener); if (exited !== undefined) listener(exited); return () => exitListeners.delete(listener); },
    async terminate(): Promise<StopEvidence> {
      fake.terminateCalls += 1;
      if (exited === undefined) fake.exit(0, null);
      return { quiescent: true, method: "process-tree" };
    },
    push(line: string): void { for (const listener of [...frameListeners]) listener(line); },
    exit(code: number | null, signal: string | null): void {
      if (exited !== undefined) return;
      exited = { code, signal };
      for (const listener of [...exitListeners]) listener(exited);
    },
  };
  return fake;
}
