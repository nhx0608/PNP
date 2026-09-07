import { randomUUID } from "node:crypto";
import type { HostedProcess } from "../../contracts/host.ts";
import type { Json } from "../../contracts/index.ts";
import { PnpError } from "../../core/errors.ts";
import { deferred, bounded } from "../../runtime/deadline.ts";
import type { PiCommandType, PiEvent } from "./protocol.ts";
import { encodeCommand, parsePiFrame } from "./protocol.ts";

export interface PiRpcClientOptions {
  /** Every decoded event, including responses that were also routed to a pending request. */
  onEvent?: (event: PiEvent) => void;
  /** A frame that failed to parse is isolated here instead of tearing down the whole channel. */
  onProtocolWarning?: (line: string, error: unknown) => void;
  defaultTimeoutMs?: number;
}

/**
 * Correlates `pi --mode rpc` JSONL commands with their `{"type":"response"}` replies over an
 * already-framed `HostedProcess` (LF splitting and UTF-8 reassembly happen in
 * `runtime/process-host.ts`; this client only turns lines into typed events and matches ids).
 */
export class PiRpcClient {
  private readonly process: HostedProcess;
  private readonly pending = new Map<string, { resolve(value: Json): void; reject(reason: unknown): void }>();
  private readonly defaultTimeoutMs: number;
  private readonly unsubscribeFrame: () => void;
  private readonly unsubscribeExit: () => void;
  private closed = false;
  constructor(process: HostedProcess, options: PiRpcClientOptions = {}) {
    this.process = process;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    this.unsubscribeFrame = process.onFrame((line) => this.handleFrame(line, options));
    this.unsubscribeExit = process.onExit((exit) => this.handleExit(exit));
  }
  private handleFrame(line: string, options: PiRpcClientOptions): void {
    let event: PiEvent;
    try { event = parsePiFrame(line); }
    catch (error) { options.onProtocolWarning?.(line, error); return; }
    if (event.type === "response") {
      const waiter = this.pending.get(event.id);
      if (waiter !== undefined) {
        this.pending.delete(event.id);
        if (event.success) waiter.resolve(event.data ?? null);
        else waiter.reject(new PnpError("ENGINE_PROTOCOL_ERROR", event.error ?? "Pi RPC command failed.", 502));
      }
      // A response with no matching waiter (late arrival after a client-side timeout) is still
      // surfaced as an event so the channel can log an isolated diagnostic, not silently drop it.
    }
    options.onEvent?.(event);
  }
  private handleExit(exit: { code: number | null; signal: string | null }): void {
    this.closed = true;
    this.unsubscribeFrame();
    this.unsubscribeExit();
    const error = new PnpError("ENGINE_UNAVAILABLE", `Pi RPC process exited (code=${exit.code ?? "null"}, signal=${exit.signal ?? "null"}).`, 502);
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
  /** Sends a command and awaits its `{"type":"response"}`. The response is acceptance evidence
   * only; callers must not treat it as run completion (contracts.md §4). */
  async send(type: PiCommandType, payload: Readonly<Record<string, Json>> = {}, timeoutMs = this.defaultTimeoutMs): Promise<Json> {
    if (this.closed) throw new PnpError("ENGINE_UNAVAILABLE", "Pi RPC process is not running.", 502);
    const id = randomUUID();
    const waiting = deferred<Json>();
    this.pending.set(id, waiting);
    try {
      await this.process.write(encodeCommand(id, type, payload));
      return await bounded(waiting.promise, timeoutMs);
    } finally { this.pending.delete(id); }
  }
  /** Best-effort control command (for example `abort`) whose acceptance is not stop evidence. */
  async post(type: PiCommandType, payload: Readonly<Record<string, Json>> = {}): Promise<void> {
    if (this.closed) throw new PnpError("ENGINE_UNAVAILABLE", "Pi RPC process is not running.", 502);
    await this.process.write(encodeCommand(randomUUID(), type, payload));
  }
  get running(): boolean { return !this.closed; }
  dispose(): void {
    this.unsubscribeFrame();
    this.unsubscribeExit();
    const error = new PnpError("EXECUTION_CANCELLED", "Pi RPC client was disposed.", 409);
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
