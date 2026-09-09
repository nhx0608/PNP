import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ENTRY = fileURLToPath(new URL("../../../src/tools/desktop-mcp/main.ts", import.meta.url));

export async function startDesktopClient(): Promise<{ client: Client; stop: () => Promise<void> }> {
  const flags = process.features.typescript === false ? ["--experimental-strip-types"] : [];
  const transport = new StdioClientTransport({ command: process.execPath, args: [...flags, "--no-warnings", ENTRY], stderr: "ignore" });
  const client = new Client({ name: "desktop-mcp-tests", version: "0.0.0" });
  await client.connect(transport);
  return { client, stop: async () => client.close() };
}
