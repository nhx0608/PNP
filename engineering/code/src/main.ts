import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { StateStore } from "./storage/store.ts";
import { GatewayCore } from "./core/gateway-core.ts";
import { buildApp } from "./gateway/app.ts";
import { loadEngine, selectEngine } from "./registry/index.ts";
import { loadIntegration } from "./integration/index.ts";
import { acquireProcessLifetimeLock } from "./runtime/instance-lock.ts";
import { LocalProcessHost } from "./runtime/process-host.ts";
import { recoverOwnedState } from "./runtime/recovery.ts";
import { PnpError } from "./core/errors.ts";

const args = parseArgs({ options: { engine: { type: "string" }, port: { type: "string" }, host: { type: "string" } } });
const engineId = selectEngine(args.values.engine, process.env.AGENT_ENGINE);
const development = process.env.PNP_MODE === "development";
const engine = await loadEngine(engineId, development);
const host = args.values.host ?? process.env.PNP_HOST ?? "127.0.0.1";
if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new PnpError("UNSUPPORTED_BIND_ADDRESS", "This gateway exposes local assessment APIs only.", 400);
const port = Number(args.values.port ?? process.env.PNP_PORT ?? 6217);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PnpError("VALIDATION_ERROR", "Invalid port.", 400);
const provider = await loadIntegration({ kind: process.env.PNP_INTEGRATION, development,
  engineDevelopmentOnly: engine.descriptor.developmentOnly, configuredProfile: process.env.PNP_CONFIGURED_PROFILE });
const capacity = Number(process.env.PNP_MAX_RESIDENT_SESSIONS ?? 8);
if (!Number.isInteger(capacity) || capacity < 1 || capacity > 64) throw new PnpError("VALIDATION_ERROR", "Invalid resident session capacity.", 400);
const data = path.resolve(process.env.PNP_DATA_DIR ?? "data");
await mkdir(data, { recursive: true });
const unlock = await acquireProcessLifetimeLock(data);
let store: StateStore | undefined;
let app: ReturnType<typeof buildApp> | undefined;
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  let clean = false;
  try { if (app !== undefined) await app.close(); clean = true; }
  finally { if (store !== undefined) await store.close(); if (clean) await unlock(); else process.exitCode = 1; }
};
try {
  store = new StateStore(path.join(data, "pnp.db"));
  const processHost = new LocalProcessHost(data);
  const recovery = await recoverOwnedState(store, processHost, data);
  if (recovery.invalidRecords > 0 || recovery.unverifiedRecords > 0) {
    throw new PnpError("RECOVERY_EVIDENCE_INVALID", "Owned process records require operator inspection.", 503);
  }
  const core = new GatewayCore(store, engine, provider, { dataDirectory: data, maxResidentSessions: capacity, processHost });
  app = buildApp(core);
  process.once("SIGINT", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  process.once("SIGTERM", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  await core.initialize();
  await app.listen({ host, port });
}
catch (error) { await shutdown().catch(() => undefined); throw error; }
