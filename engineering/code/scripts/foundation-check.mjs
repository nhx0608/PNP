import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { npm, codeRoot } from "./lib.mjs";
const toolchain = JSON.parse(readFileSync(path.join(codeRoot, "toolchain.json"), "utf8"));
if (process.versions.node !== toolchain.node) throw new Error(`Foundation requires Node ${toolchain.node}; found ${process.versions.node}.`);
if (!existsSync(path.join(codeRoot, "package-lock.json"))) throw new Error("Real package-lock.json is required. Run dependencies:freeze in the approved network.");
npm(["run", "check"]);
console.log("Foundation gate passed. Record this commit and lockfile hash in the handoff.");
