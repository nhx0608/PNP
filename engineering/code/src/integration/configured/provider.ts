import type { IntegrationContext, IntegrationProvider, ModelResolution, ModelSelection, ToolBinding, AuthorizationDecision } from "../../contracts/index.ts";
import { PnpError } from "../../core/errors.ts";
export interface ConfiguredModel {
  selection: ModelSelection;
  /** Exactly one of these two is set (the profile parser enforces it): a literal URL, or the NAME
   *  of an environment variable that holds it. The shipped profile uses the variable form so a
   *  public repository never carries a deployment address, the same way headers already work. */
  endpoint?: string;
  endpointEnvironment?: string;
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
  private readonly strictModel: boolean;
  // Competition default is allow; deny is reserved for policy that explicitly opts in (see
  // config/configured.example.json). This does not weaken an explicit organizational deny: a
  // policy function derived from actual config (loadIntegration) always wins over this default.
  constructor(models: readonly ConfiguredModel[], tools: readonly ToolBinding[] = [], policy: (operation: string) => AuthorizationDecision = () => ({ effect: "allow", reasonCode: "COMPETITION_DEFAULT_ALLOW" }), environment: NodeJS.ProcessEnv = process.env, strictModel = false) {
    this.models = models; this.tools = tools; this.policy = policy; this.environment = environment; this.strictModel = strictModel;
  }
  /**
   * Resolves the caller's selection against the profile. The profile -- not the request -- is the
   * endpoint allow-list, so falling back to its default model cannot widen any access: the request
   * only ever supplies a name (see docs/engineering-review-3.md section 7, R2). `PNP_MODEL_STRICT=1`
   * restores the 403 for a deployment that would rather fail the request than answer it on a model
   * the caller did not name.
   */
  private resolve(requested: ModelSelection): { model: ConfiguredModel; resolution: ModelResolution } {
    // The gateway route sends this sentinel when the caller omitted `model`.
    const wantsDefault = requested.providerID === "" && requested.modelID === "";
    const exact = wantsDefault ? undefined
      : this.models.find((m) => m.selection.providerID === requested.providerID && m.selection.modelID === requested.modelID);
    if (exact !== undefined) return { model: exact, resolution: { requested, outcome: "exact" } };
    if (!wantsDefault && this.strictModel) throw new PnpError("MODEL_NOT_ALLOWED", "Requested model is not configured.", 403);
    const fallback = this.models[0];
    if (fallback === undefined) throw new PnpError("INTEGRATION_CONFIG_INVALID", "At least one model is required.", 503);
    if (wantsDefault) return { model: fallback, resolution: { requested, outcome: "default" } };
    // Identifiers only: a name the caller chose is not a credential, and the selected model's
    // endpoint and headers stay out of the record.
    console.warn(JSON.stringify({ event: "model.substituted", requested, selected: fallback.selection }));
    return { model: fallback, resolution: { requested, outcome: "substituted" } };
  }
  /**
   * Resolves the model's endpoint and applies the transport rule to whatever came back: https
   * anywhere, http on loopback only, never credentials in the URL. A variable-backed endpoint is
   * checked here rather than at load time because the value only exists in the process
   * environment. Neither the value nor any part of it appears in a thrown message.
   */
  private endpointOf(model: ConfiguredModel): string {
    const endpoint = model.endpointEnvironment === undefined
      ? model.endpoint
      : this.environment[model.endpointEnvironment];
    if (endpoint === undefined || endpoint === "") {
      throw model.endpointEnvironment === undefined
        ? new PnpError("INTEGRATION_CONFIG_INVALID", "The configured model has no endpoint.", 503)
        : new PnpError("MODEL_ENDPOINT_MISSING", "Required model endpoint environment variable is absent.", 503);
    }
    let url: URL;
    try { url = new URL(endpoint); }
    catch { throw new PnpError("MODEL_ENDPOINT_INVALID", "Model endpoint is not a valid URL.", 400); }
    if (!(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new PnpError("INSECURE_MODEL_ENDPOINT", "Non-local model transport requires TLS.", 400);
    if (url.username || url.password) throw new PnpError("UNSAFE_MODEL_ENDPOINT", "Credentials are not allowed in a URL.", 400);
    return endpoint;
  }
  /** Optional startup probe (see `probeIntegration` in ../index.ts). Confirms that every
   *  environment variable the default model names — its endpoint and its headers — is currently
   *  resolvable, and that the resolved endpoint is an approved transport. Startup output is read
   *  by the operator, so the message names the missing VARIABLES; no value is ever read out, kept
   *  or logged, and headers are still re-resolved fresh on every prepare(). */
  async probe(): Promise<void> {
    const [defaultModel] = this.models;
    if (defaultModel === undefined) throw new PnpError("INTEGRATION_CONFIG_INVALID", "At least one model is required.", 503);
    const missing = [
      ...(defaultModel.endpointEnvironment === undefined ? [] : [defaultModel.endpointEnvironment]),
      ...Object.values(defaultModel.headerEnvironment),
    ].filter((variable) => !this.environment[variable]);
    if (missing.length > 0) {
      throw new PnpError("MODEL_ENVIRONMENT_MISSING",
        `The configured integration profile names environment variables that are not set: ${[...new Set(missing)].join(", ")}.`, 503);
    }
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
    return { model: { selection: model.selection, endpoint, protocol: model.protocol, headers, resolution },
      tools: this.tools, assets: [], authorize: async (request) => this.policy(request.operation) };
  }
}
