import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOpenCodeExecutable, type ExecutableEnvironment } from "../../../src/engines/opencode/executable.ts";
import { loadOpenCodeEngineConfig, parseOpenCodeEngineConfig, type OpenCodeEngineConfig } from "../../../src/engines/opencode/config.ts";

const APPDATA = "C:\\Users\\svc\\AppData\\Roaming";
const LOCALAPPDATA = "C:\\Users\\svc\\AppData\\Local";
const PROGRAM_FILES = "C:\\Program Files";
const WINDOWS_ENV = { APPDATA, LOCALAPPDATA, ProgramFiles: PROGRAM_FILES };

function config(overrides: Partial<OpenCodeEngineConfig["executable"]> = {}): OpenCodeEngineConfig {
  return parseOpenCodeEngineConfig({
    id: "opencode", channel: "acp", implementationEntry: "src/engines/opencode/pack.ts",
    engineVersion: "1.18.27", engineVersionLocked: true, protocolVersion: 1,
    distribution: { kind: "npm-global-native-binary", packageNameCandidates: ["opencode-ai"], windowsNativeSupport: "supported-not-recommended" },
    acp: { subcommandArgs: ["acp"] },
    executable: {
      kindEnvironmentVariable: "PNP_OPENCODE_EXECUTABLE_KIND", defaultKind: "exe",
      exe: {
        configuredPath: null, environmentVariable: "PNP_OPENCODE_EXE_PATH",
        wellKnownPaths: ["${APPDATA}\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe"],
      },
      node: { configuredPath: null, environmentVariable: "PNP_OPENCODE_NODE_PATH", wellKnownPaths: ["${ProgramFiles}\\nodejs\\node.exe"], fallbackToHostRuntime: true },
      script: { configuredPath: null, environmentVariable: "PNP_OPENCODE_SCRIPT_PATH", wellKnownPaths: [] },
      ...overrides,
    },
    redirect: { variables: { HOME: "home" } },
    model: { policy: "launch" },
    headerEnvironmentPrefix: "PNP_OPENCODE_HEADER_",
    timeouts: { requestMs: 30000, cancelGraceMs: 2000, cancelAckMs: 1000 },
    capabilityEvidence: "probed",
  });
}
function environment(overrides: Partial<ExecutableEnvironment> = {}): ExecutableEnvironment {
  return {
    env: {}, hostRuntimePath: "C:\\Program Files\\nodejs\\node.exe", platform: "win32", fileExists: async () => false,
    ...overrides,
  };
}

// --- A. exe is the default mode, because the real distribution ships an executable and no script -------------

test("exe is the shipped default: no PNP_OPENCODE_EXECUTABLE_KIND is needed to resolve the installed .exe", async () => {
  const resolved = await resolveOpenCodeExecutable(config(), environment({
    env: WINDOWS_ENV,
    fileExists: async (candidate) => candidate === `${APPDATA}\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe`,
  }));
  assert.equal(resolved.kind, "exe");
  assert.equal(resolved.executable, `${APPDATA}\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe`);
  assert.deepEqual(resolved.prefixArgs, [], "exe mode passes the ACP subcommand alone: there is no script argument");
  assert.equal(resolved.executableEvidence, "well-known-probe");
});

test("exe mode: configuredPath beats the environment variable, which beats well-known probing", async () => {
  const configured = await resolveOpenCodeExecutable(
    config({ exe: { configuredPath: "C:\\Custom\\opencode.exe", environmentVariable: "PNP_OPENCODE_EXE_PATH", wellKnownPaths: [] } }),
    environment({ env: { ...WINDOWS_ENV, PNP_OPENCODE_EXE_PATH: "C:\\Env\\opencode.exe" }, fileExists: async () => true }),
  );
  assert.equal(configured.executable, "C:\\Custom\\opencode.exe");
  assert.equal(configured.executableEvidence, "configured");

  const fromEnv = await resolveOpenCodeExecutable(config(), environment({
    env: { ...WINDOWS_ENV, PNP_OPENCODE_EXE_PATH: "C:\\Env\\opencode.exe" }, fileExists: async () => true,
  }));
  assert.equal(fromEnv.executable, "C:\\Env\\opencode.exe");
  assert.equal(fromEnv.executableEvidence, "environment");
});

test("the shipped config probes every real install location, in order, with ${APPDATA} expanded", async () => {
  const shipped = await loadOpenCodeEngineConfig();
  assert.equal(shipped.executable.defaultKind, "exe");
  const expected = [
    `${APPDATA}\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe`,
    `${APPDATA}\\npm\\node_modules\\opencode-windows-x64\\bin\\opencode.exe`,
    `${APPDATA}\\npm\\node_modules\\opencode-windows-x64-baseline\\bin\\opencode.exe`,
    `${PROGRAM_FILES}\\nodejs\\node_modules\\opencode-ai\\bin\\opencode.exe`,
    `${LOCALAPPDATA}\\Programs\\opencode\\opencode.exe`,
  ];
  const probed: string[] = [];
  await assert.rejects(
    resolveOpenCodeExecutable(shipped, environment({
      env: WINDOWS_ENV,
      fileExists: async (candidate) => { probed.push(candidate); return false; },
    })),
    { code: "ENGINE_EXECUTABLE_NOT_FOUND" },
  );
  assert.deepEqual(probed, expected, "every documented install location is probed, in the configured order");

  // Each location on its own is enough: whichever one exists is the one that gets launched.
  for (const target of expected) {
    const resolved = await resolveOpenCodeExecutable(shipped, environment({
      env: WINDOWS_ENV, fileExists: async (candidate) => candidate === target,
    }));
    assert.equal(resolved.executable, target);
    assert.equal(resolved.kind, "exe");
  }
});

