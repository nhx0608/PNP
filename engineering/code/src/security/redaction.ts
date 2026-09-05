import type { Json } from "../contracts/index.ts";

const sensitiveKey = /authorization|api[-_]?key|token|password|secret|cookie|connectionstring|privatekey/i;
export class Redactor {
  private readonly secrets: string[];
  constructor(secrets: readonly string[] = []) {
    this.secrets = [...secrets].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  }
  text(value: string): string {
    let result = value;
    for (const secret of this.secrets) result = result.split(secret).join("[REDACTED]");
    return result
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
      .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/g, "$1[REDACTED]@")
      .replace(/((?:api[_-]?key|password|access[_-]?token|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  }
  streamText(value: string): string {
    let cut = value.length;
    for (const secret of this.secrets) {
      for (let size = Math.min(secret.length - 1, value.length); size > 0; size--) {
        if (value.endsWith(secret.slice(0, size))) { cut = Math.min(cut, value.length - size); break; }
      }
    }
    return this.text(value.slice(0, cut));
  }
  json(value: Json): Json {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.json(item));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key, sensitiveKey.test(key) ? "[REDACTED]" : this.json(item),
      ]));
    }
    return value;
  }
}
