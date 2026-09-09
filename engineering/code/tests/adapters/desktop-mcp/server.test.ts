import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { startDesktopClient } from "./harness.ts";
import { DesktopMcpError } from "../../../src/tools/desktop-mcp/errors.ts";
import { openApplication, type DesktopApplication, type DesktopOperations } from "../../../src/tools/desktop-mcp/windows.ts";

let session: Awaited<ReturnType<typeof startDesktopClient>> | undefined;
async function client(): Promise<Client> { session ??= await startDesktopClient(); return session.client; }
after(async () => { await session?.stop(); });

test("real stdio MCP handshake lists the two fixed desktop tools", async () => {
  const listed = await (await client()).listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["desktop_list_apps", "desktop_open_app"]);
  assert.equal(listed.tools[0]?.inputSchema.type, "object");
  assert.equal(listed.tools[1]?.annotations?.destructiveHint, false);
  assert.equal(listed.tools[1]?.annotations?.readOnlyHint, false);
});

test("discovery returns a controlled app catalogue or a Windows platform diagnostic", async () => {
  const result = await (await client()).callTool({ name: "desktop_list_apps", arguments: {} });
  if (process.platform === "win32") {
    assert.notEqual(result.isError, true);
    const data = result.structuredContent as { applications: { id: string }[] };
    assert.deepEqual(data.applications.map((app) => app.id), ["notepad", "outlook-classic", "outlook-new"]);
  } else {
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /PLATFORM_UNSUPPORTED/);
  }
});

test("open rejects arbitrary command-shaped input through schema validation", async () => {
  const result = await (await client()).callTool({ name: "desktop_open_app", arguments: { appId: "notepad; Stop-Computer" } });
  assert.equal(result.isError, true);
});

test("unavailable Outlook is diagnosed without ever invoking the launcher", async () => {
  let launchCalls = 0;
  const unavailable: DesktopApplication[] = [{
    id: "outlook-classic", name: "Outlook (classic)", available: false, diagnostic: "Classic Outlook is not registered.",
  }];
  const operations: DesktopOperations = {
    discover: async () => unavailable,
    activate: async () => { launchCalls++; },
  };
  await assert.rejects(openApplication("outlook-classic", undefined, operations), (error: unknown) =>
    error instanceof DesktopMcpError && error.code === "APP_UNAVAILABLE");
  assert.equal(launchCalls, 0);
});

test("cancellation signal reaches the shell activation boundary", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  let activationStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { activationStarted = resolve; });
  const operations: DesktopOperations = {
    discover: async () => [{ id: "notepad", name: "Notepad", available: true, executablePath: "C:\\Windows\\System32\\notepad.exe" }],
    activate: async (_appId, signal) => {
      receivedSignal = signal;
      activationStarted?.();
      await new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DesktopMcpError("CANCELLED", "test cancellation")), { once: true }));
    },
  };
  const opening = openApplication("notepad", controller.signal, operations);
  await started;
  controller.abort();
  await assert.rejects(opening, (error: unknown) =>
    error instanceof DesktopMcpError && error.code === "CANCELLED");
  assert.equal(receivedSignal, controller.signal);
});

test("cancellation before activation never launches even if discovery ignores cancellation", async () => {
  const controller = new AbortController();
  let launched = false;
  const operations: DesktopOperations = {
    discover: async () => { controller.abort(); return [{ id: "notepad", name: "Notepad", available: true }]; },
    activate: async () => { launched = true; },
  };
  await assert.rejects(openApplication("notepad", controller.signal, operations), { code: "CANCELLED" });
  assert.equal(launched, false);
});
