import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenCodePack } from "../../../src/engines/opencode/pack.ts";
import type {
  EngineOpenInput, IntegrationContext, ProcessHost, ResourceScope, Session, StopEvidence,
} from "../../../src/contracts/index.ts";
import type { HostedProcess, LaunchSpec } from "../../../src/contracts/host.ts";

/**
 * This suite proves OpenCodePack.open() correctly builds the launch request, writes the private native config,
 * and hands off to the ACP v1 driver's public seam (openAcpChannel) -- it does not spawn a real opencode binary.
 * A minimal fake ACP peer answers just enough JSON-RPC to complete the driver's handshake (initialize,
 * session/new); see src/drivers/acp/channel.ts for the real protocol implementation, which this test does not
 * modify or duplicate.
 */
type JsonRpcMessage = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: unknown };

class FakeHostedProcess implements HostedProcess {
  readonly hostId = "fake-opencode-host";
  readonly generation = 1;
  readonly writtenFrames: string[] = [];
  private readonly frameListeners = new Set<(frame: string) => void>();
  private readonly exitListeners = new Set<(exit: { code: number | null; signal: string | null }) => void>();
  private terminated = false;

  async write(frame: string): Promise<void> {
    this.writtenFrames.push(frame);
    const message = JSON.parse(frame) as JsonRpcMessage;
    if (message.method === undefined || message.id === undefined) return; // notification: no reply expected
    const result = this.respond(message.method);
    const response = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    queueMicrotask(() => { for (const listener of this.frameListeners) listener(response); });
  }
  private respond(method: string): unknown {
    if (method === "initialize") {
      return { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "fake-opencode", version: "0.0.0-fake" } };
    }
    if (method === "session/new") return { sessionId: "fake-session-id", configOptions: [] };
    if (method === "session/prompt") return { stopReason: "end_turn" };
    return {};
  }
  onFrame(listener: (frame: string) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }
  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  async terminate(): Promise<StopEvidence> {
    this.terminated = true;
    return { quiescent: true, method: "process-tree" };
  }
  get wasTerminated(): boolean { return this.terminated; }
}
class FakeProcessHost implements ProcessHost {
  readonly launched: { spec: LaunchSpec; process: FakeHostedProcess }[] = [];
  async start(spec: LaunchSpec): Promise<HostedProcess> {
    const process = new FakeHostedProcess();
    this.launched.push({ spec, process });
    return process;
  }
  async reconcile(): Promise<StopEvidence> { return { quiescent: true, method: "not-running" }; }
}
class FakeResourceScope implements ResourceScope {
  readonly closed = false;
  register(): void { /* no owned resources in this fake */ }
}
function fakeSession(directory: string): Session {
  return {
    id: "gw-session-1", title: "test", directory, engineId: "opencode", channelId: "acp",
    lifecycle: "active", status: "idle", recovery: "ready",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
function fakeIntegration(overrides: Partial<IntegrationContext> = {}): IntegrationContext {
  return {
    model: {
      selection: { providerID: "acme-internal", modelID: "acme-large-v3" },
      protocol: "openai-chat",
      endpoint: "https://model.internal.example.invalid/v1",
      headers: { Authorization: "Bearer test-only-secret-value" },
    },
    tools: [], assets: [],
    authorize: async () => ({ effect: "deny", reasonCode: "TEST_POLICY" }),
    ...overrides,
  };
}

test("open() resolves the executable, writes the private config and reaches the ACP driver seam", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-opencode-pack-"));
  const previousNode = process.env["PNP_OPENCODE_NODE_PATH"];
  const previousScript = process.env["PNP_OPENCODE_SCRIPT_PATH"];
  process.env["PNP_OPENCODE_NODE_PATH"] = "C:\\Fake\\nodejs\\node.exe";
  process.env["PNP_OPENCODE_SCRIPT_PATH"] = "C:\\Fake\\npm\\node_modules\\opencode-ai\\bin\\opencode";
  try {
    const host = new FakeProcessHost();
    const nativeDataDirectory = path.join(root, "native");
    const input: EngineOpenInput = {
      host, session: fakeSession(path.join(root, "workspace")), nativeDataDirectory,
      integration: fakeIntegration(), resources: new FakeResourceScope(),
      signal: new AbortController().signal,
    };
    const pack = new OpenCodePack();
    const channel = await pack.open(input);
    try {
      assert.equal(channel.native.nativeId, "fake-session-id");
      assert.equal(channel.native.channelId, "acp");
      assert.equal(host.launched.length, 1);
      const spec = host.launched[0]!.spec;
      assert.equal(spec.executable, "C:\\Fake\\nodejs\\node.exe");
      assert.deepEqual(spec.args, ["C:\\Fake\\npm\\node_modules\\opencode-ai\\bin\\opencode", "acp"]);
      assert.equal(spec.cwd, input.session.directory);
      assert.equal(spec.sessionId, input.session.id);
      assert.ok(spec.ownerToken.length > 0);
      // The header secret only ever reaches the child process's environment, never a file on disk.
      assert.equal(spec.env["PNP_OPENCODE_HEADER_AUTHORIZATION"], "Bearer test-only-secret-value");
      assert.ok(spec.env["HOME"]?.startsWith(nativeDataDirectory));
      const configFile = path.join(spec.env["HOME"]!, ".config", "opencode", "opencode.json");
      const text = await readFile(configFile, "utf8");
      assert.doesNotMatch(text, /test-only-secret-value/);
      assert.match(text, /\$PNP_OPENCODE_HEADER_AUTHORIZATION/);
    } finally {
      await channel.close();
    }
  } finally {
    if (previousNode === undefined) delete process.env["PNP_OPENCODE_NODE_PATH"]; else process.env["PNP_OPENCODE_NODE_PATH"] = previousNode;
    if (previousScript === undefined) delete process.env["PNP_OPENCODE_SCRIPT_PATH"]; else process.env["PNP_OPENCODE_SCRIPT_PATH"] = previousScript;
    await rm(root, { recursive: true, force: true });
  }
});

test("open() fails with a clear executable-resolution error and never starts a process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-opencode-pack-"));
  const previousNode = process.env["PNP_OPENCODE_NODE_PATH"];
  const previousScript = process.env["PNP_OPENCODE_SCRIPT_PATH"];
  const previousKind = process.env["PNP_OPENCODE_EXECUTABLE_KIND"];
  delete process.env["PNP_OPENCODE_NODE_PATH"];
  delete process.env["PNP_OPENCODE_SCRIPT_PATH"];
  process.env["PNP_OPENCODE_EXECUTABLE_KIND"] = "exe"; // force exe mode, which has no configured/well-known path either
  try {
    const host = new FakeProcessHost();
    const input: EngineOpenInput = {
      host, session: fakeSession(path.join(root, "workspace")), nativeDataDirectory: path.join(root, "native"),
      integration: fakeIntegration(), resources: new FakeResourceScope(),
      signal: new AbortController().signal,
    };
    await assert.rejects(new OpenCodePack().open(input), { code: "ENGINE_EXECUTABLE_NOT_FOUND" });
    assert.equal(host.launched.length, 0, "a failed executable resolution must never reach the process host");
  } finally {
    if (previousNode === undefined) delete process.env["PNP_OPENCODE_NODE_PATH"]; else process.env["PNP_OPENCODE_NODE_PATH"] = previousNode;
    if (previousScript === undefined) delete process.env["PNP_OPENCODE_SCRIPT_PATH"]; else process.env["PNP_OPENCODE_SCRIPT_PATH"] = previousScript;
    if (previousKind === undefined) delete process.env["PNP_OPENCODE_EXECUTABLE_KIND"]; else process.env["PNP_OPENCODE_EXECUTABLE_KIND"] = previousKind;
    await rm(root, { recursive: true, force: true });
  }
});

