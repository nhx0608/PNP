import { npm } from "./lib.mjs";
// Run in an approved network. This creates a real lockfile; no synthetic lock is accepted.
npm(["install", "--package-lock-only", "--ignore-scripts"]);
npm(["ci", "--ignore-scripts"]);
npm(["run", "foundation:check"]);
