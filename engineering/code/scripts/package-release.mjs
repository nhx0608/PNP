import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { codeRoot, engineeringRoot, npm } from "./lib.mjs";
import { computeSourceStamp } from "./source-stamp.mjs";

/**
 * Builds the competition submission shape - `solution/{INSTRUCTION.md, code/}` - in one of two
 * modes.
 *
 *   --bundle       the delivered package: source AND everything needed to run it with no network
 *                  at all (a pinned Node runtime, production dependencies, a prebuilt dist/, both
 *                  engines). This is what solution.zip is built from.
 *   --source-only  the historical source-only package (still the default so existing callers keep
 *                  working). It cannot start on a machine without a network.
 *
 * Everything under `engineering/` outside `code/` (the review documents, the spec, the prompts, the
 * verification evidence) is deliberately never touched: the copy list below is an allow-list, not a
 * deny-list, so nothing gets into the package by omission.
 */

const { values: args } = parseArgs({
  options: {
    "out": { type: "string" }, // default: code/dist/release (already gitignored, see code/.gitignore and the repo-root .gitignore)
    "include-tests": { type: "boolean", default: false },
    "bundle": { type: "boolean", default: false },
    "source-only": { type: "boolean", default: false },
    "zip": { type: "boolean", default: false },
    "cache-dir": { type: "string" },
    // Downloads the two engine tarballs and re-derives their SHA-256 instead of trusting
    // engines.lock.json. Off by default only because one of them is ~60 MB.
    "verify-tarballs": { type: "boolean", default: false },
  },
});

if (args.bundle && args["source-only"]) throw new Error("--bundle and --source-only are mutually exclusive.");
const bundle = args.bundle === true;

const outRoot = path.resolve(args.out ?? path.join(codeRoot, "dist", "release"));
const solutionDir = path.join(outRoot, "solution");
const releaseCodeDir = path.join(solutionDir, "code");
// Downloads and the production-dependency staging tree are reused across runs; runtime/ is
// gitignored, so nothing here can reach the repository.
const cacheDir = path.resolve(args["cache-dir"] ?? path.join(codeRoot, "runtime", "package-cache"));

// The pinned Windows runtime, byte-identical to what scripts/pnp-local.ps1 would download.
const NODE_RUNTIME = {
  version: "24.19.0",
  directory: "node-v24.19.0-win-x64",
  archive: "node-v24.19.0-win-x64.zip",
  sha256: "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73",
  url: "https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip",
};

/**
 * The engines the bundle carries, installed into exactly the directory the launcher probes
 * (runtime/bootstrap/engines/<id>/<version>) before it would reach for npm.
 *
 * `--ignore-scripts` is used for both, which is why opencode needs `expect`: its postinstall - the
 * step that would copy the platform binary over opencode-ai/bin/opencode.exe - does not run, so the
 * real executable only ever exists inside the platform package and the launcher must resolve it
 * there (see Resolve-NativeEngineExecutable in scripts/pnp-local.ps1).
 */
const BUNDLED_ENGINES = [
  {
    engineId: "opencode",
    version: "1.18.29",
    packageName: "opencode-ai",
    expect: ["node_modules/opencode-windows-x64/bin/opencode.exe"],
    // The AVX2-less fallback build is another ~180 MB of the same engine. It is left out of the
    // package and recorded as omitted rather than silently doubling the download.
    prune: ["node_modules/opencode-windows-x64-baseline"],
    platformTarball: "opencode-windows-x64",
  },
  {
    engineId: "pi",
    version: "0.85.1",
    packageName: "@earendil-works/pi-coding-agent",
    expect: ["node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"],
    prune: [],
  },
];

// Allow-listed top-level entries of code/ that make up a runnable delivery. `tests/` is opt-in via
// --include-tests: the requirements call for it excluded by default, with a switch.
const KEEP_DIRS = ["src", "native", "config", "scripts", "assets"];
// The launchers are what the specification's literal start command (`gateway --engine opencode
// --port 6217`) resolves to on a delivered package, and pnp.cmd is the entry point INSTRUCTION.md
// tells the assessor to run, so all of them ship.
const KEEP_FILES = ["package.json", "package-lock.json", "tsconfig.json", "toolchain.json", ".env.example", "README.md",
  "pnp.cmd", "gateway", "gateway.cmd", "gateway.ps1"];
