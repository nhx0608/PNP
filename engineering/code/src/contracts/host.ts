import type { Json, ResourceScope, StopEvidence } from "./index.ts";
export interface LaunchSpec {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  /** The gateway Session identifier. A native or engine-scoped identifier here breaks ownership recovery. */
  sessionId: string;
  /** Non-empty. An empty token makes the ownership record unverifiable on the next start. */
  ownerToken: string;
}
export interface HostedProcess {
  readonly hostId: string;
  readonly generation: number;
  write(frame: string): Promise<void>;
  onFrame(listener: (frame: string) => void): () => void;
  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): () => void;
  terminate(): Promise<StopEvidence>;
}
export interface ProcessHost {
  /** signal cancels acquisition only. After start resolves, run cancellation uses the channel protocol and ResourceScope. */
  start(spec: LaunchSpec, signal: AbortSignal, resources: ResourceScope): Promise<HostedProcess>;
  reconcile(previous: Json): Promise<StopEvidence>;
}
