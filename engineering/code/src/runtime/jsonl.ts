import { StringDecoder } from "node:string_decoder";
import { PnpError } from "../core/errors.ts";

/** LF-only framing; U+2028/U+2029 inside a JSON string are not delimiters. */
export class JsonlDecoder {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private readonly maxBytes: number;
  constructor(maxBytes = 4 * 1024 * 1024) { this.maxBytes = maxBytes; }
  push(chunk: Buffer): string[] {
    this.buffer += this.decoder.write(chunk);
    const lines: string[] = [];
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (Buffer.byteLength(line) > this.maxBytes) this.tooLarge();
      if (line.length > 0) lines.push(line);
    }
    if (Buffer.byteLength(this.buffer) > this.maxBytes) this.tooLarge();
    return lines;
  }
  end(): void {
    this.buffer += this.decoder.end();
    if (this.buffer.trim().length !== 0) {
      throw new PnpError("ENGINE_PROTOCOL_ERROR", "Truncated JSONL frame.", 502);
    }
  }
  private tooLarge(): never {
    throw new PnpError("ENGINE_PROTOCOL_ERROR", "JSONL frame exceeds the configured limit.", 502);
  }
}
