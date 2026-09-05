import { readFile, readdir, unlink, open } from "node:fs/promises";
import path from "node:path";
import { StateStore } from "../dist/storage/store.js";
import { LocalProcessHost } from "../dist/runtime/process-host.js";
const data = path.resolve(process.env.PNP_DATA_DIR ?? "data");
const lockPath = path.join(data, "gateway.lock");
const recoveryPath = path.join(data, "recovery.lock");
const guard = await open(recoveryPath, "wx");
let store;
try {
  const raw = await readFile(lockPath, "utf8");
  const owner = JSON.parse(raw);
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("Invalid ownership record.");
  try { process.kill(owner.pid, 0); throw new Error("Recorded owner is still alive; recovery is refused."); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
  const host = new LocalProcessHost(data);
  let files = [];
  try { files = await readdir(path.join(data, "hosts")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const record = JSON.parse(await readFile(path.join(data, "hosts", file), "utf8"));
    // Every retained host record must be quiescent; an older owner is not a reason to ignore it.
    if (!(await host.reconcile(record)).quiescent) throw new Error("Owned process state is unverified. No force-unlock is provided.");
  }
  store = new StateStore(path.join(data, "pnp.db"));
  await store.call("recover", null);
  for (const session of await store.call("listSessions", null)) {
    if (session.recovery === "blocked") await store.call("confirmStopped", { sessionId: session.id });
  }
  await store.close(); store = undefined;
  if (await readFile(lockPath, "utf8") !== raw) throw new Error("Ownership record changed during recovery.");
  await unlink(lockPath);
  console.log("Owned execution is quiescent. Interrupted runs remain interrupted and are not replayed.");
} finally {
  if (store) await store.close();
  await guard.close(); await unlink(recoveryPath);
}