test("open() fails before any process starts when a required asset kind has no native projection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-opencode-pack-"));
  const previousNode = process.env["PNP_OPENCODE_NODE_PATH"];
  const previousScript = process.env["PNP_OPENCODE_SCRIPT_PATH"];
  process.env["PNP_OPENCODE_NODE_PATH"] = "C:\\Fake\\nodejs\\node.exe";
  process.env["PNP_OPENCODE_SCRIPT_PATH"] = "C:\\Fake\\npm\\node_modules\\opencode-ai\\bin\\opencode";
  try {
    const host = new FakeProcessHost();
    const input: EngineOpenInput = {
      host, session: fakeSession(path.join(root, "workspace")), nativeDataDirectory: path.join(root, "native"),
      integration: fakeIntegration({
        assets: [{ id: "ext-1", kind: "native-extension", path: "/does/not/matter", sha256: "0".repeat(64), required: true }],
      }),
      resources: new FakeResourceScope(), signal: new AbortController().signal,
    };
    await assert.rejects(new OpenCodePack().open(input), { code: "ENGINE_ASSET_KIND_UNSUPPORTED" });
    assert.equal(host.launched.length, 0, "a required-asset projection failure must never reach the process host");
  } finally {
    if (previousNode === undefined) delete process.env["PNP_OPENCODE_NODE_PATH"]; else process.env["PNP_OPENCODE_NODE_PATH"] = previousNode;
    if (previousScript === undefined) delete process.env["PNP_OPENCODE_SCRIPT_PATH"]; else process.env["PNP_OPENCODE_SCRIPT_PATH"] = previousScript;
    await rm(root, { recursive: true, force: true });
  }
});
