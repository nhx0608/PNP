// Explicit desktop smoke: opens one blank Notepad through a real Windows Job-hosted MCP server.
// Existing Notepad processes/windows are never closed. A new PID is observed, not claimed owned.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LocalProcessHost } from "../../src/runtime/process-host.ts";
import { OwnedResourceScope } from "../../src/runtime/resource-scope.ts";
import { codeRoot } from "../lib.mjs";

const { values } = parseArgs({ options: { artifacts: { type: "string" }, "open-notepad": { type: "boolean" } } });
if (process.platform !== "win32" || !values["open-notepad"]) throw new Error("This Windows smoke opens a blank Notepad. Pass --open-notepad explicitly.");
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
function snapshot() {
  const output = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    "@((Get-Process notepad -ErrorAction SilentlyContinue) | ForEach-Object { @{ id=$_.Id; started=$_.StartTime.ToUniversalTime().ToString('o'); window=($_.MainWindowHandle -ne 0) } }) | ConvertTo-Json -Compress"],
  { encoding: "utf8", windowsHide: true });
  const parsed = output.trim() ? JSON.parse(output) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}
const work = await mkdtemp(path.join(tmpdir(), "pnp-desktop-job-"));
const scope = new OwnedResourceScope();
const host = new LocalProcessHost(work);
const report = { scope: "windows-native-job-host-and-real-mcp", before: snapshot() };
let stopped;
let processHandle;
const client = new Client({ name: "pnp-desktop-smoke", version: "1.0.0" });
try {
  processHandle = await host.start({ sessionId: "desktop-smoke", ownerToken: `desktop-smoke-${Date.now()}`,
    executable: process.execPath, args: [path.join(codeRoot, "src/tools/desktop-mcp/main.ts")], cwd: work, env: {} }, new AbortController().signal, scope);
  const transport = {
    async start() {
      processHandle.onFrame(frame => {
        try { transport.onmessage?.(JSON.parse(frame)); } catch (error) { transport.onerror?.(error); }
      });
      processHandle.onExit(() => transport.onclose?.());
    },
    async send(message) { await processHandle.write(JSON.stringify(message) + "\n"); },
    async close() { stopped = await processHandle.terminate(); },
  };
  await client.connect(transport);
  report.server = client.getServerVersion();
  report.tools = (await client.listTools()).tools.map(tool => tool.name);
  report.discovery = await client.callTool({ name: "desktop_list_apps", arguments: {} });
  report.activation = await client.callTool({ name: "desktop_open_app", arguments: { appId: "notepad" } });
  if (report.activation.isError) throw new Error("Notepad activation failed.");
  await sleep(2000);
  report.afterActivation = snapshot();
  await client.close();
  report.serverStop = stopped;
  await sleep(2000);
  report.afterServerStop = snapshot();
  const before = new Set(report.before.map(entry => `${entry.id}/${entry.started}`));
  const added = report.afterActivation.filter(entry => !before.has(`${entry.id}/${entry.started}`));
  report.newProcessesSurvived = added.filter(entry => report.afterServerStop.some(after => after.id === entry.id && after.started === entry.started));
  report.passed = stopped?.quiescent === true && report.newProcessesSurvived.length > 0;
  report.applicationCleanup = "not_attempted: application activation may join an existing user instance; user applications are retained";
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.error = error.message;
  report.passed = false;
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
  report.scopeStop = await scope.stop(10000);
  const artifacts = path.resolve(values.artifacts ?? path.join(codeRoot, "runtime/logs/desktop-smoke"));
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ passed: report.passed, newProcessesSurvived: report.newProcessesSurvived?.length ?? 0, report: path.join(artifacts, "report.json"), error: report.error }));
}
