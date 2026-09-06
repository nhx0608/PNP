import { StringDecoder } from "node:string_decoder";
import { PnpError } from "../core/errors.ts";

/** LF-only framing; U+2028/U+2029 inside a JSON string are not delimiters. */
export class JsonlDecoder {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  /** Incremental accounting; recomputing the whole pending buffer per chunk is quadratic. */
  private bufferBytes = 0;
  private ended = false;
  private readonly maxBytes: number;
  constructor(maxBytes = 4 * 1024 * 1024) { this.maxBytes = maxBytes; }
  push(chunk: Buffer): string[] {
    if (this.ended) throw new PnpError("ENGINE_PROTOCOL_ERROR", "JSONL frames arrived after end of stream.", 502);
    const text = this.decoder.write(chunk);
    this.buffer += text;
    this.bufferBytes += Buffer.byteLength(text);
    const lines: string[] = [];
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const raw = this.buffer.slice(0, index);
      const rawBytes = Buffer.byteLength(raw);
      this.buffer = this.buffer.slice(index + 1);
      this.bufferBytes -= rawBytes + 1;
      if (rawBytes > this.maxBytes) this.tooLarge();
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.length > 0) lines.push(line);
    }
    if (this.bufferBytes > this.maxBytes) this.tooLarge();
    return lines;
  }
  /** Idempotent: the production paths end a decoder from both the frame protocol and the stream. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.buffer += this.decoder.end();
    this.bufferBytes = Buffer.byteLength(this.buffer);
    if (this.buffer.trim().length !== 0) {
      throw new PnpError("ENGINE_PROTOCOL_ERROR", "Truncated JSONL frame.", 502);
    }
  }
  /** Discards an unterminated tail that a known transport truncation explains. */
  discard(): string {
    this.ended = true;
    const pending = this.buffer + this.decoder.end();
    this.buffer = "";
    this.bufferBytes = 0;
    return pending;
  }
  private tooLarge(): never {
    throw new PnpError("ENGINE_PROTOCOL_ERROR", "JSONL frame exceeds the configured limit.", 502);
  }
}
