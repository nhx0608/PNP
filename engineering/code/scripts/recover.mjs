import path from "node:path";
import { StateStore } from "../dist/storage/store.js";
import { LocalProcessHost } from "../dist/runtime/process-host.js";
import { acquireProcessLifetimeLock } from "../dist/runtime/instance-lock.js";
import { recoverOwnedState } from "../dist/runtime/recovery.js";
import { resolveDataDirectory } from "./lib.mjs";

const data = resolveDataDirectory();
const unlock = await acquireProcessLifetimeLock(data);
const store = new StateStore(path.join(data, "pnp.db"));
try {
  const summary = await recoverOwnedState(store, new LocalProcessHost(data), data);
  // recovery.ts reports per session, not one gateway-wide verdict (see
  // docs/engineering-review-2.md §9.8): a record this run could not verify only fences the one
  // session it names. `fencedSessions`/`issues` are the current shape; older builds only ever
  // returned counts, so both are handled without assuming the richer shape is there.
  const hasDetail = Array.isArray(summary.issues) && Array.isArray(summary.fencedSessions);
  const stillBlocked = hasDetail ? summary.fencedSessions.length : summary.blockedSessions;
  const recovered = hasDetail
    ? summary.fencedSessions.length === 0
    : summary.blockedSessions === 0 && summary.invalidRecords === 0 && summary.unverifiedRecords === 0;

  console.log(JSON.stringify({ recovered, ...summary }, null, 2));

  if (hasDetail && summary.issues.length > 0) {
    console.error(`\n${summary.issues.length} ownership record issue(s) found:`);
    for (const issue of summary.issues) {
      const where = issue.file ? issue.file : "(no record file)";
      const session = issue.sessionId ? ` session=${issue.sessionId}` : "";
      const detail = issue.detail ? ` — ${issue.detail}` : "";
      console.error(`  [${issue.reason}] ${where}${session}${detail}`);
    }
  }
  if (hasDetail && summary.fencedSessions.length > 0) {
    console.error(`\n${summary.fencedSessions.length} session(s) remain fenced (execution stop unproven): ${summary.fencedSessions.join(", ")}`);
    console.error("These stay blocked for prompt/execution until their stop is proven, or the session is deleted. They do not block any other session or engine.");
  }
  if (hasDetail && summary.clearedSessions.length > 0) {
    console.error(`\n${summary.clearedSessions.length} session(s) cleared: ${summary.clearedSessions.join(", ")}`);
  }
  if (!hasDetail && stillBlocked > 0) {
    console.error(`\n${stillBlocked} session(s) remain blocked; this build's recovery module does not report which file or why (see docs/engineering-review-2.md Q4/Q5).`);
  }

  if (!recovered) process.exitCode = 1;
} finally {
  await store.close();
  await unlock();
}
