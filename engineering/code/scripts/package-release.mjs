import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { codeRoot, engineeringRoot } from "./lib.mjs";

/**
 * Builds the competition submission shape — `solution/{INSTRUCTION.md, code/}` — that the
 * requirements document calls for and that, until now, no script produced (see
 * docs/engineering-review-2.md §5). Everything under `engineering/` outside `code/` (the review
 * documents, the spec, the prompts, the verification evidence) is deliberately never touched: the
 * copy list below is an allow-list, not a deny-list, so nothing gets into the package by omission.
 */

const { values: args } = parseArgs({
  options: {
    "out": { type: "string" }, // default: code/dist/release (already gitignored, see code/.gitignore and the repo-root .gitignore)
    "include-tests": { type: "boolean", default: false },
  },
});

const outRoot = path.resolve(args.out ?? path.join(codeRoot, "dist", "release"));
const solutionDir = path.join(outRoot, "solution");
const releaseCodeDir = path.join(solutionDir, "code");

// Allow-listed top-level entries of code/ that make up a runnable, source-only delivery. `tests/`
// is opt-in via --include-tests: the requirements call for it excluded by default, with a switch
// (see the task's packaging item).
const KEEP_DIRS = ["src", "native", "config", "scripts", "assets"];
const KEEP_FILES = ["package.json", "package-lock.json", "tsconfig.json", "toolchain.json", ".env.example", "README.md"];
if (args["include-tests"]) KEEP_DIRS.push("tests");

// Defense in depth even inside an allow-listed directory: a stray build artefact, database file,
// certificate or key must never ship even if someone left one under a kept directory by mistake.
const EXCLUDE_NAMES = new Set(["node_modules", "dist", "data", ".git", ".DS_Store"]);
const EXCLUDE_FILE_PATTERN = /\.(db|db-wal|db-shm|sqlite|sqlite3|pem|key|pfx|p12|log|pid)$|^\.env(\..*)?$/i;

function shouldExclude(entryName, isDirectory) {
  if (EXCLUDE_NAMES.has(entryName)) return true;
  if (!isDirectory && entryName !== ".env.example" && EXCLUDE_FILE_PATTERN.test(entryName)) return true;
  return false;
}

function copyFiltered(sourceDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  cpSync(sourceDir, destDir, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      const isDirectory = (() => { try { return statSync(src).isDirectory(); } catch { return false; } })();
      return !shouldExclude(name, isDirectory);
    },
  });
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const CREDENTIAL_PATTERNS = [
  { label: "PEM private key block", pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { label: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "OpenAI-style secret key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "inline password literal", pattern: /\bpassword\s*[:=]\s*["'][^"'\s]{4,}["']/i },
  // Word-bounded on purpose: an unbounded "token" also matches identifiers like `ownerToken`,
  // which is a parameter name carrying a same-file placeholder value, not a credential.
  { label: "inline secret/token/api-key literal", pattern: /\b(api[_-]?key|secret|token)\b\s*[:=]\s*["'][A-Za-z0-9_\-]{12,}["']/i },
];
const BINARY_EXTENSION = /\.(png|jpg|jpeg|gif|ico|dll|exe|pdb|so|node|zip|gz|tgz)$/i;

function selfCheck(root) {
  const files = walk(root);
  const problems = [];
  for (const file of files) {
    const relative = path.relative(root, file);
    if (/(^|\/)node_modules(\/|$)/.test(relative)) problems.push(`dependency directory present: ${relative}`);
    if (/(^|\/)dist(\/|$)/.test(relative)) problems.push(`build output present: ${relative}`);
    if (/(^|\/)data(\/|$)/.test(relative) || /\.(db|db-wal|db-shm|sqlite3?)$/i.test(relative)) problems.push(`runtime data present: ${relative}`);
    if (/\.(pem|key|pfx|p12)$/i.test(relative)) problems.push(`certificate/key material present: ${relative}`);
    if (BINARY_EXTENSION.test(relative)) continue;
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const { label, pattern } of CREDENTIAL_PATTERNS) {
      if (pattern.test(text)) problems.push(`possible credential (${label}) in ${relative}`);
    }
  }
  return problems;
}

// --- build ---
rmSync(outRoot, { recursive: true, force: true });
mkdirSync(releaseCodeDir, { recursive: true });

for (const dirName of KEEP_DIRS) {
  const source = path.join(codeRoot, dirName);
  if (!existsSync(source)) { console.log(`(skip) code/${dirName}/ does not exist in this checkout.`); continue; }
  copyFiltered(source, path.join(releaseCodeDir, dirName));
}
for (const fileName of KEEP_FILES) {
  const source = path.join(codeRoot, fileName);
  if (!existsSync(source)) { console.log(`(skip) code/${fileName} does not exist in this checkout.`); continue; }
  mkdirSync(releaseCodeDir, { recursive: true });
  cpSync(source, path.join(releaseCodeDir, fileName));
}

const instructionSource = path.join(engineeringRoot, "INSTRUCTION.md");
if (!existsSync(instructionSource)) throw new Error("engineering/INSTRUCTION.md is missing; cannot build solution/INSTRUCTION.md.");
mkdirSync(solutionDir, { recursive: true });
cpSync(instructionSource, path.join(solutionDir, "INSTRUCTION.md"));

const problems = selfCheck(solutionDir);
const manifest = walk(solutionDir).map((file) => path.relative(outRoot, file)).sort((a, b) => a.localeCompare(b));

console.log(JSON.stringify({ out: outRoot, fileCount: manifest.length, selfCheck: problems.length ? problems : "clean", manifest }, null, 2));
if (problems.length) {
  console.error(`\npackage-release: self-check found ${problems.length} problem(s); the package above still contains them, review before submitting.`);
  process.exitCode = 1;
}