test("a well-known template whose ${VAR} is unset is skipped, never probed as a root-relative path", async () => {
  const shipped = await loadOpenCodeEngineConfig();
  const probed: string[] = [];
  await assert.rejects(
    resolveOpenCodeExecutable(shipped, environment({
      env: { ProgramFiles: PROGRAM_FILES }, // no APPDATA, no LOCALAPPDATA: a Linux host, or a stripped service account
      fileExists: async (candidate) => { probed.push(candidate); return false; },
    })),
    { code: "ENGINE_EXECUTABLE_NOT_FOUND" },
  );
  assert.deepEqual(probed, [`${PROGRAM_FILES}\\nodejs\\node_modules\\opencode-ai\\bin\\opencode.exe`]);
  for (const candidate of probed) assert.doesNotMatch(candidate, /^\\/, "an unexpanded token must not leave a root-relative probe");
});

// --- B. platform-aware path validation ------------------------------------------------------------------------

test("on Windows the resolved executable must be an absolute Windows path ending in .exe", async () => {
  await assert.rejects(
    resolveOpenCodeExecutable(config(), environment({ env: { PNP_OPENCODE_EXE_PATH: "opencode.exe" } })),
    { code: "ENGINE_EXECUTABLE_INVALID" },
  );
  await assert.rejects(
    resolveOpenCodeExecutable(config(), environment({ env: { PNP_OPENCODE_EXE_PATH: `${APPDATA}\\npm\\opencode.cmd` } })),
    { code: "ENGINE_EXECUTABLE_INVALID" },
  );
  const resolved = await resolveOpenCodeExecutable(config(), environment({
    env: { PNP_OPENCODE_EXE_PATH: "C:\\opencode\\opencode.exe" }, fileExists: async () => true,
  }));
  assert.equal(resolved.executable, "C:\\opencode\\opencode.exe");
});

