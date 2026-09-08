import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { OpenCodePack, PROXY_ENVIRONMENT_VARIABLES, proxyEnvironment } from "../../../src/engines/opencode/pack.ts";
import type {
  AssetBinding, EngineOpenInput, IntegrationContext, ProcessHost, ResolvedModel, ResourceScope, Session,
  StopEvidence,
} from "../../../src/contracts/index.ts";
import type { HostedProcess, LaunchSpec } from "../../../src/contracts/host.ts";
import { removeTree } from "../../kit/fs.ts";

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
/** The resolver checks that an explicit path names a file, so the fake must exist; it is never executed. */
async function fakeExecutable(root: string): Promise<string> {
  const executable = path.join(root, process.platform === "win32" ? "opencode.exe" : "opencode");
  await writeFile(executable, "", "utf8");
  return executable;
}
/** Writes one instruction file and the AssetBinding WP1's ConfiguredIntegration produces for it. */
async function instructionAsset(sourceRoot: string, id: string, filename: string, content: string): Promise<AssetBinding> {
  const file = path.join(sourceRoot, id, filename);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return { id, kind: "instruction", path: file, sha256: createHash("sha256").update(content).digest("hex"), required: true };
}
/** Opens one session through the Pack and hands the resulting LaunchSpec to the caller, then closes it. */
async function withLaunchSpec(
  root: string, nativeDataDirectory: string, integration: IntegrationContext,
  body: (spec: LaunchSpec) => Promise<void>,
): Promise<void> {
  const host = new FakeProcessHost();
  const input: EngineOpenInput = {
    host, session: fakeSession(path.join(root, "workspace")), nativeDataDirectory,
    integration, resources: new FakeResourceScope(), signal: new AbortController().signal,
  };
  const channel = await new OpenCodePack().open(input);
  try {
    assert.equal(host.launched.length, 1);
    await body(host.launched[0]!.spec);
  } finally {
    await channel.close();
  }
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
  const executable = await fakeExecutable(root);
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

        // The private config directory is the documented "Custom directory" step, and the fallback config home
        // mirror is byte-identical to the file OPENCODE_CONFIG names.
        const configDirectory = spec.env["OPENCODE_CONFIG_DIR"];
        assert.equal(configDirectory, path.join(nativeDataDirectory, "opencode", "config"));
        assert.ok(spec.env["XDG_CONFIG_HOME"]?.startsWith(nativeDataDirectory));
        const mirrored = await readFile(path.join(spec.env["XDG_CONFIG_HOME"]!, "opencode", "opencode.json"), "utf8");
        assert.equal(mirrored, text);

        // The user profile is NOT redirected any more: Office COM and Outlook need the real per-user state of
        // whoever runs the gateway, and the private profile they used to see broke exactly that.
        for (const variable of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
          assert.equal(variable in spec.env, false, `${variable} must not be redirected by the Pack`);
        }
        // question is off in the generated config, and external_directory is explicitly allowed.
        assert.deepEqual(parsed["tools"], { question: false });
        assert.deepEqual(parsed["permission"], { external_directory: "allow" });
      } finally {
        await channel.close();
      }
    });
  } finally {
    await removeTree(root);
  }
});

test("open() projects the context's permission policy into the private config, and nothing else does", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-opencode-pack-"));
  const executable = await fakeExecutable(root);
  try {
    // Neither the unified settings file nor the compatibility switch is visible here: whatever the private
    // config ends up asking OpenCode for came from the IntegrationContext alone.
    await withEnvironment({
      PNP_OPENCODE_EXECUTABLE_KIND: undefined, PNP_OPENCODE_EXE_PATH: executable,
      PNP_SETTINGS: undefined, PNP_OPENCODE_NATIVE_PERMISSIONS: undefined,
    }, async () => {
      const permissionOf = async (integration: IntegrationContext, directory: string): Promise<unknown> => {
        const host = new FakeProcessHost();
        const input: EngineOpenInput = {
          host, session: fakeSession(path.join(root, "workspace")), nativeDataDirectory: directory,
          integration, resources: new FakeResourceScope(), signal: new AbortController().signal,
        };
        const channel = await new OpenCodePack().open(input);
        try {
          const pointer = host.launched[0]!.spec.env["OPENCODE_CONFIG"]!;
          return (JSON.parse(await readFile(pointer, "utf8")) as Record<string, unknown>)["permission"];
        } finally { await channel.close(); }
      };

      // A gateway policy of "ask" on write must become a native prompt: without it OpenCode allows the edit on
      // its own and the gateway is never asked to hold it. external_directory rides along because the policy
      // default is allow and nothing named that operation (see buildNativePermissionConfig).
      assert.deepEqual(
        await permissionOf(fakeIntegration({ permissions: { default: "allow", operations: { write: "ask" } } }),
          path.join(root, "native-ask")),
        { edit: "ask", external_directory: "allow" },
      );
      // A provider that publishes no policy leaves the Pack on its allow-everything default, which still has to
      // say external_directory explicitly: OpenCode's own default for it is `ask`, and nobody is at the keyboard.
      assert.deepEqual(await permissionOf(fakeIntegration(), path.join(root, "native-none")),
        { external_directory: "allow" });
      // A policy that does name it keeps exactly what the operator asked for.
      assert.deepEqual(
        await permissionOf(fakeIntegration({ permissions: { default: "allow", operations: { external_directory: "ask" } } }),
          path.join(root, "native-external-ask")),
        { external_directory: "ask" },
      );
    });
  } finally {
    await removeTree(root);
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
    await removeTree(root);
  }
});

