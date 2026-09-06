import type { Json } from "../../contracts/index.ts";

const MAX_DEPTH = 16;

/**
 * Converts unvalidated ACP payloads into the public Json shape without inventing content.
 * Values that cannot be represented (functions, symbols, cycles, non-finite numbers) become null.
 */
export function toJson(value: unknown, depth = 0, seen: readonly object[] = []): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return null;
  if (depth >= MAX_DEPTH || seen.includes(value)) return null;
  const path = [...seen, value];
  if (Array.isArray(value)) return value.map((item) => toJson(item, depth + 1, path));
  const result: { [key: string]: Json } = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    result[key] = toJson(item, depth + 1, path);
  }
  return result;
}

export function jsonObject(value: unknown): { [key: string]: Json } {
  const converted = toJson(value);
  return converted !== null && typeof converted === "object" && !Array.isArray(converted) ? converted : {};
}
