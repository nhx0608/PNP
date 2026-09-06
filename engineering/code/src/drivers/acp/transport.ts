import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import type { HostedProcess } from "../../contracts/host.ts";
import { PnpError } from "../../core/errors.ts";

export interface HostedStreamOptions {
  /** Bounded read queue. A peer that outruns the reader fails the channel instead of growing without limit. */
  maxQueuedMessages?: number;
  /** Ordered observation of every decoded inbound message. Implementations must not throw. */
  observe?: (message: AnyMessage) => void;
}
export interface HostedStream {
  /** Object-mode stream for the ACP SDK. Framing already belongs to the shared ProcessHost. */
  readonly stream: Stream;
  readonly failure: PnpError | undefined;
  /** Errors the readable side so initialize, session and prompt promises settle instead of hanging. */
  fail(error: PnpError): void;
}

/**
 * Adapts a HostedProcess (line framed by the shared runtime) to the object-mode Stream the ACP SDK expects.
 * The SDK's byte-level ndJsonStream is deliberately not used: the shared host owns framing and ownership records.
 */
export function createHostedStream(hosted: HostedProcess, options: HostedStreamOptions = {}): HostedStream {
  const limit = options.maxQueuedMessages ?? 1024;
  let controller: ReadableStreamDefaultController<AnyMessage> | undefined;
  let failure: PnpError | undefined;
  let readerGone = false;
  let detachFrame: (() => void) | undefined;
  let detachExit: (() => void) | undefined;
  const detach = (): void => {
    detachFrame?.();
    detachExit?.();
    detachFrame = undefined;
    detachExit = undefined;
  };
  const fail = (error: PnpError): void => {
    if (failure !== undefined) return;
    failure = error;
    detach();
    if (!readerGone) controller?.error(error);
  };
  const readable = new ReadableStream<AnyMessage>({
    start: (active) => { controller = active; },
    cancel: () => { readerGone = true; detach(); },
  });
  const writable = new WritableStream<AnyMessage>({
    write: async (message) => {
      if (failure !== undefined) throw failure;
      // The host appends the record separator; the driver must not double-frame.
      try { await hosted.write(JSON.stringify(message)); }
      catch (error: unknown) {
        // A broken pipe kills the channel in both directions. Recording it here is what lets a
        // caller tell "the frame was queued" from "the frame reached the engine", and it settles
        // the pending requests that would otherwise wait for a reply that can never arrive.
        fail(error instanceof PnpError ? error
          : new PnpError("HOST_EXITED", "Engine channel write failed before the frame was sent.", 502));
        throw failure;
      }
    },
  });
  detachFrame = hosted.onFrame((frame) => {
    if (failure !== undefined || readerGone) return;
    let decoded: unknown;
    try { decoded = JSON.parse(frame); }
    catch { fail(new PnpError("ENGINE_PROTOCOL_ERROR", "Engine emitted a frame that is not JSON.", 502)); return; }
    if (decoded === null || typeof decoded !== "object") {
      fail(new PnpError("ENGINE_PROTOCOL_ERROR", "Engine emitted a frame that is not a JSON-RPC message.", 502));
      return;
    }
    const message = decoded as AnyMessage;
    options.observe?.(message);
    const active = controller;
    if (active === undefined) return;
    active.enqueue(message);
    if (active.desiredSize !== null && active.desiredSize < -limit) {
      fail(new PnpError("ENGINE_BACKPRESSURE", "Engine output exceeded the inbound queue limit.", 502));
    }
  });
  detachExit = hosted.onExit((exit) => {
    fail(new PnpError("HOST_EXITED", `Engine process exited before the channel closed (code=${exit.code ?? "null"}, signal=${exit.signal ?? "null"}).`, 502));
  });
  return {
    stream: { readable, writable },
    get failure(): PnpError | undefined { return failure; },
    fail,
  };
}
