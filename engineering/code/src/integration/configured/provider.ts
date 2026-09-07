import type { IntegrationContext, IntegrationProvider, ModelResolution, ModelSelection, PermissionPolicy, ToolBinding, AuthorizationDecision } from "../../contracts/index.ts";
import { PnpError } from "../../core/errors.ts";
export interface ConfiguredModel {
  selection: ModelSelection;
  endpoint?: string;
  endpointEnvironment?: string;
  protocol: "openai-chat" | "anthropic-messages";
  headerEnvironment: Readonly<Record<string, string>>;
}
export class ConfiguredIntegration implements IntegrationProvider {
  readonly id = "configured";
  readonly developmentOnly = false;
  private readonly models: readonly ConfiguredModel[];
  private readonly tools: readonly ToolBinding[];
  private readonly policy: (operation: string) => AuthorizationDecision;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly strictModel: boolean;
  private readonly defaultSelection?: ModelSelection;
  /** The structure `policy` decides from, published on every context so an Engine Pack projects the same one. */
  private readonly permissions?: PermissionPolicy;
  constructor(models: readonly ConfiguredModel[], tools: readonly ToolBinding[] = [], policy: (operation: string) => AuthorizationDecision = () => ({ effect: "allow", reasonCode: "COMPETITION_DEFAULT_ALLOW" }), environment: NodeJS.ProcessEnv = process.env, strictModel = false, defaultSelection?: ModelSelection, permissions?: PermissionPolicy) {
    this.models = models; this.tools = tools; this.policy = policy; this.environment = environment; this.strictModel = strictModel; this.defaultSelection = defaultSelection; this.permissions = permissions;
  }
  private defaultModel(): ConfiguredModel {
    const configured = this.defaultSelection === undefined ? undefined : this.models.find((m) =>
      m.selection.providerID === this.defaultSelection?.providerID && m.selection.modelID === this.defaultSelection?.modelID);
    const fallback = configured ?? this.models[0];
    if (fallback === undefined) throw new PnpError("INTEGRATION_CONFIG_INVALID", "At least one model is required.", 503);
    return fallback;
  }
  private resolve(requested: ModelSelection): { model: ConfiguredModel; resolution: ModelResolution } {
    const wantsDefault = requested.providerID === "" && requested.modelID === "";
    const exact = wantsDefault ? undefined : this.models.find((m) => m.selection.providerID === requested.providerID && m.selection.modelID === requested.modelID);
    if (exact !== undefined) return { model: exact, resolution: { requested, outcome: "exact" } };
    if (!wantsDefault && this.strictModel) throw new PnpError("MODEL_NOT_ALLOWED", "Requested model is not configured.", 403);
    const fallback = this.defaultModel();
    if (wantsDefault) return { model: fallback, resolution: { requested, outcome: "default" } };
    console.warn(JSON.stringify({ event: "model.substituted", requested, selected: fallback.selection }));
    return { model: fallback, resolution: { requested, outcome: "substituted" } };
  }
  private endpointOf(model: ConfiguredModel): string {
    const endpoint = model.endpointEnvironment === undefined ? model.endpoint : this.environment[model.endpointEnvironment];
    if (endpoint === undefined || endpoint === "") throw model.endpointEnvironment === undefined
      ? new PnpError("INTEGRATION_CONFIG_INVALID", "The configured model has no endpoint.", 503)
      : new PnpError("MODEL_ENDPOINT_MISSING", "Required model endpoint environment variable is absent.", 503);
    let url: URL;
    try { url = new URL(endpoint); }
    catch { throw new PnpError("MODEL_ENDPOINT_INVALID", "Model endpoint is not a valid URL.", 400); }
    if (!(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new PnpError("INSECURE_MODEL_ENDPOINT", "Non-local model transport requires TLS.", 400);
    if (url.username || url.password) throw new PnpError("UNSAFE_MODEL_ENDPOINT", "Credentials are not allowed in a URL.", 400);
    return endpoint;
  }
  async probe(): Promise<void> {
    const defaultModel = this.defaultModel();
    const missing = [...(defaultModel.endpointEnvironment === undefined ? [] : [defaultModel.endpointEnvironment]), ...Object.values(defaultModel.headerEnvironment)]
      .filter((variable) => !this.environment[variable]);
    if (missing.length > 0) throw new PnpError("MODEL_ENVIRONMENT_MISSING", `The configured model settings name environment variables that are not set: ${[...new Set(missing)].join(", ")}.`, 503);
    this.endpointOf(defaultModel);
  }
  async prepare(input: Parameters<IntegrationProvider["prepare"]>[0]): Promise<IntegrationContext> {
    if (input.signal.aborted) throw new PnpError("EXECUTION_CANCELLED", "Model preparation was cancelled.", 409);
    const { model, resolution } = this.resolve(input.request.model);
    const endpoint = this.endpointOf(model);
    const headers: Record<string, string> = {};
    for (const [name, variable] of Object.entries(model.headerEnvironment)) {
      const value = this.environment[variable];
      if (!value) throw new PnpError("MODEL_AUTH_MISSING", "Required credential environment variable is absent.", 503);
      headers[name] = value;
    }
    return {
      model: { selection: model.selection, endpoint, protocol: model.protocol, headers, resolution },
      tools: this.tools, assets: [], authorize: async (request) => this.policy(request.operation),
      ...(this.permissions === undefined ? {} : { permissions: this.permissions }),
    };
  }
}