test("open() fails before any process starts when a required asset kind has no native projection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-opencode-pack-"));
  try {
    await withEnvironment({ PNP_OPENCODE_EXECUTABLE_KIND: undefined, PNP_OPENCODE_EXE_PATH: await fakeExecutable(root) }, async () => {
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
    await removeTree(root);
  }
});

test("one instruction asset yields an instructions entry that points at a readable file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-opencode-pack-"));
  const executable = await fakeExecutable(root);
  try {
    await withEnvironment({ PNP_OPENCODE_EXECUTABLE_KIND: undefined, PNP_OPENCODE_EXE_PATH: executable }, async () => {
      const nativeDataDirectory = path.join(root, "native-one-instruction");
      const workspace = path.join(root, "workspace");
      const text = "Never ask the user a question. Write artefacts to the absolute path you were given.\n";
      const asset = await instructionAsset(path.join(root, "source-one"), "inst-competition", "COMPETITION.md", text);
      await withLaunchSpec(root, nativeDataDirectory, fakeIntegration({ assets: [asset] }), async (spec) => {
        const parsed = JSON.parse(await readFile(spec.env["OPENCODE_CONFIG"]!, "utf8")) as { instructions?: string[] };
        assert.equal(parsed.instructions?.length, 1, "the projected instruction must reach the generated config");
        const entry = parsed.instructions![0]!;
        assert.ok(path.isAbsolute(entry), `${entry} must be absolute: OpenCode resolves a relative entry against the config file`);
        // The path in the config is the copy this Pack made, inside the private tree and never in the workspace.
        assert.ok(entry.startsWith(nativeDataDirectory + path.sep));
        assert.ok(!entry.startsWith(workspace + path.sep));
        assert.equal(await readFile(entry, "utf8"), text, "the file the engine will read must exist with the asset's content");
      });
    });
  } finally {
    await removeTree(root);
  }
});

test("several instruction assets each reach the config as their own readable file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-opencode-pack-"));
  const executable = await fakeExecutable(root);
  try {
    await withEnvironment({ PNP_OPENCODE_EXECUTABLE_KIND: undefined, PNP_OPENCODE_EXE_PATH: executable }, async () => {
      const nativeDataDirectory = path.join(root, "native-many-instructions");
      const sourceRoot = path.join(root, "source-many");
      // The third asset deliberately repeats the second one's basename: the per-asset-id directory is what keeps
      // two instruction files from overwriting each other, and both must survive into the config.
      const assets = [
        await instructionAsset(sourceRoot, "inst-competition", "COMPETITION.md", "one\n"),
        await instructionAsset(sourceRoot, "inst-office", "GUIDE.md", "two\n"),
        await instructionAsset(sourceRoot, "inst-shell", "GUIDE.md", "three\n"),
      ];
      await withLaunchSpec(root, nativeDataDirectory, fakeIntegration({ assets }), async (spec) => {
        const parsed = JSON.parse(await readFile(spec.env["OPENCODE_CONFIG"]!, "utf8")) as { instructions?: string[] };
        assert.equal(parsed.instructions?.length, 3, "no instruction asset may be dropped or collapsed");
        assert.equal(new Set(parsed.instructions).size, 3, "two assets must never share one target path");
        const contents: string[] = [];
        for (const entry of parsed.instructions!) {
          assert.ok(path.isAbsolute(entry));
          contents.push(await readFile(entry, "utf8"));
        }
        assert.deepEqual(contents, ["one\n", "two\n", "three\n"], "order and content follow the assets as they arrived");
      });
    });
  } finally {
    await removeTree(root);
  }
});