if (args["include-tests"]) KEEP_DIRS.push("tests");

// Defense in depth even inside an allow-listed directory: a stray build artefact, database file,
// certificate or key must never ship even if someone left one under a kept directory by mistake.
// `runtime` is deliberately NOT in this set: it is a name matched at any depth, and src/runtime/
// is real source code (the process host, the instance lock, crash recovery). The operator's
// code/runtime/ directory is kept out by the allow-list above, which never copies it.
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

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(1)} ${units[unit]}`;
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
const BINARY_EXTENSION = /\.(png|jpg|jpeg|gif|ico|dll|exe|pdb|so|node|zip|gz|tgz|wasm|ttf|woff2?|mp4|pdf|docx|xlsx|pptx)$/i;
// Third-party trees the bundle intentionally carries. Their *content* is not ours to audit line by
// line (a 180 MB engine binary and ~1000 npm packages), but their file NAMES still are: a database,
// an env file or a private key has no business in any of them either.
const VENDOR_PREFIXES = ["code/node_modules/", "code/dist/", "code/runtime/bootstrap/"];
const MAX_SCANNED_BYTES = 2 * 1024 * 1024;

/**
 * Problems that must block a submission.
 *
 * In bundle mode the dependency directory, the build output and the bootstrap runtime are expected
 * contents rather than findings; what stays forbidden everywhere is operator state and credentials:
 * runtime/local.env, the data directory, databases, logs and private keys.
 */
function selfCheck(root) {
  const problems = [];
  for (const file of walk(root)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const name = path.basename(relative);
    const isVendored = VENDOR_PREFIXES.some((prefix) => relative.startsWith(prefix));

    if (name === "local.env" || (/^\.env(\..*)?$/i.test(name) && name !== ".env.example")) problems.push(`environment file present: ${relative}`);
    if (/\.(db|db-wal|db-shm|sqlite3?)$/i.test(name)) problems.push(`runtime database present: ${relative}`);
    if (/^code\/data\//.test(relative)) problems.push(`runtime data present: ${relative}`);
    if (/^code\/runtime\/(?!bootstrap\/)/.test(relative)) problems.push(`runtime state present: ${relative}`);
    if (/\.(pem|key|pfx|p12)$/i.test(name)) problems.push(`certificate/key material present: ${relative}`);
    if (/\.(log|pid)$/i.test(name)) problems.push(`log or pid file present: ${relative}`);
    if (!bundle) {
      if (/(^|\/)node_modules(\/|$)/.test(relative)) problems.push(`dependency directory present: ${relative}`);
      if (/(^|\/)dist(\/|$)/.test(relative)) problems.push(`build output present: ${relative}`);
    }

    if (isVendored || BINARY_EXTENSION.test(relative)) continue;
    let stats;
    try { stats = statSync(file); } catch { continue; }
    if (stats.size > MAX_SCANNED_BYTES) continue;
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const { label, pattern } of CREDENTIAL_PATTERNS) {
      if (pattern.test(text)) problems.push(`possible credential (${label}) in ${relative}`);
    }
  }
  return problems;
}

// --------------------------------------------------------------------------- bundle helpers

function run(command, commandArguments, options = {}) {
  const result = spawnSync(command, commandArguments, { stdio: "inherit", shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${commandArguments.join(" ")} failed with exit code ${result.status}.`);
}

function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  const cli = candidates.find((candidate) => candidate && existsSync(candidate) && candidate.endsWith(".js"));
  if (cli === undefined) throw new Error("npm CLI entrypoint not found; packaging needs npm.");
  return cli;
}

function runNpm(commandArguments, options = {}) {
  run(process.execPath, [npmCli(), ...commandArguments], options);
}

