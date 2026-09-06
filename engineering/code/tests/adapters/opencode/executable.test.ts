import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOpenCodeExecutable, type ExecutableEnvironment } from "../../../src/engines/opencode/executable.ts";
import { parseOpenCodeEngineConfig, type OpenCodeEngineConfig } from "../../../src/engines/opencode/config.ts";

function config(overrides: Partial<OpenCodeEngineConfig["executable"]> = {}): OpenCodeEngineConfig {
  return parseOpenCodeEngineConfig({
    id: "opencode", channel: "acp", implementationEntry: "src/engines/opencode/pack.ts",
    engineVersion: "1.18.27", engineVersionLocked: true, protocolVersion: 1,
    distribution: { kind: "npm-global", packageNameCandidates: ["opencode-ai"], windowsNativeSupport: "official-discouraged" },
    acp: { subcommandArgs: ["acp"] },
    executable: {
      kindEnvironmentVariable: "PNP_OPENCODE_EXECUTABLE_KIND", defaultKind: "node-script",
      exe: { configuredPath: null, environmentVariable: "PNP_OPENCODE_EXE_PATH", wellKnownPaths: [] },
      node: { configuredPath: null, environmentVariable: "PNP_OPENCODE_NODE_PATH", wellKnownPaths: ["${ProgramFiles}\\nodejs\\node.exe"], fallbackToHostRuntime: true },
      script: { configuredPath: null, environmentVariable: "PNP_OPENCODE_SCRIPT_PATH", wellKnownPaths: ["${APPDATA}\\npm\\node_modules\\opencode-ai\\bin\\opencode"] },
      ...overrides,
    },
    redirect: { variables: { HOME: "home" } },
    model: { policy: "launch" },
    headerEnvironmentPrefix: "PNP_OPENCODE_HEADER_",
    timeouts: { requestMs: 30000, cancelGraceMs: 2000, cancelAckMs: 1000 },
    capabilityEvidence: "unverified",
  });
}
function environment(overrides: Partial<ExecutableEnvironment> = {}): ExecutableEnvironment {
  return {
    env: {}, hostRuntimePath: "/usr/bin/node", fileExists: async () => false,
    ...overrides,
  };
}

test("node-script mode: explicit configuredPath wins over environment and well-known probing", async () => {
  const cfg = config({
    node: { configuredPath: "C:\\Custom\\node.exe", environmentVariable: "PNP_OPENCODE_NODE_PATH", wellKnownPaths: [], fallbackToHostRuntime: true },
    script: { configuredPath: "C:\\Custom\\opencode\\bin\\opencode", environmentVariable: "PNP_OPENCODE_SCRIPT_PATH", wellKnownPaths: [] },
  });
  const resolved = await resolveOpenCodeExecutable(cfg, environment({ env: { PNP_OPENCODE_NODE_PATH: "C:\\Env\\node.exe" } }));
  assert.equal(resolved.executable, "C:\\Custom\\node.exe");
  assert.deepEqual(resolved.prefixArgs, ["C:\\Custom\\opencode\\bin\\opencode"]);
  assert.equal(resolved.kind, "node-script");
  assert.equal(resolved.executableEvidence, "configured");
});

test("node-script mode: environment variable is used when no configuredPath is set", async () => {
  const cfg = config();
  const resolved = await resolveOpenCodeExecutable(cfg, environment({
    env: { PNP_OPENCODE_NODE_PATH: "C:\\Env\\node.exe", PNP_OPENCODE_SCRIPT_PATH: "C:\\Env\\opencode-ai\\bin\\opencode" },
  }));
  assert.equal(resolved.executable, "C:\\Env\\node.exe");
  assert.equal(resolved.executableEvidence, "environment");
  assert.deepEqual(resolved.prefixArgs, ["C:\\Env\\opencode-ai\\bin\\opencode"]);
  assert.equal(resolved.scriptEvidence, "environment");
});

