import { existsSync } from "node:fs";
import path from "node:path";

export function safeDiagnostic(error) {
  const code = typeof error?.code === "string" ? error.code : "DIAGNOSTIC_FAILED";
  const names = [...new Set(String(error?.message ?? "").match(/\b[A-Z][A-Z0-9_]*_[A-Z0-9_]+\b/g) ?? [])]
    .filter((name) => name.startsWith("PNP_"));
  return names.length === 0 ? code : `${code}; missing or invalid variables: ${names.join(", ")}`;
}

export function errorStatus(error) {
  const code = error?.code;
  if (code === "MODEL_ENVIRONMENT_MISSING" || code === "MODEL_ENDPOINT_MISSING" || code === "MODEL_AUTH_MISSING") return "missing_variables";
  if (code === "INSECURE_MODEL_ENDPOINT" || code === "MODEL_ENDPOINT_INVALID" || code === "MODEL_ENVIRONMENT_INVALID") return "invalid_variables";
  if (code === "MODEL_CA_FILE_MISSING") return "missing_file";
  return "configuration_invalid";
}

export function summarizeMcp(settings, environment) {
  return settings.mcp.servers.filter((server) => server.enabled).map((server) => {
    const item = { id: server.id, transport: server.transport, sideEffect: server.sideEffect, status: "not_probed" };
    if (server.transport === "stdio") {
      const commandAbsolute = path.isAbsolute(server.command);
      const commandExists = commandAbsolute ? existsSync(server.command) : undefined;
      const executable = path.basename(server.command).toLowerCase();
      const runtime = executable === "node" || executable === "node.exe" || executable.startsWith("python");
      const firstArg = server.args[0];
      const evalMode = firstArg === "-e" || firstArg === "--eval" || firstArg === "-c";
      const entry = runtime && !evalMode && firstArg !== undefined && path.isAbsolute(firstArg)
        && [".js", ".mjs", ".cjs", ".py"].includes(path.extname(firstArg).toLowerCase()) ? firstArg : undefined;
      const entryExists = entry === undefined ? undefined : existsSync(entry);
      item.command = path.basename(server.command);
      item.commandKind = commandAbsolute ? "file" : "generic-executable";
      item.commandPresent = commandExists;
      if (entry !== undefined) item.entryPresent = entryExists;
      if (commandExists === false || entryExists === false) item.status = "missing_file";
      else if (!commandAbsolute || entry === undefined || entryExists === true) item.status = "structurally_ready_unprobed";
    } else {
      item.requiredVariables = [...new Set([
        ...(server.urlEnvironment === undefined ? [] : [server.urlEnvironment]),
        ...Object.values(server.headerEnvironment),
      ])];
      item.missingVariables = item.requiredVariables.filter((name) => !environment[name]?.trim());
      item.status = item.missingVariables.length === 0 ? "structurally_ready_unprobed" : "missing_variables";
    }
    return item;
  });
}
