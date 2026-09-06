import { randomUUID } from "node:crypto";
import type { Json, ResourceScope, StopEvidence } from "../../src/contracts/index.ts";
import type { HostedProcess, LaunchSpec, ProcessHost } from "../../src/contracts/host.ts";

/**
 * A scripted stand-in for the shared ProcessHost.
 *
 * It speaks the real frame contract (one JSON-RPC message per frame, the host owns the separator) so a driver
 * can be exercised without any engine binary. Everything a real process can do to a driver is expressible here:
 * answer, answer wrongly, answer late, never answer, or die.
 */

/** Returned by a handler that must produce no reply at all: the engine that accepts a request and goes silent. */
export const NO_REPLY: unique symbol = Symbol("pnp.fake-host.no-reply");

/** A scripted JSON-RPC error reply. Thrown from a handler, it becomes an error response on the wire. */
export class RpcFault extends Error {
  readonly code: number;
  readonly data: Json | undefined;
  constructor(code: number, message: string, data?: Json) {
    super(message);
    this.name = "RpcFault";
    this.code = code;
    this.data = data;
  }
}

export interface FakeProcessOptions {
  hostId?: string;
  generation?: number;
  /** Evidence terminate() resolves with. Defaults to proven quiescence. */
  evidence?: StopEvidence;
  /** terminate() rejects instead of resolving, so cleanup cannot prove itself. */
  terminateRejects?: boolean;
}

/** One hosted process. The test drives it from the outside; the driver only sees the HostedProcess contract. */
export class FakeHostedProcess implements HostedProcess {
  readonly hostId: string;
  readonly generation: number;
  /** Every frame the driver wrote, in order. */
  readonly written: string[] = [];
  terminateCalls = 0;
  private readonly options: FakeProcessOptions;
  private readonly frameListeners = new Set<(frame: string) => void>();
  private readonly exitListeners = new Set<(exit: { code: number | null; signal: string | null }) => void>();
  private sink: ((frame: string) => void) | undefined;
  private writeFailure: Error | undefined;
  private exited = false;

  constructor(options: FakeProcessOptions = {}) {
    this.options = options;
    this.hostId = options.hostId ?? randomUUID();
    this.generation = options.generation ?? 1;
  }

  write(frame: string): Promise<void> {
    if (this.writeFailure !== undefined) return Promise.reject(this.writeFailure);
    this.written.push(frame);
    const sink = this.sink;
    // The real host writes to a pipe; the peer reads it on a later tick, never inside the writer's call.
    if (sink !== undefined) queueMicrotask(() => { sink(frame); });
    return Promise.resolve();
  }
  onFrame(listener: (frame: string) => void): () => void {
    this.frameListeners.add(listener);
    return () => { this.frameListeners.delete(listener); };
  }
  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }
  terminate(): Promise<StopEvidence> {
    this.terminateCalls += 1;
    if (this.options.terminateRejects === true) {
      return Promise.reject(new Error("Termination could not be proven."));
    }
    return Promise.resolve(this.options.evidence ?? { quiescent: true, method: "process-tree" });
  }

  /** Installs the single reader of driver output. The scripted agent owns it. */
  readFrames(sink: (frame: string) => void): void {
    this.sink = sink;
  }
  /** Delivers one inbound frame exactly as the shared host would after decoding a line. */
  deliver(frame: string): void {
    for (const listener of [...this.frameListeners]) listener(frame);
  }
  /** The engine process dies. Every promise the driver is holding must settle from this alone. */
  exit(code: number | null = 1, signal: string | null = null): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.exitListeners]) listener({ code, signal });
  }
  /** Subsequent writes reject: a broken pipe that has not yet surfaced as an exit. */
  failWrites(error: Error): void {
    this.writeFailure = error;
  }
  get frameListenerCount(): number {
    return this.frameListeners.size;
  }
}

export interface FakeHostOptions {
  /** start() rejects with this instead of returning a process. */
  startRejects?: Error;
}

/** A ProcessHost that hands out prepared processes and records what was asked of it. */
export class FakeProcessHost implements ProcessHost {
  readonly specs: LaunchSpec[] = [];
  readonly started: FakeHostedProcess[] = [];
  reconcileCalls = 0;
  private readonly queue: FakeHostedProcess[];
  private readonly options: FakeHostOptions;

  constructor(processes: readonly FakeHostedProcess[] = [], options: FakeHostOptions = {}) {
    this.queue = [...processes];
    this.options = options;
  }

  start(spec: LaunchSpec, signal: AbortSignal, resources: ResourceScope): Promise<HostedProcess> {
    if (this.options.startRejects !== undefined) return Promise.reject(this.options.startRejects);
    if (signal.aborted) return Promise.reject(new Error("Acquisition was cancelled before the process started."));
    this.specs.push(spec);
    const hosted = this.queue.shift() ?? new FakeHostedProcess();
    this.started.push(hosted);
    // The real host registers ownership before the process is usable; a driver must never do it itself.
    resources.register(`fake-host:${hosted.hostId}`, () => hosted.terminate());
    return Promise.resolve(hosted);
  }
  reconcile(_previous: Json): Promise<StopEvidence> {
    void _previous;
    this.reconcileCalls += 1;
    return Promise.resolve({ quiescent: true, method: "not-running" });
  }
}

