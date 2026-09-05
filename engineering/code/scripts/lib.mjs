import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
export function npm(args) {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")];
  const cli = candidates.find((p) => p && existsSync(p));
  if (!cli) throw new Error("npm CLI entrypoint not found.");
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit", shell: false });
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} failed.`);
}
