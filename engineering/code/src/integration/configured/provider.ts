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
  constructor(models: readonly ConfiguredModel[], tools: readonly ToolBinding[] = [], policy: (operation: string) => AuthorizationDecision = () => ({ effect: "deny", reasonCode: "DEFAULT_DENY" })) {
    this.models = models; this.tools = tools; this.policy = policy;
  }
  async prepare(input: Parameters<IntegrationProvider["prepare"]>[0]): Promise<IntegrationContext> {
    if (input.signal.aborted) throw new PnpError("EXECUTION_CANCELLED", "Model preparation was cancelled.", 409);
    const model = this.models.find((m) => m.selection.providerID === input.request.model.providerID && m.selection.modelID === input.request.model.modelID);
    if (!model) throw new PnpError("MODEL_NOT_ALLOWED", "Requested model is not configured.", 403);
    const url = new URL(model.endpoint);
    if (!(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new PnpError("INSECURE_MODEL_ENDPOINT", "Non-local model transport requires TLS.", 400);
    if (url.username || url.password) throw new PnpError("UNSAFE_MODEL_ENDPOINT", "Credentials are not allowed in a URL.", 400);
    const headers: Record<string, string> = {};
    for (const [name, variable] of Object.entries(model.headerEnvironment)) {
      const value = process.env[variable];
      if (!value) throw new PnpError("MODEL_AUTH_MISSING", "Required credential environment variable is absent.", 503);
      headers[name] = value;
    }
    return { model: { selection: model.selection, endpoint: model.endpoint, protocol: model.protocol, headers },
      tools: this.tools, assets: [], authorize: async (request) => this.policy(request.operation) };
  }
}