/** A handler for one inbound method. Returning NO_REPLY leaves the request unanswered forever. */
export type MethodHandler = (params: unknown, agent: FakeAgent) => unknown;

export interface FakeAgentOptions {
  handlers?: Readonly<Record<string, MethodHandler>>;
}

interface Waiter {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

/**
 * The peer on the other end of the frames: a JSON-RPC agent whose every answer comes from the test script.
 *
 * Requests are dispatched concurrently on purpose. An engine that is still producing a prompt response has to
 * keep accepting `session/cancel`, so serialising handlers here would hide the exact behaviour under test.
 */
export class FakeAgent {
  /** Every request the driver sent, in order. */
  readonly requests: { method: string; params: unknown }[] = [];
  /** Every notification the driver sent, in order. */
  readonly notifications: { method: string; params: unknown }[] = [];
  /** The first handler failure that was not a scripted RpcFault. Tests assert it stayed undefined. */
  failure: unknown;
  private readonly process: FakeHostedProcess;
  private readonly handlers = new Map<string, MethodHandler>();
  private readonly pending = new Map<string, Waiter>();
  private readonly outstanding = new Set<Promise<void>>();
  private nextId = 1;

  constructor(process: FakeHostedProcess, options: FakeAgentOptions = {}) {
    this.process = process;
    for (const [method, handler] of Object.entries(options.handlers ?? {})) this.handlers.set(method, handler);
    process.readFrames((frame) => { this.receive(frame); });
  }

  /** Installs or replaces the script for one method. */
  on(method: string, handler: MethodHandler): this {
    this.handlers.set(method, handler);
    return this;
  }
  /** Sends a notification to the driver. */
  notify(method: string, params: unknown): void {
    this.process.deliver(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }
  /** Sends a request to the driver and resolves with its reply. */
  request<T>(method: string, params: unknown): Promise<T> {
    const id = `agent-${String(this.nextId++)}`;
    const answer = new Promise<unknown>((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
    this.process.deliver(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return answer as Promise<T>;
  }
  /** Delivers a raw frame, including frames that are not valid JSON-RPC at all. */
  deliverRaw(frame: string): void {
    this.process.deliver(frame);
  }
  /** Resolves once every frame received so far has been fully handled. */
  async settled(): Promise<void> {
    while (this.outstanding.size > 0) await Promise.all([...this.outstanding]);
  }
  /** Counts how many times the driver called one method. */
  countOf(method: string): number {
    return this.requests.filter((entry) => entry.method === method).length
      + this.notifications.filter((entry) => entry.method === method).length;
  }
  /** The params of the first call to one method, request or notification. */
  paramsOf(method: string): unknown {
    return (this.requests.find((entry) => entry.method === method)
      ?? this.notifications.find((entry) => entry.method === method))?.params;
  }

  private receive(frame: string): void {
    const work = this.dispatch(frame).catch((error: unknown) => { this.failure ??= error; });
    this.outstanding.add(work);
    void work.then(() => { this.outstanding.delete(work); });
  }

  private async dispatch(frame: string): Promise<void> {
    const decoded: unknown = JSON.parse(frame);
    if (decoded === null || typeof decoded !== "object") throw new Error("The driver wrote a non-object frame.");
    const message = decoded as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    if (typeof message.method === "string") {
      await this.dispatchCall(message.method, message.id, message.params);
      return;
    }
    const waiter = this.pending.get(String(message.id));
    if (waiter === undefined) return;
    this.pending.delete(String(message.id));
    if (message.error !== undefined && message.error !== null) waiter.reject(message.error);
    else waiter.resolve(message.result);
  }

  private async dispatchCall(method: string, id: unknown, params: unknown): Promise<void> {
    const handler = this.handlers.get(method);
    if (id === undefined || id === null) {
      this.notifications.push({ method, params });
      if (handler !== undefined) await handler(params, this);
      return;
    }
    this.requests.push({ method, params });
    const requestId = id as string | number;
    if (handler === undefined) {
      this.reply({ id: requestId, error: { code: -32601, message: `The script has no handler for ${method}.` } });
      return;
    }
    try {
      const result = await handler(params, this);
      if (result === NO_REPLY) return;
      this.reply({ id: requestId, result: result ?? null });
    } catch (error) {
      if (!(error instanceof RpcFault)) throw error;
      this.reply({
        id: requestId,
        error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) },
      });
    }
  }

  private reply(payload: { id: string | number; result?: unknown; error?: unknown }): void {
    this.process.deliver(JSON.stringify({ jsonrpc: "2.0", ...payload }));
  }
}
