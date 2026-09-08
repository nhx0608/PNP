import { readFile } from "node:fs/promises";
import path from "node:path";
import { CODE_ROOT, resolveCodePath } from "./settings.ts";
import { PnpError } from "../core/errors.ts";

/** The delivery's own env file. `runtime/` is not packaged and not committed, so this path exists
 *  only on a machine where an operator created it. */
export const DEFAULT_LOCAL_ENV_FILE = path.join(CODE_ROOT, "runtime", "local.env");

function fileOf(explicit: string | undefined): string {
  if (explicit === undefined || explicit.trim() === "") return DEFAULT_LOCAL_ENV_FILE;
  return resolveCodePath(explicit.trim());
}
/** One layer of matching quotes, the way the PowerShell launcher reads the same file, so both
 *  entry points give a value with spaces the same meaning. */
function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  if ((first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1);
  return value;
}

/**
 * Loads `code/runtime/local.env` (or whatever `PNP_LOCAL_ENV_FILE` names) into the process
 * environment before anything reads a setting. `gateway.cmd`, `npm start` and `pnp.cmd` then see
 * the same environment: the launcher used to be the only route that loaded this file, so a gateway
 * started any other way silently ran without the deployment's model configuration.
 *
 * A variable the environment already carries WINS: an operator who exported one for a single run
 * must not be overruled by a file, and the launcher — which loads the same file first to reach the
 * mirror variables — must not have its work undone here.
 *
 * The file holds credentials, so nothing about a value is ever printed: the result is the list of
 * names that were applied, and a malformed line is reported by line number only.
 */
export async function loadLocalEnvironment(input: {
  environment?: NodeJS.ProcessEnv;
  file?: string;
} = {}): Promise<{ file: string; present: boolean; names: string[] }> {
  const environment = input.environment ?? process.env;
  const file = fileOf(input.file ?? environment.PNP_LOCAL_ENV_FILE);
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    // No file is the normal case for a deployment that exports its variables another way. A file
    // that exists but cannot be read is a deployment error and is reported by name.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { file, present: false, names: [] };
    throw new PnpError("VALIDATION_ERROR", "The local environment file could not be read.", 400);
  }
  const names: string[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new PnpError("VALIDATION_ERROR", `The local environment file has an invalid line at ${index + 1}; expected NAME=VALUE.`, 400);
    }
    const name = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new PnpError("VALIDATION_ERROR", `The local environment file has an invalid variable name at line ${index + 1}.`, 400);
    }
    // An exported-but-empty variable is unset here, the same way an empty AGENT_ENGINE is: a wrapper
    // that exports a name without a value must not shadow the file the operator filled in.
    if ((environment[name] ?? "") !== "") continue;
    environment[name] = unquote(line.slice(separator + 1).trim());
    names.push(name);
  }
  return { file, present: true, names };
}
