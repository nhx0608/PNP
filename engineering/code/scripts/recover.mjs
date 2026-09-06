import path from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore } from "../dist/storage/store.js";
import { LocalProcessHost } from "../dist/runtime/process-host.js";
import { acquireProcessLifetimeLock } from "../dist/runtime/instance-lock.js";
import { recoverOwnedState } from "../dist/runtime/recovery.js";

const codeRoot = fileURLToPath(new URL("../", import.meta.url));
const data = path.resolve(process.env.PNP_DATA_DIR ?? path.join(codeRoot, "data"));
const unlock = await acquireProcessLifetimeLock(data);
const store = new StateStore(path.join(data, "pnp.db"));
try {
  const summary = await recoverOwnedState(store, new LocalProcessHost(data), data);
  console.log(JSON.stringify({ recovered: summary.blockedSessions === 0 && summary.invalidRecords === 0 && summary.unverifiedRecords === 0, ...summary }));
  if (summary.blockedSessions > 0 || summary.invalidRecords > 0 || summary.unverifiedRecords > 0) process.exitCode = 1;
} finally {
  await store.close();
  await unlock();
}
