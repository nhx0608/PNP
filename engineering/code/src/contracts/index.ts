import type { ProcessHost } from "./host.ts";
/** PNP public implementation boundary. Breaking changes require a contract version change. */
export const CONTRACT_VERSION = "1.1.0";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type RunState = "running" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted";
export type TerminalState = Exclude<RunState, "running" | "cancelling">;
export type StopReason = "user" | "deadline" | "shutdown";
export type MessageFinish = "stop" | "tool-calls" | "length" | "error" | "content-filter" | "unknown" | "cancelled" | "interrupted";
export interface ModelSelection { providerID: string; modelID: string }
export interface PromptRequest {
  parts: { type: "text"; text: string }[];
  model: ModelSelection;
  agent?: string;
}
export interface NativeSessionRef {
  nativeId: string;
  channelId: string;
  engineVersion: string;
  protocolVersion?: string;
  /** An opaque non-secret identifier, not a credential or bearer token. */
  resumeToken?: string;
}
export interface Session {
  id: string;
  title: string;
  directory: string;
  /** The gateway created `directory` for this session. Deleting the session never removes it. */
  directoryCreated?: boolean;
  engineId: string;
  channelId: string;
  lifecycle: "active" | "deleting";
  status: "idle" | "busy";
  recovery: "ready" | "needs-native-resume" | "blocked";
  native?: NativeSessionRef;
  createdAt: string;
  updatedAt: string;
}
export interface Run {
  id: string;
  sessionId: string;
  state: RunState;
  requestHash: string;
  idempotencyKey?: string;
  startedAt: string;
  finishedAt?: string;
  errorCode?: string;
  nativeStopReason?: string;
  taskOutcome?: "unknown" | "succeeded" | "failed";
}
export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  created_at: string;
  tool_call_id?: string;
  tool_name?: string;
  tool_calls?: { id: string; name: string; arguments: Json }[];
  info?: { role: "assistant"; finish: MessageFinish; nativeFinish?: string };
  parts?: Json[];
}
export interface PublicEvent {
  sequence: number;
  type: string;
  properties: { [key: string]: Json };
}
export type DriverEvent =
  | { type: "text.delta"; text: string; nativeType?: string }
  | { type: "tool.started"; callId: string; name: string; input: Json }
  | { type: "tool.updated"; callId: string; title: string }
  | { type: "tool.finished"; callId: string; name: string; output: Json; failed: boolean }
  /**
   * A driver observation is not necessarily a completed canonical tool result.
   * `content` and `locations` preserve native partial facts for clients that
   * understand them; their presence (including an empty array) is meaningful.
   */
  | ({
    type: "tool.observed";
    callId: string;
    source: "engine";
    title?: string;
    /** The call's identity. A driver resolves it once and repeats it; it never changes mid-call. */
    name?: string;
    /**
     * Contract 1.1.0, additive and optional: where `name` came from. `name` is the engine's programmatic
     * field; `announced-title` is the title the call was announced under, which for some engines is the
     * only label a call ever carries. Absent means the driver stated no provenance for `name`. A later
     * display title is reported as `title` and never renames the call.
     */
    nameSource?: "name" | "announced-title";
    input?: Json;
    output?: Json;
    content?: Json[];
    locations?: Json[];
    nativeType?: string;
    nativeStatus?: string;
  } & (
    | { phase: "created" | "updated"; status?: "pending" | "running" | "completed" | "failed" }
    | { phase: "terminal"; status: "completed" | "failed" }
  ))
  | { type: "usage"; inputTokens?: number; outputTokens?: number; source: "provider" | "engine" | "estimate" }
  | { type: "native"; namespace: string; eventName: string; payload: Json };
export interface EventSink {
  /** Await delivery; rejection stops the current execution. Detached emits are forbidden. */
  emit(event: DriverEvent): Promise<void>;
}
export interface Capability {
  id: string;
  available: boolean;
  configuration: "none" | "session" | "run";
  control: "none" | "tool" | "extension";
  observation: "none" | "native" | "canonical";
  evidence: "declared" | "probed" | "verified";
  parameterSchema?: Json;
}
export interface EngineCapabilities {
  sessionResume: boolean;
  streaming: boolean;
  cancellation: boolean;
  nativeDelete: boolean;
  extensions: Capability[];
}
export interface EngineDescriptor {
  id: string;
  channelId: string;
  transport: "acp" | "pi-rpc" | "test";
  contractVersion: typeof CONTRACT_VERSION;
  developmentOnly: boolean;
  implementationProvided: boolean;
}
export interface StopEvidence {
  /** Describes owned execution resources. It does not undo external business side effects. */
  quiescent: boolean;
  method: "protocol" | "process-tree" | "not-running";
}
export interface EngineResult {
  state: "completed" | "failed" | "cancelled";
  /**
   * True only when the Driver verified that this turn's execution resources stopped. False reports a real
   * terminal turn whose resources are unproven; Core then takes process-level evidence via terminate().
   * Never report true to avoid termination.
   */
  quiescent: boolean;
  finalText: string;
  finish: Exclude<MessageFinish, "tool-calls" | "interrupted">;
  nativeStopReason: string;
  taskOutcome: "unknown" | "succeeded" | "failed";
}
export interface InteractionRequest {
  kind: "permission" | "question";
  operation: string;
  payload: Json;
}
export interface InteractionResponse {
  decision: "allow" | "deny" | "answer";
  answers?: string[][];
  /**
   * Lets an adapter separate an organisation refusal from an unanswered request. `auto` is the
   * gateway answering a question itself under an unattended question policy, and `remembered` is a
   * permission the user already allowed for this session and operation; both are still gateway
   * decisions, and neither can override an organisational deny.
   */
  source?: "policy" | "user" | "timeout" | "cancelled" | "auto" | "remembered";
  reasonCode?: string;
}
export interface AuthorizationDecision {
  effect: "allow" | "deny" | "ask";
  reasonCode: string;
}
export type PermissionEffect = AuthorizationDecision["effect"];
export interface PermissionPolicy {
  default: PermissionEffect;
  operations: Readonly<Record<string, PermissionEffect>>;
}
export interface DriverServices {
  events: EventSink;
  interact(request: InteractionRequest): Promise<InteractionResponse>;
}
/**
 * How a caller's `model` became the model that actually ran. The specification makes
 * `model.providerID/modelID` required and the caller supplies identifiers the deployment does not
 * control, so an unconfigured selection resolves to the profile's default instead of failing the
 * whole round; this record is what makes that substitution auditable. It carries selection
 * identifiers only, never an endpoint or a credential.
 */
