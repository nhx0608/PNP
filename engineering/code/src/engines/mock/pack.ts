import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { EngineCapabilities, EngineOpenInput, EnginePack, EngineResult, EngineSessionChannel, NativeSessionRef, StopEvidence } from "../../contracts/index.ts";
import { CONTRACT_VERSION } from "../../contracts/index.ts";

export interface MockOptions {
  delayMs?: number;
  fail?: boolean;
  stuck?: boolean;
  terminateQuiescent?: boolean;
}
export class MockPack implements EnginePack {
  readonly descriptor: EnginePack["descriptor"] = {
    id: "mock", channelId: "test", implementationProvided: true, transport: "test" as const, contractVersion: CONTRACT_VERSION, developmentOnly: true,
  };
  readonly options: MockOptions;
  opens = 0;
  executions = 0;
  constructor(options: MockOptions = {}) { this.options = options; }
  async open(input: EngineOpenInput): Promise<EngineSessionChannel> {
    this.opens += 1;
    return new MockChannel(input, this);
  }
}
class MockChannel implements EngineSessionChannel {
  readonly native: NativeSessionRef;
  readonly capabilities: EngineCapabilities = {
    sessionResume: true, streaming: true, cancellation: true, nativeDelete: false, extensions: [],
  };
  private readonly input: EngineOpenInput;
  private readonly pack: MockPack;
  constructor(input: EngineOpenInput, pack: MockPack) {
    this.input = input;
    this.pack = pack;
    this.native = {
      nativeId: input.session.native?.nativeId ?? `mock-${input.session.id}`,
      channelId: "test", engineVersion: "test-fixture-1",
      resumeToken: path.join(input.nativeDataDirectory, "mock-state.json"),
    };
  }
  async run(input: Parameters<EngineSessionChannel["run"]>[0]): Promise<EngineResult> {
    this.pack.executions += 1;
    if (this.pack.options.stuck) return new Promise<EngineResult>(() => undefined);
    if (this.pack.options.fail) throw new Error("Simulated driver failure.");
    let count = 0;
    try { count = (JSON.parse(await readFile(this.native.resumeToken!, "utf8")) as { count: number }).count; }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const resultText = `Mock turn ${count + 1}: ${input.request.parts.map((p) => p.text).join("\n")}`;
    try {
      await input.services.events.emit({ type: "text.delta", text: "Mock is processing. " });
      await input.services.events.emit({ type: "tool.started", callId: "mock-call", name: "mock.inspect", input: { directory: this.input.session.directory } });
      await delay(this.pack.options.delayMs ?? 10, undefined, { signal: input.signal });
      await input.services.events.emit({ type: "tool.finished", callId: "mock-call", name: "mock.inspect", output: { observed: true }, failed: false });
      await input.services.events.emit({ type: "text.delta", text: resultText });
      await writeFile(this.native.resumeToken!, JSON.stringify({ count: count + 1 }), "utf8");
      return { state: "completed", finish: "stop", quiescent: true, finalText: resultText, nativeStopReason: "end_turn", taskOutcome: "unknown" };
    } catch (error) {
      if (!input.signal.aborted) throw error;
      return { state: "cancelled", finish: "cancelled", quiescent: true, finalText: "", nativeStopReason: "cancelled", taskOutcome: "unknown" };
    }
  }
  async cancel(): Promise<void> { /* AbortSignal is the mock's cooperative stop channel. */ }
  async terminate(): Promise<StopEvidence> {
    return { quiescent: this.pack.options.terminateQuiescent ?? true, method: "process-tree" };
  }
  async close(): Promise<StopEvidence> { return { quiescent: true, method: "not-running" }; }
}
