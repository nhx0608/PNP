import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const codeRoot = fileURLToPath(new URL("../", import.meta.url));
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory()
    ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
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
    if (normalized.startsWith("src/contracts/") && !target.startsWith("./")) violations.push(`${file}: contracts must not import implementations`);
  }
}
if (violations.length) { console.error(violations.join("\n")); process.exit(1); }
console.log("Architecture import boundaries: PASS");
