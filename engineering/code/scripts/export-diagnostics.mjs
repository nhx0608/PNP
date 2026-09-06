import path from "node:path";
import { StateStore } from "../dist/storage/store.js";
import { Redactor } from "../dist/security/redaction.js";
import { resolveDataDirectory } from "./lib.mjs";

// Run only while this operator owns the data directory. No environment dump is produced.
const store = new StateStore(path.join(resolveDataDirectory(), "pnp.db"));
try {
  const stats = await store.call("diagnostics", null);
  const redactor = new Redactor();
  console.log(JSON.stringify(redactor.json({ runtime: { node: process.versions.node, platform: process.platform }, stats }), null, 2));
} finally { await store.close(); }
