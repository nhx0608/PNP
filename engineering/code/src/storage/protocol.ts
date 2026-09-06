import type { Json, Message, NativeSessionRef, PublicEvent, Run, Session, TerminalState } from "../contracts/index.ts";

export interface InteractionRow {
  id: string;
  sessionId: string;
  runId: string;
  kind: "question" | "permission";
  payload: Json;
  operation: string;
  createdAt: string;
  state: "pending" | "resolved" | "expired";
  response?: Json;
}
export interface Operations {
  createSession: { input: Session; output: Session };
  getSession: { input: { id: string }; output: Session | null };
  listSessions: { input: null; output: Session[] };
  bindNative: { input: { id: string; native: NativeSessionRef }; output: null };
  findRunByKey: { input: { sessionId: string; key: string }; output: Run | null };
  startRun: { input: { run: Run; message: Message }; output: null };
  cancelling: { input: { runId: string }; output: null };
  appendMessage: { input: { sessionId: string; runId: string; message: Message }; output: null };
  messages: { input: { sessionId: string }; output: Message[] };
  appendEvent: { input: { type: string; properties: { [key: string]: Json } }; output: PublicEvent };
  /** Replays committed events for a reconnecting subscriber; it never mutates the journal. */
  eventsSince: { input: { afterSequence: number; limit?: number }; output: PublicEvent[] };
  finishRun: { input: { runId: string; state: TerminalState; message: Message; quiescent: boolean; errorCode?: string; nativeStopReason?: string; taskOutcome?: "unknown" | "succeeded" | "failed"; nativeResumeRequired?: boolean }; output: Run };
  beginDelete: { input: { sessionId: string }; output: null };
  confirmStopped: { input: { sessionId: string }; output: null };
  diagnostics: { input: null; output: { sessions: number; runs: number; interrupted: number; blocked: number } };
  deleteSession: { input: { sessionId: string }; output: null };
  getRun: { input: { runId: string }; output: Run | null };
  /** Frees the key of a provably terminal run so a retry is possible; it never replays the old run. */
  releaseIdempotencyKey: { input: { runId: string }; output: boolean };
  recover: { input: null; output: number };
  createInteraction: { input: InteractionRow; output: null };
  listInteractions: { input: { kind: "question" | "permission" }; output: InteractionRow[] };
  resolveInteraction: { input: { id: string; response: Json }; output: boolean };
  expireInteractions: { input: { runId: string }; output: null };
  close: { input: null; output: null };
}
export type Operation = keyof Operations;
export interface WorkerRequest { id: number; op: Operation; input: unknown }
export type WorkerReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; code: string; message: string; status: number; diagnostic?: StorageDiagnostic };
export interface StorageDiagnostic {
  category: "sqlite" | "worker" | "timeout";
  code?: string;
  /** Sanitized failure detail; it carries no credential because the worker never receives one. */
  detail?: string;
  outcome: "known-failed" | "unknown";
}
