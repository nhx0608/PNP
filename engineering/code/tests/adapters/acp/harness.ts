import type {
  AssetBinding, AuthorizationDecision, DriverEvent, DriverServices, EngineOpenInput, EngineSessionChannel,
  IntegrationContext, InteractionRequest, InteractionResponse, Json, ModelSelection, PromptRequest, Session,
  ToolBinding,
} from "../../../src/contracts/index.ts";
import type { AcpEngineDefinition, AcpLaunchRequest } from "../../../src/drivers/acp/channel.ts";
import { OwnedResourceScope } from "../../../src/runtime/resource-scope.ts";
import { FakeAgent, FakeHostedProcess, FakeProcessHost } from "../../kit/fake-host.ts";

/** Short bounds keep the timeout paths honest without making the suite slow. */
export const FAST_TIMEOUTS = { requestMs: 200, cancelGraceMs: 120, cancelAckMs: 100 };

export const MODEL: ModelSelection = { providerID: "internal", modelID: "test-model" };

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    title: "acp session",
    directory: "/workspace/project",
    engineId: "acp-test",
    channelId: "acp",
    lifecycle: "active",
    status: "idle",
    recovery: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeIntegration(overrides: {
  tools?: readonly ToolBinding[];
  assets?: readonly AssetBinding[];
  authorize?(request: InteractionRequest): Promise<AuthorizationDecision>;
} = {}): IntegrationContext {
  return {
    model: { selection: MODEL, protocol: "test", headers: {} },
    tools: overrides.tools ?? [],
    assets: overrides.assets ?? [],
    authorize: overrides.authorize ?? ((): Promise<AuthorizationDecision> =>
      Promise.resolve({ effect: "allow", reasonCode: "test.allow" })),
  };
}

export function mcpTool(overrides: Partial<ToolBinding> = {}): ToolBinding {
  return {
    id: "search",
    transport: "mcp-stdio",
    command: "mcp-search",
    args: ["--stdio"],
    env: { MCP_MODE: "stdio" },
    sideEffect: "read",
    ...overrides,
  };
}

export function asset(overrides: Partial<AssetBinding> = {}): AssetBinding {
  return {
    id: "house-style",
    kind: "instruction",
    path: "/assets/house-style.md",
    sha256: "0".repeat(64),
    required: false,
    ...overrides,
  };
}

/** Records everything the driver emits and answers interactions from a script. */
export class RecordingServices implements DriverServices {
  readonly emitted: DriverEvent[] = [];
  readonly interactions: InteractionRequest[] = [];
  private readonly answer: (request: InteractionRequest) => Promise<InteractionResponse>;
  private readonly emitFailure: ((event: DriverEvent) => Error | undefined) | undefined;

  constructor(options: {
    answer?(request: InteractionRequest): Promise<InteractionResponse>;
    emitFailure?(event: DriverEvent): Error | undefined;
  } = {}) {
    this.answer = options.answer ?? ((): Promise<InteractionResponse> =>
      Promise.reject(new Error("The test did not script an interaction answer.")));
    this.emitFailure = options.emitFailure;
  }

  readonly events = {
    emit: (event: DriverEvent): Promise<void> => {
      const failure = this.emitFailure?.(event);
      if (failure !== undefined) return Promise.reject(failure);
      this.emitted.push(event);
      return Promise.resolve();
    },
  };
  interact(request: InteractionRequest): Promise<InteractionResponse> {
    this.interactions.push(request);
    return this.answer(request);
  }

  /** Every event of one type, in emission order. */
  ofType<T extends DriverEvent["type"]>(type: T): Extract<DriverEvent, { type: T }>[] {
    return this.emitted.filter((event): event is Extract<DriverEvent, { type: T }> => event.type === type);
  }
  /** Every native event with one name, in emission order. */
  native(eventName: string): Extract<DriverEvent, { type: "native" }>[] {
    return this.ofType("native").filter((event) => event.eventName === eventName);
  }
  get types(): string[] {
    return this.emitted.map((event) => event.type);
  }
}

export function promptRequest(text = "hello", model: ModelSelection = MODEL): PromptRequest {
  return { parts: [{ type: "text", text }], model };
}

export interface Harness {
  host: FakeProcessHost;
  process: FakeHostedProcess;
  agent: FakeAgent;
  resources: OwnedResourceScope;
  controller: AbortController;
  session: Session;
  integration: IntegrationContext;
  input: EngineOpenInput;
}

export function harness(options: {
  session?: Session;
  integration?: IntegrationContext;
  process?: FakeHostedProcess;
  handlers?: Readonly<Record<string, (params: unknown, agent: FakeAgent) => unknown>>;
} = {}): Harness {
  const process = options.process ?? new FakeHostedProcess();
  const agent = new FakeAgent(process, { ...(options.handlers === undefined ? {} : { handlers: options.handlers }) });
  const host = new FakeProcessHost([process]);
  const resources = new OwnedResourceScope();
  const controller = new AbortController();
  const session = options.session ?? makeSession();
  const integration = options.integration ?? makeIntegration();
  return {
    host, process, agent, resources, controller, session, integration,
    input: {
      host, session, integration, resources,
      nativeDataDirectory: "/data/acp/session-1",
      signal: controller.signal,
    },
  };
}

export function definition(overrides: Partial<AcpEngineDefinition> = {}): AcpEngineDefinition {
  return {
    engineId: "acp-test",
    channelId: "acp",
    engineVersion: "0.0.0-test",
    model: { kind: "launch", modelID: MODEL.modelID },
    launch: (): AcpLaunchRequest => ({
      executable: "acp-engine", args: ["--acp"], cwd: "/workspace/project", env: { PNP_TEST: "1" },
    }),
    timeouts: FAST_TIMEOUTS,
    ...overrides,
  };
}

/** Runs one turn against an opened channel with recording services. */
export async function runTurn(channel: EngineSessionChannel, options: {
  services: RecordingServices;
  integration: IntegrationContext;
  request?: PromptRequest;
  runId?: string;
  signal?: AbortSignal;
}): ReturnType<EngineSessionChannel["run"]> {
  return channel.run({
    runId: options.runId ?? "run-1",
    request: options.request ?? promptRequest(),
    integration: options.integration,
    services: options.services,
    signal: options.signal ?? new AbortController().signal,
  });
}

/** Polls until a condition holds. Used to observe that a request is genuinely in flight before acting on it. */
export async function waitFor(condition: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise<void>((resolve) => { setTimeout(resolve, 2); });
  }
}

/** The payload of a native event, narrowed to an object for field assertions. */
export function payloadOf(event: DriverEvent): { [key: string]: Json } {
  if (event.type !== "native") throw new Error(`Expected a native event, saw ${event.type}.`);
  const payload = event.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Expected a native event payload object.");
  }
  return payload;
}

/** The payload of the first native event with one name. Absence is a test failure, not an empty object. */
export function nativePayload(services: RecordingServices, eventName: string): { [key: string]: Json } {
  const first = services.native(eventName)[0];
  if (first === undefined) {
    throw new Error(`No native "${eventName}" event was emitted; saw ${JSON.stringify(services.types)}.`);
  }
  return payloadOf(first);
}
