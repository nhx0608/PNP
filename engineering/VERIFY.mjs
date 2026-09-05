import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";
const root = path.dirname(fileURLToPath(import.meta.url));
let checked = 0;
for (const line of readFileSync(path.join(root, "SHA256SUMS.txt"), "utf8").trim().split("\n")) {
  const parsed = /^([a-f0-9]{64})  (.+)$/.exec(line);
  if (!parsed) throw new Error("Invalid checksum manifest.");
  const file = path.resolve(root, parsed[2]);
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Unsafe manifest path.");
  if (createHash("sha256").update(readFileSync(file)).digest("hex") !== parsed[1]) throw new Error(`Checksum mismatch: ${relative}`);
  checked++;
}
console.log(`Verified ${checked} files.`);
