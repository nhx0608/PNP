import type { Json } from "../contracts/index.ts";

/**
 * Key segments, from camelCase boundaries and every non-letter separator (`_`, `-`, `.`, digits),
 * lowercased. Segment matching replaces the substring test this file used to run: `/token/i` matched
 * inside `tokensBefore`, `estimatedTokensAfter`, `inputTokens` and `outputTokens`, so every counter a
 * `compaction_end` or usage payload carries was blanked on its way to the northbound `engine.extension`
 * event - the event still arrived, empty of the only numbers it exists to carry.
 */
function segmentsOf(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
}
/** Words that name a credential on their own, whatever surrounds them. */
const SENSITIVE_SEGMENTS = new Set([
  "authorization", "token", "tokens", "password", "passwords", "passwd",
  "secret", "secrets", "cookie", "cookies",
]);
/**
 * Credential names split across two segments (`api` + `key`) or written solid (`apikey`), so `API_KEY`,
 * `apiKey` and `apikey` all match. Tested against every segment and against every adjacent pair joined.
 * `key` and `string` are deliberately absent from the single-word set: alone they name neither.
 */
const SENSITIVE_COMPOUNDS = new Set(["apikey", "privatekey", "connectionstring"]);
/**
 * Solid spellings the substring test used to catch and segment equality would not: `githubtoken`,
 * `clientsecret`, `userpassword`. A qualifier fused onto a credential noun is still that credential, so a
 * segment strictly longer than one of these and ending in it is redacted. Singular only - `tokens` ends
 * in `token` in no sense that matters here, and matching it would blank `inputtokens` again.
 */
const SENSITIVE_SUFFIXES = ["token", "secret", "password", "cookie"];
/**
 * `token` is the only sensitive word that is also a unit of measurement, so it alone gets an exemption:
 * where the key also counts something, `token(s)` names a quantity rather than a credential. The test
 * spans the whole key instead of the neighbouring segment because the counting word leads in
 * `inputTokens`, trails in `tokenCount`, and is neither adjacent in `contextWindowTokens`. `in` and `out`
 * are excluded on purpose despite reading as counters: they would carry `signInToken` past this.
 */
const COUNTER_SEGMENTS = new Set([
  "count", "counts", "used", "usage", "before", "after", "total", "totals", "remaining",
  "limit", "limits", "max", "min", "input", "output", "prompt", "completion", "cached",
  "context", "reasoning", "thinking", "estimate", "estimated", "budget", "size", "delta",
]);
/**
 * Words that make `token` a credential no matter what else the key counts, so `apiTokenCount` and
 * `sessionTokensRemaining` stay redacted. The list cannot be complete, and does not need to be: a
 * qualifier it misses only matters for a key that also counts something, and a bare `refreshToken` or
 * `githubToken` is already caught by the segment and suffix rules above.
 */
const CREDENTIAL_SEGMENTS = new Set([
  "access", "refresh", "bearer", "auth", "oauth", "id", "session",
  "api", "client", "owner", "resume", "personal", "environment", "csrf", "xsrf",
]);
function isSensitiveKey(key: string): boolean {
  const segments = segmentsOf(key);
  const counting = segments.some((segment) => COUNTER_SEGMENTS.has(segment));
  const credential = segments.some((segment) => CREDENTIAL_SEGMENTS.has(segment));
  for (const [index, segment] of segments.entries()) {
    const next = segments[index + 1];
    if (SENSITIVE_COMPOUNDS.has(segment)) return true;
    if (next !== undefined && SENSITIVE_COMPOUNDS.has(segment + next)) return true;
    if (SENSITIVE_SUFFIXES.some((word) => segment.length > word.length && segment.endsWith(word))) return true;
    if (!SENSITIVE_SEGMENTS.has(segment)) continue;
    if ((segment === "token" || segment === "tokens") && counting && !credential) continue;
    return true;
  }
  return false;
}
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
        key, isSensitiveKey(key) ? "[REDACTED]" : this.json(item),
      ]));
    }
    return value;
  }
}
