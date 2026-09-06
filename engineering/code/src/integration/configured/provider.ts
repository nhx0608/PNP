import type { IntegrationContext, IntegrationProvider, ModelSelection, ToolBinding, AuthorizationDecision } from "../../contracts/index.ts";
import { PnpError } from "../../core/errors.ts";
export interface ConfiguredModel {
  selection: ModelSelection;
  endpoint: string;
  protocol: "openai-chat" | "anthropic-messages";
  headerEnvironment: Readonly<Record<string, string>>;
}
/** No business identity logic. Useful for adapter development with an approved test endpoint. */
export class ConfiguredIntegration implements IntegrationProvider {
  readonly id = "configured";
  readonly developmentOnly = false;
  private readonly models: readonly ConfiguredModel[];
  private readonly tools: readonly ToolBinding[];
  private readonly policy: (operation: string) => AuthorizationDecision;
  private readonly environment: NodeJS.ProcessEnv;
  // Competition default is allow; deny is reserved for policy that explicitly opts in (see
  // config/configured.example.json). This does not weaken an explicit organizational deny: a
  // policy function derived from actual config (loadIntegration) always wins over this default.
  constructor(models: readonly ConfiguredModel[], tools: readonly ToolBinding[] = [], policy: (operation: string) => AuthorizationDecision = () => ({ effect: "allow", reasonCode: "COMPETITION_DEFAULT_ALLOW" }), environment: NodeJS.ProcessEnv = process.env) {
    this.models = models; this.tools = tools; this.policy = policy; this.environment = environment;
  }
  /** Optional startup probe (see `probeIntegration` in ../index.ts). Confirms the credential
   *  environment variables referenced by the default model are currently resolvable, without
   *  caching any resolved secret value — headers are still re-resolved fresh on every prepare(). */
  async probe(): Promise<void> {
    const [defaultModel] = this.models;
    if (defaultModel === undefined) throw new PnpError("INTEGRATION_CONFIG_INVALID", "At least one model is required.", 503);
    for (const variable of Object.values(defaultModel.headerEnvironment)) {
      if (!this.environment[variable]) throw new PnpError("MODEL_AUTH_MISSING", "Required credential environment variable is absent.", 503);
    }
  }
  async prepare(input: Parameters<IntegrationProvider["prepare"]>[0]): Promise<IntegrationContext> {
    if (input.signal.aborted) throw new PnpError("EXECUTION_CANCELLED", "Model preparation was cancelled.", 409);
    const requested = input.request.model;
    // The gateway route sends this sentinel when the caller omitted `model`; pick the first
    // configured model as the default rather than rejecting the request.
    const wantsDefault = requested.providerID === "" && requested.modelID === "";
    const model = wantsDefault ? this.models[0]
      : this.models.find((m) => m.selection.providerID === requested.providerID && m.selection.modelID === requested.modelID);
    if (!model) throw new PnpError("MODEL_NOT_ALLOWED", "Requested model is not configured.", 403);
    const url = new URL(model.endpoint);
    if (!(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new PnpError("INSECURE_MODEL_ENDPOINT", "Non-local model transport requires TLS.", 400);
    if (url.username || url.password) throw new PnpError("UNSAFE_MODEL_ENDPOINT", "Credentials are not allowed in a URL.", 400);
    const headers: Record<string, string> = {};
    for (const [name, variable] of Object.entries(model.headerEnvironment)) {
      const value = this.environment[variable];
      if (!value) throw new PnpError("MODEL_AUTH_MISSING", "Required credential environment variable is absent.", 503);
      headers[name] = value;
    }
    return { model: { selection: model.selection, endpoint: model.endpoint, protocol: model.protocol, headers },
      tools: this.tools, assets: [], authorize: async (request) => this.policy(request.operation) };
  }
}