test("node-script mode: well-known paths are probed with token expansion and only chosen if they exist", async () => {
  const cfg = config();
  const seen: string[] = [];
  const resolved = await resolveOpenCodeExecutable(cfg, environment({
    env: { ProgramFiles: "C:\\Program Files", APPDATA: "C:\\Users\\svc\\AppData\\Roaming" },
    fileExists: async (candidate) => { seen.push(candidate); return candidate.endsWith("node.exe") || candidate.endsWith("opencode"); },
  }));
  assert.equal(resolved.executable, "C:\\Program Files\\nodejs\\node.exe");
  assert.equal(resolved.executableEvidence, "well-known-probe");
  assert.deepEqual(resolved.prefixArgs, ["C:\\Users\\svc\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode"]);
  assert.ok(seen.includes("C:\\Program Files\\nodejs\\node.exe"));
});

test("node-script mode: falls back to the host runtime for node.exe when nothing else resolves", async () => {
  const cfg = config();
  const resolved = await resolveOpenCodeExecutable(cfg, environment({
    hostRuntimePath: "C:\\Program Files\\nodejs\\node.exe",
    env: { PNP_OPENCODE_SCRIPT_PATH: "C:\\Fallback\\opencode-ai\\bin\\opencode" },
  }));
  assert.equal(resolved.executable, "C:\\Program Files\\nodejs\\node.exe");
  assert.equal(resolved.executableEvidence, "host-runtime-fallback");
});

test("node-script mode: throws ENGINE_SCRIPT_NOT_FOUND when node resolves but the script never does", async () => {
  const cfg = config();
  await assert.rejects(
    resolveOpenCodeExecutable(cfg, environment({ env: { PNP_OPENCODE_NODE_PATH: "C:\\Env\\node.exe" } })),
    { code: "ENGINE_SCRIPT_NOT_FOUND" },
  );
});

test("throws ENGINE_EXECUTABLE_NOT_FOUND when nothing resolves and there is no fallback", async () => {
  const cfg = config({
    node: { configuredPath: null, environmentVariable: "PNP_OPENCODE_NODE_PATH", wellKnownPaths: [], fallbackToHostRuntime: false },
    script: { configuredPath: null, environmentVariable: "PNP_OPENCODE_SCRIPT_PATH", wellKnownPaths: [] },
  });
  await assert.rejects(resolveOpenCodeExecutable(cfg, environment()), { code: "ENGINE_EXECUTABLE_NOT_FOUND" });
});

test("rejects a resolved node path that is not an absolute Windows path", async () => {
  const cfg = config();
  await assert.rejects(
    resolveOpenCodeExecutable(cfg, environment({ env: { PNP_OPENCODE_NODE_PATH: "node.exe", PNP_OPENCODE_SCRIPT_PATH: "C:\\ok\\opencode" } })),
    { code: "ENGINE_EXECUTABLE_INVALID" },
  );
});

test("rejects a resolved node path that does not end in .exe (the npm-shim case the shared host rejects)", async () => {
  const cfg = config();
  await assert.rejects(
    resolveOpenCodeExecutable(cfg, environment({
      env: { PNP_OPENCODE_NODE_PATH: "C:\\Users\\svc\\AppData\\Roaming\\npm\\opencode.cmd", PNP_OPENCODE_SCRIPT_PATH: "C:\\ok\\opencode" },
    })),
    { code: "ENGINE_EXECUTABLE_INVALID" },
  );
});

test("exe mode: kind can be forced via the environment override and requires .exe", async () => {
  const cfg = config();
  await assert.rejects(
    resolveOpenCodeExecutable(cfg, environment({
      env: { PNP_OPENCODE_EXECUTABLE_KIND: "exe", PNP_OPENCODE_EXE_PATH: "C:\\opencode\\opencode.bat" },
    })),
    { code: "ENGINE_EXECUTABLE_INVALID" },
  );
  const resolved = await resolveOpenCodeExecutable(cfg, environment({
    env: { PNP_OPENCODE_EXECUTABLE_KIND: "exe", PNP_OPENCODE_EXE_PATH: "C:\\opencode\\opencode.exe" },
  }));
  assert.equal(resolved.kind, "exe");
  assert.deepEqual(resolved.prefixArgs, []);
});
