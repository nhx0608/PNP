import type { AgentCapabilities, InitializeResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { Capability, EngineCapabilities } from "../../contracts/index.ts";
import { toJson } from "./json.ts";

export type Evidence = Capability["evidence"];

const rank: Record<Evidence, number> = { declared: 0, probed: 1, verified: 2 };

/**
 * Capability ledger for one ACP channel.
 *
 * A declaration in `initialize` only proves that the engine advertises an area (contracts.md section 8).
 * Evidence is raised to `probed` when the driver exercised the call and to `verified` when the driver
 * observed the promised effect. Evidence is never lowered and never inferred from documentation.
 */
export class AcpCapabilityLedger {
  private readonly records = new Map<string, Capability>();
  private readonly agent: AgentCapabilities;
  constructor(response: InitializeResponse) {
    this.agent = response.agentCapabilities ?? {};
    const session = this.agent.sessionCapabilities ?? {};
    const prompt = this.agent.promptCapabilities ?? {};
    const mcp = this.agent.mcpCapabilities ?? {};
    this.declare("acp.session.load", this.agent.loadSession === true, { configuration: "session", observation: "native" });
    this.declare("acp.session.resume", session.resume !== undefined && session.resume !== null, { configuration: "session" });
    this.declare("acp.session.close", session.close !== undefined && session.close !== null, { configuration: "session" });
    this.declare("acp.session.delete", session.delete !== undefined && session.delete !== null, { configuration: "session" });
    this.declare("acp.session.fork", session.fork !== undefined && session.fork !== null, { configuration: "session" });
    this.declare("acp.session.list", session.list !== undefined && session.list !== null, { configuration: "session" });
    this.declare("acp.session.additional_directories",
      session.additionalDirectories !== undefined && session.additionalDirectories !== null, { configuration: "session" });
    this.declare("acp.prompt.image", prompt.image === true, { configuration: "run" });
    this.declare("acp.prompt.audio", prompt.audio === true, { configuration: "run" });
    this.declare("acp.prompt.embedded_context", prompt.embeddedContext === true, { configuration: "run" });
    this.declare("acp.mcp.stdio", true, { configuration: "session", control: "tool" });
    this.declare("acp.mcp.http", mcp.http === true, { configuration: "session", control: "tool" });
    this.declare("acp.mcp.sse", mcp.sse === true, { configuration: "session", control: "tool" });
    // Streaming updates and session/cancel are mandatory in ACP v1; only observation can raise them past `declared`.
    this.declare("acp.session.update", true, { observation: "canonical" });
    this.declare("acp.session.cancel", true, { control: "extension", observation: "canonical" });
    this.declare("acp.session.permission", true, { control: "extension", observation: "canonical" });
    this.declare("acp.session.config_option", false, { configuration: "session" });
  }
  private declare(id: string, available: boolean, shape: Partial<Omit<Capability, "id" | "available" | "evidence">> = {}): void {
    this.records.set(id, {
      id, available, evidence: "declared",
      configuration: shape.configuration ?? "none",
      control: shape.control ?? "none",
      observation: shape.observation ?? "native",
      ...(shape.parameterSchema === undefined ? {} : { parameterSchema: shape.parameterSchema }),
    });
  }
  /** Records a configuration surface the engine reported after the session existed. */
  configOptions(options: readonly SessionConfigOption[]): void {
    const record = this.records.get("acp.session.config_option");
    if (record === undefined) return;
    this.records.set("acp.session.config_option", {
      ...record, available: options.length > 0, evidence: options.length > 0 ? "probed" : record.evidence,
      parameterSchema: toJson(options.map((option) => ({ id: option.id, category: option.category ?? null, type: option.type }))),
    });
  }
  /** Raises evidence for an exercised capability. Availability is only ever confirmed, never invented. */
  observe(id: string, evidence: Evidence, available?: boolean): void {
    const record = this.records.get(id);
    if (record === undefined) return;
    this.records.set(id, {
      ...record,
      available: available ?? record.available,
      evidence: rank[evidence] > rank[record.evidence] ? evidence : record.evidence,
    });
  }
  get(id: string): Capability | undefined {
    const record = this.records.get(id);
    return record === undefined ? undefined : { ...record };
  }
  snapshot(): EngineCapabilities {
    return {
      sessionResume: this.records.get("acp.session.load")?.available === true,
      streaming: this.records.get("acp.session.update")?.available === true,
      cancellation: this.records.get("acp.session.cancel")?.available === true,
      nativeDelete: this.records.get("acp.session.delete")?.available === true,
      extensions: [...this.records.values()].map((record) => ({ ...record })),
    };
  }
}