/** Downloads `url` into the cache once and verifies it against `expectedSha256` every time. */
async function fetchVerified(url, targetFile, expectedSha256) {
  mkdirSync(path.dirname(targetFile), { recursive: true });
  if (existsSync(targetFile) && sha256File(targetFile) === expectedSha256) {
    console.log(`(cached) ${path.basename(targetFile)}`);
    return targetFile;
  }
  console.log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed for ${url}: HTTP ${response.status}`);
  writeFileSync(targetFile, Buffer.from(await response.arrayBuffer()));
  const actual = sha256File(targetFile);
  if (actual !== expectedSha256) {
    rmSync(targetFile, { force: true });
    throw new Error(`SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${actual}.`);
  }
  return targetFile;
}

/**
 * Extracts a ZIP with the bundled `jszip` rather than an external tool, so packaging behaves the
 * same on the Windows machine that normally builds the submission and on a Linux CI runner.
 */
async function extractZip(archiveFile, destinationDir) {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(readFileSync(archiveFile));
  const entries = Object.values(zip.files);
  for (const entry of entries) {
    const target = path.join(destinationDir, entry.name);
    if (!path.resolve(target).startsWith(path.resolve(destinationDir))) throw new Error(`zip entry escapes the destination: ${entry.name}`);
    if (entry.dir) { mkdirSync(target, { recursive: true }); continue; }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, await entry.async("nodebuffer"));
    // Only meaningful when the package is inspected on a POSIX host; Windows ignores the bits.
    const mode = (entry.unixPermissions ?? 0) & 0o777;
    if (mode !== 0) { try { chmodSync(target, mode); } catch { /* Best effort. */ } }
  }
  return entries.length;
}

/** The SHA-256 of a published npm tarball, obtained with `npm pack` and cached. */
function tarballSha256(spec) {
  const packDir = path.join(cacheDir, "tarballs");
  mkdirSync(packDir, { recursive: true });
  const before = new Set(readdirSync(packDir));
  const result = spawnSync(process.execPath, [npmCli(), "pack", spec, "--pack-destination", packDir, "--loglevel", "error"], { encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`npm pack ${spec} failed: ${(result.stderr ?? "").trim()}`);
  const named = (result.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
  const file = existsSync(path.join(packDir, named))
    ? path.join(packDir, named)
    : path.join(packDir, readdirSync(packDir).find((entry) => !before.has(entry)) ?? "");
  if (!existsSync(file)) throw new Error(`npm pack ${spec} produced no tarball.`);
  return sha256File(file);
}

function readEngineLock() {
  const lockFile = path.join(codeRoot, "engines.lock.json");
  if (!existsSync(lockFile)) return [];
  return JSON.parse(readFileSync(lockFile, "utf8")).engines ?? [];
}

/** Byte size of a directory tree. */
function treeSize(root) {
  return walk(root).reduce((total, file) => total + statSync(file).size, 0);
}

// --------------------------------------------------------------------------- build

if (bundle) {
  console.log("building dist/ before packaging (the bundle ships a prebuilt gateway)");
  npm(["run", "build"]);
}

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

const manifestComponents = [];
const manifestNotes = [];

if (bundle) {
  const bootstrapDir = path.join(releaseCodeDir, "runtime", "bootstrap");
  const stateDir = path.join(bootstrapDir, "state");
  mkdirSync(stateDir, { recursive: true });

  // ---------------------------------------------------------------- prebuilt gateway
  const distSource = path.join(codeRoot, "dist");
  if (!existsSync(path.join(distSource, "main.js"))) throw new Error("dist/main.js is missing after the build step.");
  cpSync(distSource, path.join(releaseCodeDir, "dist"), {
    recursive: true,
    // dist/release is this script's own default output directory; it must never package itself.
    filter: (src) => path.relative(distSource, src).split(path.sep)[0] !== "release",
  });
  const sourceStamp = computeSourceStamp(codeRoot);
  // The stamp is what tells the delivered launcher "this dist/ matches this src/, do not rebuild",
  // so the packaged sources must be byte-identical to the ones just compiled. A copy filter that
  // silently drops a source directory (src/runtime/ was lost to exactly such a name filter once)
  // has to fail here rather than ship a package that recompiles - or refuses to - on the
  // assessor's machine.
  const packagedStamp = computeSourceStamp(releaseCodeDir);
  if (packagedStamp.stamp !== sourceStamp.stamp) {
    throw new Error(`packaged sources differ from the compiled ones (${packagedStamp.files} of ${sourceStamp.files} files, ${packagedStamp.stamp} != ${sourceStamp.stamp}); the copy allow-list dropped something.`);
  }
  writeFileSync(path.join(stateDir, "build.txt"), `source=${sourceStamp.stamp}\nsource-tool=scripts/source-stamp.mjs\n`, "utf8");
  console.log(`dist/ packaged; source stamp ${sourceStamp.stamp} over ${sourceStamp.files} files`);

  // ---------------------------------------------------------------- production dependencies
  const stagingDir = path.join(cacheDir, "production-dependencies");
  mkdirSync(stagingDir, { recursive: true });
  cpSync(path.join(codeRoot, "package.json"), path.join(stagingDir, "package.json"));
  cpSync(path.join(codeRoot, "package-lock.json"), path.join(stagingDir, "package-lock.json"));
  rmSync(path.join(stagingDir, "node_modules"), { recursive: true, force: true });
  console.log("installing production dependencies (npm ci --omit=dev) for win32-x64");
  runNpm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--os", "win32", "--cpu", "x64", "--loglevel", "error"], { cwd: stagingDir });
  cpSync(path.join(stagingDir, "node_modules"), path.join(releaseCodeDir, "node_modules"), { recursive: true });
  const lockHash = sha256File(path.join(codeRoot, "package-lock.json"));
  writeFileSync(path.join(stateDir, "project-dependencies.txt"),
    `lock=${lockHash}\nnode-major=${NODE_RUNTIME.version.split(".")[0]}\nscope=production\nsource=package-release\n`, "utf8");
  manifestComponents.push({
    component: "dependencies",
    version: JSON.parse(readFileSync(path.join(codeRoot, "package.json"), "utf8")).version ?? "0.0.0",
    artifact: "npm ci --omit=dev --os win32 --cpu x64",
    sha256: lockHash,
    sha256Of: "package-lock.json",
    path: "node_modules",
  });

  // ---------------------------------------------------------------- pinned Node runtime
  const nodeArchive = await fetchVerified(NODE_RUNTIME.url, path.join(cacheDir, "downloads", NODE_RUNTIME.archive), NODE_RUNTIME.sha256);
  console.log(`extracting ${NODE_RUNTIME.archive}`);
  const extracted = await extractZip(nodeArchive, bootstrapDir);
  const nodeExe = path.join(bootstrapDir, NODE_RUNTIME.directory, "node.exe");
  if (!existsSync(nodeExe)) throw new Error(`the Node archive did not produce ${path.relative(releaseCodeDir, nodeExe)}.`);
  console.log(`node runtime extracted (${extracted} entries)`);
  manifestComponents.push({
    component: "node-runtime",
    version: NODE_RUNTIME.version,
    artifact: NODE_RUNTIME.archive,
    url: NODE_RUNTIME.url,
    sha256: NODE_RUNTIME.sha256,
    verified: true,
    path: `runtime/bootstrap/${NODE_RUNTIME.directory}`,
  });

  // ---------------------------------------------------------------- engines
  const lockEntries = readEngineLock();
  for (const engine of BUNDLED_ENGINES) {
    const locked = lockEntries.find((entry) => entry.engineId === engine.engineId);
    if (locked !== undefined && locked.version !== engine.version) {
      throw new Error(`engines.lock.json pins ${engine.engineId} at ${locked.version} but this packager installs ${engine.version}.`);
    }
    const engineHome = path.join(bootstrapDir, "engines", engine.engineId, engine.version);
    mkdirSync(engineHome, { recursive: true });
    console.log(`installing ${engine.packageName}@${engine.version} into runtime/bootstrap/engines/${engine.engineId}/${engine.version}`);
    runNpm(["install", "--prefix", engineHome, "--no-save", "--package-lock=false", "--ignore-scripts",
      "--no-audit", "--no-fund", "--os", "win32", "--cpu", "x64", "--loglevel", "error", `${engine.packageName}@${engine.version}`]);
    for (const relative of engine.expect) {
      if (!existsSync(path.join(engineHome, relative))) {
        throw new Error(`${engine.packageName}@${engine.version} did not produce ${relative}; the launcher would not find the engine.`);
      }
    }
    for (const relative of engine.prune) {
      const target = path.join(engineHome, relative);
      if (!existsSync(target)) continue;
      const saved = treeSize(target);
      rmSync(target, { recursive: true, force: true });
      manifestNotes.push(`${relative.split("/").pop()} was removed from the ${engine.engineId} install (${humanSize(saved)}); install it with npm if the target CPU has no AVX2.`);
    }
    // Both top-level engine tarballs are small (opencode-ai is a few kilobytes, pi about 7 MB), so
    // their SHA-256 is always re-derived here rather than copied out of the lock file.
    const packageSha = tarballSha256(`${engine.packageName}@${engine.version}`);
    manifestComponents.push({
      component: `engine:${engine.engineId}`,
      version: engine.version,
      artifact: `npm:${engine.packageName}@${engine.version}`,
      sha256: packageSha,
      sha256Of: "published npm tarball",
      path: `runtime/bootstrap/engines/${engine.engineId}/${engine.version}`,
    });
    if (engine.platformTarball !== undefined) {
      const platformSpec = `${engine.platformTarball}@${engine.version}`;
      const lockedPlatform = lockEntries.find((entry) => entry.source === `npm:${platformSpec}`);
      const platformSha = args["verify-tarballs"] || lockedPlatform === undefined ? tarballSha256(platformSpec) : lockedPlatform.sha256;
      if (lockedPlatform !== undefined && args["verify-tarballs"] && platformSha !== lockedPlatform.sha256) {
        throw new Error(`${platformSpec} tarball SHA-256 ${platformSha} does not match engines.lock.json (${lockedPlatform.sha256}).`);
      }
      manifestComponents.push({
        component: `engine:${engine.engineId}:platform-binary`,
        version: engine.version,
        artifact: `npm:${platformSpec}`,
        sha256: platformSha,
        sha256Of: "published npm tarball",
        sha256Source: args["verify-tarballs"] || lockedPlatform === undefined ? "npm pack" : "engines.lock.json",
        path: `runtime/bootstrap/engines/${engine.engineId}/${engine.version}/node_modules/${engine.platformTarball}`,
      });
    }
    if (locked !== undefined) {
      const observed = manifestComponents.find((component) => component.component === `engine:${engine.engineId}`);
      if (locked.source === `npm:${engine.packageName}@${engine.version}` && observed !== undefined && observed.sha256 !== locked.sha256) {
        throw new Error(`${engine.packageName}@${engine.version} tarball SHA-256 ${observed.sha256} does not match engines.lock.json (${locked.sha256}).`);
      }
    }
  }

  const manifest = {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    target: "win32-x64",
    offline: true,
    components: manifestComponents,
    stamps: {
      "runtime/bootstrap/state/build.txt": "sha256 over the sorted src/** and tsconfig.json contents; scripts/source-stamp.mjs recomputes it",
      "runtime/bootstrap/state/project-dependencies.txt": "sha256 of package-lock.json plus the Node major version the tree was installed for",
    },
    notes: manifestNotes,
  };
  writeFileSync(path.join(releaseCodeDir, "BUNDLE-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

// --------------------------------------------------------------------------- verify and report

const problems = selfCheck(solutionDir);
const files = walk(solutionDir);
const totalBytes = files.reduce((total, file) => total + statSync(file).size, 0);

let archive;
if (args.zip) {
  const zipPath = path.join(outRoot, "solution.zip");
  rmSync(zipPath, { force: true });
  if (process.platform === "win32") {
    run("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      `Compress-Archive -Path '${solutionDir}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`]);
  } else {
    const zipBinary = spawnSync("zip", ["--version"], { stdio: "ignore", shell: false });
    if (zipBinary.status !== 0) {
      console.error("--zip needs the `zip` binary on this platform and it is not installed; the solution/ directory above is complete, archive it yourself.");
    } else {
      run("zip", ["-r", "-q", "-X", zipPath, "solution"], { cwd: outRoot });
    }
  }
  if (existsSync(zipPath)) archive = { path: zipPath, bytes: statSync(zipPath).size };
}

console.log(JSON.stringify({
  mode: bundle ? "bundle" : "source-only",
  out: outRoot,
  fileCount: files.length,
  bytes: totalBytes,
  size: humanSize(totalBytes),
  archive: archive === undefined ? null : { path: archive.path, size: humanSize(archive.bytes) },
  components: bundle ? manifestComponents.map((component) => `${component.component} ${component.version}`) : undefined,
  selfCheck: problems.length ? problems : "clean",
}, null, 2));

if (problems.length) {
  console.error(`\npackage-release: self-check found ${problems.length} problem(s); the package above still contains them, review before submitting.`);
  process.exitCode = 1;
}