export interface ModelResolution {
  requested: ModelSelection;
  /** `exact`: the request named a configured model. `default`: the request named none.
   *  `substituted`: the request named one that is not configured. */
  outcome: "exact" | "default" | "substituted";
}
export interface ResolvedModel {
  selection: ModelSelection;
  protocol: "openai-chat" | "anthropic-messages" | "custom" | "test";
  endpoint?: string;
  /** Never persist or log resolved model configuration. */
  headers: Readonly<Record<string, string>>;
  /** Absolute path of a PEM bundle the engine process must trust for this endpoint. */
  caFile?: string;
  /**
   * Contract 1.1.0, additive and optional: the deployment asked for certificate verification to be
   * switched off for this model (`PNP_MODEL_TLS_INSECURE=1`). It is a last-resort deployment
   * decision, never a default and never inferred from a failed handshake; absent means verify.
   */
  tlsInsecure?: boolean;
  /** Absent means the provider does not report a resolution; callers treat that as `exact`. */
  resolution?: ModelResolution;
}
export type ToolSideEffect = "read" | "write" | "external";
/** What every tool binding carries, whichever transport reaches the tool. */
export interface ToolBindingCommon {
  id: string;
  sideEffect: ToolSideEffect;
  inputSchema?: Json;
  timeoutMs?: number;
}
/** A tool the gateway starts as a local process. */
export interface CommandToolBinding extends ToolBindingCommon {
  transport: "mcp-stdio" | "cli" | "native";
  /** Executable and arguments come from trusted configuration, never a user prompt. */
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}
/**
 * An MCP server reached over Streamable HTTP. `url` and `headers` are resolved values, not variable
 * names: the binding is per-run credential material, so it is never persisted, logged or put into an
 * error message.
 */
export interface HttpToolBinding extends ToolBindingCommon {
  transport: "mcp-http";
  url: string;
  headers: Readonly<Record<string, string>>;
}
/**
 * The transport decides which fields exist, so a driver that projects one cannot read a field the
 * other kind never had. A binding the native channel cannot carry is dropped and reported, never
 * projected onto a different transport.
 */
export type ToolBinding = CommandToolBinding | HttpToolBinding;
export interface AssetBinding {
  id: string;
  kind: "instruction" | "skill" | "native-extension";
  path: string;
  sha256: string;
  required: boolean;
  parameters?: Json;
}
export interface IntegrationContext {
  model: ResolvedModel;
  tools: readonly ToolBinding[];
  assets: readonly AssetBinding[];
  /** Policy does not execute an Agent loop. Deny cannot be overridden by a user reply. */
  authorize(request: InteractionRequest): Promise<AuthorizationDecision>;
  /**
   * The effective operation policy this context authorizes with, deployment overrides already applied, so an
   * Engine Pack can project it into native configuration without reading any settings source itself. Absent
   * when the provider has no static policy.
   */
  permissions?: PermissionPolicy;
}
export interface IntegrationProvider {
  readonly id: string;
  readonly developmentOnly: boolean;
  prepare(input: { session: Session; request: PromptRequest; signal: AbortSignal }): Promise<IntegrationContext>;
  /** Releases per-run credentials, temporary configuration and scoped resources. */
  release?(context: IntegrationContext): Promise<void>;
}
export interface ResourceScope {
  /** Register before acquiring a resource. A closed scope rejects further acquisition. */
  register(id: string, stop: () => Promise<StopEvidence>): void;
  /** Drop an owned resource only after its caller has obtained quiescent evidence. */
  retire?(id: string, evidence: StopEvidence): void;
  readonly closed: boolean;
}
export interface EngineOpenInput {
  /** Shared host with the gateway ownership directory; adapters must not construct their own host. */
  host: ProcessHost;
  session: Session;
  nativeDataDirectory: string;
  integration: IntegrationContext;
  resources: ResourceScope;
  signal: AbortSignal;
}
export interface EngineSessionChannel {
  readonly native: NativeSessionRef;
  readonly capabilities: EngineCapabilities;
  run(input: {
    runId: string;
    request: PromptRequest;
    integration: IntegrationContext;
    services: DriverServices;
    signal: AbortSignal;
  }): Promise<EngineResult>;
  /** Request ACK is not completion evidence. */
  cancel(reason: StopReason): Promise<void>;
  terminate(): Promise<StopEvidence>;
  /** Preserves native history; only owned execution resources are closed. */
  close(): Promise<StopEvidence>;
}
export interface EnginePack {
  readonly descriptor: EngineDescriptor;
  open(input: EngineOpenInput): Promise<EngineSessionChannel>;
  /** Removes engine-owned history only; it must not modify the user's workspace. */
  purge?(input: { session: Session; nativeDataDirectory: string }): Promise<void>;
}
