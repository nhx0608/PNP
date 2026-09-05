import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { StateStore } from "./storage/store.ts";
import { GatewayCore } from "./core/gateway-core.ts";
import { buildApp } from "./gateway/app.ts";
import { loadEngine, selectEngine } from "./registry/index.ts";
import { MockIntegration } from "./integration/mock/provider.ts";
import { InternalIntegration } from "./integration/internal/provider.ts";
import { acquireInstanceLock } from "./runtime/instance-lock.ts";
import { PnpError } from "./core/errors.ts";

const args = parseArgs({ options: { engine: { type: "string" }, port: { type: "string" }, host: { type: "string" } } });
const engineId = selectEngine(args.values.engine, process.env.AGENT_ENGINE);
const development = process.env.PNP_MODE === "development";
const engine = await loadEngine(engineId, development);
const host = args.values.host ?? process.env.PNP_HOST ?? "127.0.0.1";
if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new PnpError("UNSUPPORTED_BIND_ADDRESS", "This gateway exposes local assessment APIs only.", 400);
const port = Number(args.values.port ?? process.env.PNP_PORT ?? 6217);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PnpError("VALIDATION_ERROR", "Invalid port.", 400);
const data = path.resolve(process.env.PNP_DATA_DIR ?? "data");
await mkdir(data, { recursive: true });
const unlock = await acquireInstanceLock(path.join(data, "gateway.lock"));
const store = new StateStore(path.join(data, "pnp.db"));
const provider = engine.descriptor.developmentOnly ? new MockIntegration() : new InternalIntegration();
const core = new GatewayCore(store, engine, provider, { dataDirectory: data });
const app = buildApp(core);
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  let clean = false;
  try { await app.close(); clean = true; }
  finally { await store.close(); if (clean) await unlock(); else process.exitCode = 1; }
};
process.once("SIGINT", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
process.once("SIGTERM", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
try { await core.initialize(); await app.listen({ host, port }); }
catch (error) { await shutdown().catch(() => undefined); throw error; }
