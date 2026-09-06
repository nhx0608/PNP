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
/** The path shape the shared ProcessHost accepts on the host this test happens to run on. */
function fakeExecutable(root: string): string {
  return path.join(root, process.platform === "win32" ? "opencode.exe" : "opencode");
}
/** Sets engine env vars for one test and restores exactly what was there before, including "was unset". */
async function withEnvironment(values: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await body();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("open() launches the resolved executable with just the ACP subcommand and reaches the ACP driver seam", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-opencode-pack-"));
  const executable = fakeExecutable(root);
  try {
    await withEnvironment({ PNP_OPENCODE_EXECUTABLE_KIND: undefined, PNP_OPENCODE_EXE_PATH: executable }, async () => {
      const host = new FakeProcessHost();
      const nativeDataDirectory = path.join(root, "native");
      const input: EngineOpenInput = {
        host, session: fakeSession(path.join(root, "workspace")), nativeDataDirectory,
        integration: fakeIntegration(), resources: new FakeResourceScope(),
        signal: new AbortController().signal,
      };
      const channel = await new OpenCodePack().open(input);
      try {
        assert.equal(channel.native.nativeId, "fake-session-id");
        assert.equal(channel.native.channelId, "acp");
        assert.equal(host.launched.length, 1);
        const spec = host.launched[0]!.spec;
        // exe mode: the binary itself, with no interpreter and no script argument in front of "acp".
        assert.equal(spec.executable, executable);
        assert.deepEqual(spec.args, ["acp"]);
        assert.equal(spec.cwd, input.session.directory);
        assert.equal(spec.sessionId, input.session.id);
        assert.ok(spec.ownerToken.length > 0);

        // OPENCODE_CONFIG is the documented discovery route and points at one deterministic private file.
        const pointer = spec.env["OPENCODE_CONFIG"];
        assert.equal(pointer, path.join(nativeDataDirectory, "opencode", "opencode.json"));
        const text = await readFile(pointer!, "utf8");
        // The bearer token only ever reaches the child process's environment, never a file on disk.
        assert.doesNotMatch(text, /test-only-secret-value/);
        assert.match(text, /\{env:PNP_OPENCODE_HEADER_API_KEY\}/);
        assert.equal(spec.env["PNP_OPENCODE_HEADER_API_KEY"], "test-only-secret-value");
        const parsed = JSON.parse(text) as Record<string, unknown>;
        assert.equal(parsed["model"], "acme-internal/acme-large-v3");
        assert.equal(parsed["share"], "disabled");

        // The fallback config homes still exist, and the profile redirects still point into the private tree.
        assert.ok(spec.env["HOME"]?.startsWith(nativeDataDirectory));
        const mirrored = await readFile(path.join(spec.env["HOME"]!, ".config", "opencode", "opencode.json"), "utf8");
        assert.equal(mirrored, text);
      } finally {
        await channel.close();
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("open() fails with a clear executable-resolution error and never starts a process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-opencode-pack-"));
  try {
    const openWith = async (env: Record<string, string | undefined>, code: string): Promise<void> => {
      await withEnvironment(env, async () => {
        const host = new FakeProcessHost();
        const input: EngineOpenInput = {
          host, session: fakeSession(path.join(root, "workspace")), nativeDataDirectory: path.join(root, "native"),
          integration: fakeIntegration(), resources: new FakeResourceScope(),
          signal: new AbortController().signal,
        };
        await assert.rejects(new OpenCodePack().open(input), { code });
        assert.equal(host.launched.length, 0, "a failed executable resolution must never reach the process host");
      });
    };
    // A relative path is rejected on every platform: the shared host requires an absolute executable.
    await openWith({ PNP_OPENCODE_EXECUTABLE_KIND: undefined, PNP_OPENCODE_EXE_PATH: "opencode" }, "ENGINE_EXECUTABLE_INVALID");
    // node-script is opt-in, and the shipped config lists no script to fall back on: it fails, it does not guess.
    await openWith(
      { PNP_OPENCODE_EXECUTABLE_KIND: "node-script", PNP_OPENCODE_EXE_PATH: undefined, PNP_OPENCODE_SCRIPT_PATH: undefined },
      "ENGINE_SCRIPT_NOT_FOUND",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("open() fails before any process starts when a required asset kind has no native projection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-opencode-pack-"));
  try {
    await withEnvironment({ PNP_OPENCODE_EXECUTABLE_KIND: undefined, PNP_OPENCODE_EXE_PATH: fakeExecutable(root) }, async () => {
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
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
