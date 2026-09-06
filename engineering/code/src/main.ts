#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { StateStore } from "./storage/store.ts";
import { GatewayCore } from "./core/gateway-core.ts";
import { buildApp } from "./gateway/app.ts";
import { loadEngine, selectEngine } from "./registry/index.ts";
import { loadIntegration, probeIntegration } from "./integration/index.ts";
import { acquireProcessLifetimeLock } from "./runtime/instance-lock.ts";
import { LocalProcessHost } from "./runtime/process-host.ts";
import { recoverOwnedState } from "./runtime/recovery.ts";
import { bounded } from "./runtime/deadline.ts";
import { PnpError, asPnpError } from "./core/errors.ts";

/** An unset variable and an empty one mean the same thing: use the default, never refuse to start. */
function duration(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new PnpError("VALIDATION_ERROR", `Invalid ${name}.`, 400);
  }
  return value;
}

const args = parseArgs({ options: { engine: { type: "string" }, port: { type: "string" }, host: { type: "string" } } });
const engineId = selectEngine(args.values.engine, process.env.AGENT_ENGINE);
const development = process.env.PNP_MODE === "development";
const engine = await loadEngine(engineId, development);
// The specification's default is `localhost`, and Fastify 5 resolves it to BOTH loopback families
// (127.0.0.1 and ::1). Defaulting to 127.0.0.1 instead left a client that resolves localhost to
// ::1 first — the Windows default — depending on its own address fallback. The allowed set is
// unchanged: loopback only.
const host = args.values.host ?? process.env.PNP_HOST ?? "localhost";
if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new PnpError("UNSUPPORTED_BIND_ADDRESS", "This gateway exposes local assessment APIs only.", 400);
const port = Number(args.values.port ?? process.env.PNP_PORT ?? 6217);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PnpError("VALIDATION_ERROR", "Invalid port.", 400);
const provider = await loadIntegration({ kind: process.env.PNP_INTEGRATION, development,
  engineDevelopmentOnly: engine.descriptor.developmentOnly, configuredProfile: process.env.PNP_CONFIGURED_PROFILE });
// The profile names its endpoint and credentials by environment variable. A variable the profile
// names but the environment does not set is a deployment error, and it belongs at startup with the
// variable's name in the message — not at the first prompt of the first case.
await probeIntegration(provider);
const capacity = duration("PNP_MAX_RESIDENT_SESSIONS", 16, 1, 64);
const runTimeoutMs = duration("PNP_RUN_TIMEOUT_MS", 900_000, 1_000, 86_400_000);
const openTimeoutMs = duration("PNP_OPEN_TIMEOUT_MS", 60_000, 1_000, 600_000);
const cancelGraceMs = duration("PNP_CANCEL_GRACE_MS", 15_000, 100, 300_000);
const interactionTimeoutMs = duration("PNP_INTERACTION_TIMEOUT_MS", 45_000, 1_000, 600_000);
const data = path.resolve(process.env.PNP_DATA_DIR ?? "data");
await mkdir(data, { recursive: true });
const unlock = await acquireProcessLifetimeLock(data);
let store: StateStore | undefined;
let app: ReturnType<typeof buildApp> | undefined;
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  try { if (app !== undefined) await app.close(); }
  catch (error) {
    // Uncertainty belongs in the database (`recovery=blocked`) and in the exit code. A retained lock
    // file would only stop the next start, which is not what an unverified stop needs to express.
    process.exitCode = 1;
    console.error(JSON.stringify({ event: "shutdown.unverified", code: asPnpError(error).code }));
  } finally {
    try { if (store !== undefined) await store.close(); }
    catch (error) {
      process.exitCode = 1;
      console.error(JSON.stringify({ event: "storage.close.failed", code: asPnpError(error).code }));
    } finally { await unlock(); }
  }
};
try {
  const state = new StateStore(path.join(data, "pnp.db"));
  store = state;
  const processHost = new LocalProcessHost(data);
  const core = new GatewayCore(state, engine, provider, {
    dataDirectory: data, maxResidentSessions: capacity, processHost,
    runTimeoutMs, openTimeoutMs, cancelGraceMs, interactionTimeoutMs,
  });
  app = buildApp(core);
  process.once("SIGINT", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  process.once("SIGTERM", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  await core.initialize();
  await app.listen({ host, port });
  // Only two facts prove that continuing would corrupt data: another live owner of this data
  // directory, and storage that cannot be opened. Both are already settled above. Ownership
  // verification is therefore not a start gate: it runs after the port is listening, it is bounded
  // so a slow compilation cannot hold up the health check, and its result narrows to the sessions
  // it names. Sessions created while it runs are untouched by it.
  // The task settles every outcome itself, so nothing is left unobserved.
  void (async () => {
    try { core.applyRecovery(await bounded(recoverOwnedState(state, processHost, data), 20_000)); }
    catch (error) { core.noteRecoveryFailure(asPnpError(error).code); }
  })();
}
catch (error) { await shutdown().catch(() => undefined); throw error; }
