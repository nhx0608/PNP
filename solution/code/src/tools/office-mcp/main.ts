import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOfficeServer, SERVER_NAME, SERVER_VERSION } from "./server.ts";

/**
 * Entry point of the Office MCP server: `node dist/tools/office-mcp/main.js`, started by the gateway
 * over stdio. stdout carries JSON-RPC frames and nothing else — every diagnostic goes to stderr,
 * because one stray line on stdout desynchronises the client and takes the whole tool set down.
 */
async function main(): Promise<void> {
  const server = createOfficeServer();
  const transport = new StdioServerTransport();
  const shutdown = (): void => {
    void server.close().finally(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} MCP server ${SERVER_VERSION} ready on stdio (node ${process.versions.node}, ${process.platform})\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${SERVER_NAME} MCP server failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