test("the child gets the model's CA file, the TLS opt-out only when the model asks for it, and the gateway's proxy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-opencode-pack-"));
  const executable = await fakeExecutable(root);
  const caFile = path.join(root, "internal-ca.pem");
  await writeFile(caFile, "", "utf8");
  const modelWith = (overrides: Partial<ResolvedModel>): ResolvedModel => ({
    selection: { providerID: "acme-internal", modelID: "acme-large-v3" },
    protocol: "openai-chat",
    endpoint: "https://model.internal.example.invalid/v1",
    headers: {},
    ...overrides,
  });
  try {
    await withEnvironment({
      PNP_OPENCODE_EXECUTABLE_KIND: undefined, PNP_OPENCODE_EXE_PATH: executable,
      HTTP_PROXY: "http://proxy.internal.example.invalid:8080",
      HTTPS_PROXY: "http://proxy.internal.example.invalid:8080",
      NO_PROXY: "localhost,127.0.0.1",
      http_proxy: undefined, https_proxy: undefined, no_proxy: undefined,
    }, async () => {
      // A CA file alone must never imply the opt-out: a deployment that supplied a CA still wants verification.
      await withLaunchSpec(root, path.join(root, "native-ca"), fakeIntegration({ model: modelWith({ caFile }) }), async (spec) => {
        assert.equal(spec.env["NODE_EXTRA_CA_CERTS"], caFile);
        assert.equal("NODE_TLS_REJECT_UNAUTHORIZED" in spec.env, false);
        // Proxy configuration is host configuration, not a credential: the child needs the same route out.
        assert.equal(spec.env["HTTP_PROXY"], "http://proxy.internal.example.invalid:8080");
        assert.equal(spec.env["HTTPS_PROXY"], "http://proxy.internal.example.invalid:8080");
        assert.equal(spec.env["NO_PROXY"], "localhost,127.0.0.1");
        assert.equal("http_proxy" in spec.env, false, "an unset variable must not be exported as an empty string");
      });
      // tlsInsecure is the only thing that turns verification off, and only when it is exactly true.
      await withLaunchSpec(root, path.join(root, "native-insecure"),
        fakeIntegration({ model: modelWith({ caFile, tlsInsecure: true }) }), async (spec) => {
          assert.equal(spec.env["NODE_TLS_REJECT_UNAUTHORIZED"], "0");
          assert.equal(spec.env["NODE_EXTRA_CA_CERTS"], caFile);
        });
      await withLaunchSpec(root, path.join(root, "native-secure"),
        fakeIntegration({ model: modelWith({ tlsInsecure: false }) }), async (spec) => {
          assert.equal("NODE_TLS_REJECT_UNAUTHORIZED" in spec.env, false);
          assert.equal("NODE_EXTRA_CA_CERTS" in spec.env, false, "no caFile means no trust-store extension");
        });
    });
    // With no proxy in the gateway's own environment the child gets none either -- nothing is invented.
    await withEnvironment({
      PNP_OPENCODE_EXECUTABLE_KIND: undefined, PNP_OPENCODE_EXE_PATH: executable,
      ...Object.fromEntries(PROXY_ENVIRONMENT_VARIABLES.map((name) => [name, undefined])),
    }, async () => {
      await withLaunchSpec(root, path.join(root, "native-no-proxy"), fakeIntegration(), async (spec) => {
        for (const name of PROXY_ENVIRONMENT_VARIABLES) assert.equal(name in spec.env, false, `${name} must not be invented`);
      });
    });
  } finally {
    await removeTree(root);
  }
});

test("proxyEnvironment copies both cases, skips what is unset, and never invents a value", () => {
  assert.deepEqual(proxyEnvironment({}), {});
  assert.deepEqual(proxyEnvironment({
    HTTP_PROXY: "http://a.invalid:1", https_proxy: "http://b.invalid:2", NO_PROXY: "", no_proxy: "localhost",
    SOME_OTHER: "kept out",
  }), { HTTP_PROXY: "http://a.invalid:1", https_proxy: "http://b.invalid:2", no_proxy: "localhost" });
  // The list itself is part of the contract with the shared host, whose allow-list carries none of these.
  assert.deepEqual([...PROXY_ENVIRONMENT_VARIABLES],
    ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]);
});
