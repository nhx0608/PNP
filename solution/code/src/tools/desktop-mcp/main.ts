import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDesktopServer, SERVER_NAME, SERVER_VERSION } from "./server.ts";

async function main(): Promise<void> {
  const server = createDesktopServer();
  const transport = new StdioServerTransport();
  const shutdown = (): void => {
    void server.close().then(() => process.exit(0)).catch((error: unknown) => {
      process.stderr.write(`${SERVER_NAME} MCP server shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} MCP server ${SERVER_VERSION} ready on stdio\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${SERVER_NAME} MCP server failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
