import { AGENT_METHODS, CLIENT_METHODS, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type {
  AgentCapabilities, InitializeResponse, PromptResponse, RequestPermissionRequest, RequestPermissionResponse,
  SessionConfigOption, SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { FakeAgent, MethodHandler, NO_REPLY } from "../../kit/fake-host.ts";

export const NATIVE_SESSION = "acp-session-42";

export function initializeResponse(overrides: {
  protocolVersion?: number;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: { name: string; version: string };
} = {}): InitializeResponse {
  return {
    protocolVersion: overrides.protocolVersion ?? PROTOCOL_VERSION,
    agentCapabilities: overrides.agentCapabilities ?? {},
    ...(overrides.agentInfo === undefined ? {} : { agentInfo: overrides.agentInfo }),
  };
}

export function modelOption(overrides: {
  id?: string;
  currentValue?: string;
  values?: readonly string[];
  category?: string;
} = {}): SessionConfigOption {
  return {
    id: overrides.id ?? "model",
    name: "Model",
    category: overrides.category ?? "model",
    type: "select",
    currentValue: overrides.currentValue ?? "base-model",
    options: (overrides.values ?? ["base-model", "test-model"]).map((value) => ({ value, name: value })),
  };
}

/** Emits one session/update notification for the session under test. */
export function update(agent: FakeAgent, value: SessionUpdate, sessionId = NATIVE_SESSION): void {
  agent.notify(CLIENT_METHODS.session_update, { sessionId, update: value });
}

/** Asks the driver for permission on behalf of the engine. */
export function askPermission(agent: FakeAgent, request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
  return agent.request<RequestPermissionResponse>(CLIENT_METHODS.session_request_permission, request);
}

export function permissionRequest(overrides: {
  toolCallId?: string;
  name?: string;
  options?: RequestPermissionRequest["options"];
} = {}): RequestPermissionRequest {
  return {
    sessionId: NATIVE_SESSION,
    toolCall: { toolCallId: overrides.toolCallId ?? "call-1", title: "Write a file", name: overrides.name ?? "write" },
    options: overrides.options ?? [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  };
}

export function promptResponse(overrides: Partial<PromptResponse> = {}): PromptResponse {
  return { stopReason: "end_turn", ...overrides };
}

export interface HeldPrompt {
  handler(params: unknown, agent: FakeAgent): Promise<PromptResponse>;
  /** The engine finally answers the prompt. */
  release(response: PromptResponse): void;
  /** The engine answers with a JSON-RPC failure. */
  fail(error: unknown): void;
}

/** A prompt the engine has accepted but not answered: the state every cancellation path starts from. */
export function heldPrompt(): HeldPrompt {
  let settle: ((response: PromptResponse) => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  const answer = new Promise<PromptResponse>((resolve, fail) => { settle = resolve; reject = fail; });
  return {
    handler: (): Promise<PromptResponse> => answer,
    release: (response: PromptResponse): void => { settle?.(response); },
    fail: (error: unknown): void => { reject?.(error); },
  };
}

export interface ScriptOptions {
  initialize?: InitializeResponse;
  /** Config options returned by session/new. */
  configOptions?: readonly SessionConfigOption[];
  sessionId?: string;
  /** Everything the engine does while a prompt is in flight, before it answers, or NO_REPLY for silence. */
  prompt?(params: unknown, agent: FakeAgent): PromptResponse | Promise<PromptResponse> | typeof NO_REPLY;
}

/**
 * A well-behaved ACP agent: it answers initialize and session/new, and runs the test's prompt script.
 * Each handler is replaceable through FakeAgent.on for tests that need a misbehaving engine.
 */
export function baseScript(options: ScriptOptions = {}): Record<string, MethodHandler> {
  const sessionId = options.sessionId ?? NATIVE_SESSION;
  return {
    [AGENT_METHODS.initialize]: (): InitializeResponse => options.initialize ?? initializeResponse(),
    [AGENT_METHODS.session_new]: (): { sessionId: string; configOptions: SessionConfigOption[] } => ({
      sessionId, configOptions: [...(options.configOptions ?? [])],
    }),
    [AGENT_METHODS.session_prompt]: (params: unknown, agent: FakeAgent): unknown =>
      options.prompt?.(params, agent) ?? promptResponse(),
    [AGENT_METHODS.session_cancel]: (): null => null,
  };
}
