import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
const args = parseArgs({ options: { engine: { type: "string" } } });
const selected = process.env.AGENT_ENGINE ?? args.values.engine;
const conflict = !!(process.env.AGENT_ENGINE && args.values.engine && process.env.AGENT_ENGINE !== args.values.engine);
const toolchain = JSON.parse(readFileSync("toolchain.json", "utf8"));
const checks = [
  { id: "node-version", passed: process.versions.node === toolchain.node, observed: process.versions.node },
  { id: "target-os", passed: process.platform === "win32", observed: process.platform },
  { id: "dependency-lock", passed: existsSync("package-lock.json") },
  { id: "compiled-entry", passed: existsSync("dist/main.js") },
  { id: "selected-engine", passed: !!selected && selected !== "mock" && !conflict, observed: selected },
];
if (process.platform === "win32") {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::Write((Get-Process -Id $PID).SessionId)"], { encoding: "utf8", windowsHide: true });
  const id = Number((result.stdout ?? "").trim());
  checks.push({ id: "interactive-session-id", passed: result.status === 0 && Number.isFinite(id) && id > 0 });
}
console.log(JSON.stringify({ scope: "local-environment-only", checks, modelRoundTrip: "not_run", desktopAction: "not_run", internalTools: "not_run" }, null, 2));
if (checks.some((c) => !c.passed)) process.exitCode = 1;