test("an explicit path that names no file fails as ENGINE_EXECUTABLE_NOT_FOUND and says where it came from", async () => {
  // The shape is fine, so the host would otherwise be the first to notice, with a generic start failure.
  await assert.rejects(
    resolveOpenCodeExecutable(config(), environment({ env: { PNP_OPENCODE_EXE_PATH: "C:\\opencode\\opencode.exe" } })),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENGINE_EXECUTABLE_NOT_FOUND"
      && error.message.includes("PNP_OPENCODE_EXE_PATH names \"C:\\opencode\\opencode.exe\""),
  );
  await assert.rejects(
    resolveOpenCodeExecutable(
      config({ exe: { configuredPath: "C:\\Custom\\opencode.exe", environmentVariable: "PNP_OPENCODE_EXE_PATH", wellKnownPaths: [] } }),
      environment(),
    ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENGINE_EXECUTABLE_NOT_FOUND"
      && /executable\.exe\.configuredPath names/.test(error.message),
  );
  // A malformed path is still reported as malformed, not as missing.
  await assert.rejects(
    resolveOpenCodeExecutable(config(), environment({ env: { PNP_OPENCODE_EXE_PATH: "opencode.exe" } })),
    { code: "ENGINE_EXECUTABLE_INVALID" },
  );
});

test("a shared Windows host still enforces .exe even when the checking process runs on Linux", async () => {
  // platform is the *target's* platform, not the checking host's: path.win32 rules apply either way.
  await assert.rejects(
    resolveOpenCodeExecutable(config(), environment({ platform: "win32", env: { PNP_OPENCODE_EXE_PATH: "/opt/opencode/bin/opencode" } })),
    { code: "ENGINE_EXECUTABLE_INVALID" },
  );
});

test("on a non-Windows host an absolute POSIX path with no extension is accepted", async () => {
  for (const platform of ["linux", "darwin"] as const) {
    const resolved = await resolveOpenCodeExecutable(config(), environment({
      platform, env: { PNP_OPENCODE_EXE_PATH: "/opt/opencode-linux-x64/bin/opencode" }, fileExists: async () => true,
    }));
    assert.equal(resolved.executable, "/opt/opencode-linux-x64/bin/opencode");
    assert.equal(resolved.kind, "exe");
    assert.deepEqual(resolved.prefixArgs, []);
  }
});

test("on a non-Windows host a relative path is still rejected, and a Windows path is not absolute there", async () => {
  await assert.rejects(
    resolveOpenCodeExecutable(config(), environment({ platform: "linux", env: { PNP_OPENCODE_EXE_PATH: "./opencode" } })),
    { code: "ENGINE_EXECUTABLE_INVALID" },
  );
  await assert.rejects(
    resolveOpenCodeExecutable(config(), environment({ platform: "linux", env: { PNP_OPENCODE_EXE_PATH: "C:\\opencode\\opencode.exe" } })),
    { code: "ENGINE_EXECUTABLE_INVALID" },
  );
});

test("the node-script script argument is absolute-checked per platform, without an .exe requirement", async () => {
  const cfg = config({
    node: { configuredPath: null, environmentVariable: "PNP_OPENCODE_NODE_PATH", wellKnownPaths: [], fallbackToHostRuntime: true },
    script: { configuredPath: null, environmentVariable: "PNP_OPENCODE_SCRIPT_PATH", wellKnownPaths: [] },
  });
  const resolved = await resolveOpenCodeExecutable(cfg, environment({
    platform: "linux", hostRuntimePath: "/usr/bin/node",
    env: { PNP_OPENCODE_EXECUTABLE_KIND: "node-script", PNP_OPENCODE_SCRIPT_PATH: "/opt/opencode/bin/opencode.mjs" },
  }));
  assert.deepEqual(resolved.prefixArgs, ["/opt/opencode/bin/opencode.mjs"]);
  await assert.rejects(
    resolveOpenCodeExecutable(cfg, environment({
      platform: "linux", hostRuntimePath: "/usr/bin/node",
      env: { PNP_OPENCODE_EXECUTABLE_KIND: "node-script", PNP_OPENCODE_SCRIPT_PATH: "bin/opencode.mjs" },
    })),
    { code: "ENGINE_EXECUTABLE_INVALID" },
  );
});

// --- node-script stays available, but only when it is asked for explicitly -------------------------------------

test("node-script is an explicit opt-in: PNP_OPENCODE_EXECUTABLE_KIND selects it and node.exe + script are resolved", async () => {
  const resolved = await resolveOpenCodeExecutable(config(), environment({
    env: {
      ...WINDOWS_ENV, PNP_OPENCODE_EXECUTABLE_KIND: "node-script",
      PNP_OPENCODE_NODE_PATH: "C:\\Env\\node.exe", PNP_OPENCODE_SCRIPT_PATH: "C:\\Env\\opencode-ai\\bin\\opencode.mjs",
    },
  }));
  assert.equal(resolved.kind, "node-script");
  assert.equal(resolved.executable, "C:\\Env\\node.exe");
  assert.equal(resolved.executableEvidence, "environment");
  assert.deepEqual(resolved.prefixArgs, ["C:\\Env\\opencode-ai\\bin\\opencode.mjs"]);
  assert.equal(resolved.scriptEvidence, "environment");
});

test("node-script falls back to the host runtime for node.exe, and still fails closed without a script", async () => {
  const withScript = await resolveOpenCodeExecutable(config(), environment({
    hostRuntimePath: `${PROGRAM_FILES}\\nodejs\\node.exe`,
    env: { PNP_OPENCODE_EXECUTABLE_KIND: "node-script", PNP_OPENCODE_SCRIPT_PATH: "C:\\Fallback\\opencode.mjs" },
  }));
  assert.equal(withScript.executable, `${PROGRAM_FILES}\\nodejs\\node.exe`);
  assert.equal(withScript.executableEvidence, "host-runtime-fallback");

  // The shipped config lists no well-known script path, because the published package contains no script.
  const shipped = await loadOpenCodeEngineConfig();
  assert.deepEqual(shipped.executable.script.wellKnownPaths, []);
  await assert.rejects(
    resolveOpenCodeExecutable(shipped, environment({ env: { ...WINDOWS_ENV, PNP_OPENCODE_EXECUTABLE_KIND: "node-script" } })),
    { code: "ENGINE_SCRIPT_NOT_FOUND" },
  );
});

test("throws ENGINE_EXECUTABLE_NOT_FOUND when node-script has no node.exe and no host-runtime fallback", async () => {
  const cfg = config({
    node: { configuredPath: null, environmentVariable: "PNP_OPENCODE_NODE_PATH", wellKnownPaths: [], fallbackToHostRuntime: false },
    script: { configuredPath: null, environmentVariable: "PNP_OPENCODE_SCRIPT_PATH", wellKnownPaths: [] },
  });
  await assert.rejects(
    resolveOpenCodeExecutable(cfg, environment({ env: { PNP_OPENCODE_EXECUTABLE_KIND: "node-script" } })),
    { code: "ENGINE_EXECUTABLE_NOT_FOUND" },
  );
});

test("an unrecognised PNP_OPENCODE_EXECUTABLE_KIND falls back to the configured default rather than guessing", async () => {
  const resolved = await resolveOpenCodeExecutable(config(), environment({
    env: { PNP_OPENCODE_EXECUTABLE_KIND: "wsl", PNP_OPENCODE_EXE_PATH: "C:\\opencode\\opencode.exe" }, fileExists: async () => true,
  }));
  assert.equal(resolved.kind, "exe");
});
