import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const codeRoot = fileURLToPath(new URL("../", import.meta.url));
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory()
    ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

/**
 * AGENTS.md: "Adapter 不直接使用 Fastify、SQLite、GatewayCore 或 child_process". The three checks
 * below used to test only for a trailing "xxx/" path segment in the import target, so a bare
 * package name (no "/" at all — "fastify", "node:sqlite") or a same-tree relative import of the
 * core gateway class ("../core/gateway-core.ts", which never matched "storage/" or "gateway/")
 * went straight through undetected (confirmed by injecting exactly such an adapter — see
 * docs/engineering-review-2.md §9.5, §5). These three rules close that gap; they apply to every
 * "Adapter" directory (engines, drivers, integration), matching the AGENTS.md sentence above.
 */
const ADAPTER_DIR = /^src\/(engines|drivers|integration)\//;
const NEW_ADAPTER_FORBIDDEN = [
  { label: "GatewayCore (import the contract types instead)", pattern: /(^|\/)core\/gateway-core(\.[cm]?[jt]s)?($|\/)/ },
  { label: "Fastify", pattern: /^fastify(\/|$)/ },
  { label: "the built-in SQLite module", pattern: /^node:sqlite(\/|$)/ },
];

const violations = [];
for (const file of walk(path.join(codeRoot, "src")).filter((f) => f.endsWith(".ts"))) {
  const normalized = path.relative(codeRoot, file).replaceAll("\\", "/");
  const text = readFileSync(file, "utf8");
  const imports = [...text.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g)].map((m) => m[1]);
  for (const target of imports) {
    if ((normalized.startsWith("src/core/") || normalized.startsWith("src/gateway/"))
      && /engines\/|drivers\/|@agentclientprotocol|pi-coding-agent/.test(target)) violations.push(`${file}: ${target}`);
    if (/^src\/(engines|drivers)\//.test(normalized) && /storage\/|gateway\/|child_process/.test(target)) violations.push(`${file}: ${target}`);
    if (normalized.startsWith("src/integration/") && /engines\/|drivers\/|gateway\/|storage\//.test(target)) violations.push(`${file}: ${target}`);
    if (ADAPTER_DIR.test(normalized)) {
      const hit = NEW_ADAPTER_FORBIDDEN.find((rule) => rule.pattern.test(target));
      if (hit) violations.push(`${file}: ${target} (adapters must not use ${hit.label} directly)`);
    }
    if (normalized.startsWith("src/contracts/") && !target.startsWith("./")) violations.push(`${file}: contracts must not import implementations`);
  }
}
if (violations.length) { console.error(violations.join("\n")); process.exit(1); }
console.log("Architecture import boundaries: PASS");
