import path from "node:path";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { AssetBinding, IntegrationContext, IntegrationProvider, ModelResolution, ModelSelection, PermissionPolicy, ToolBinding, AuthorizationDecision } from "../../contracts/index.ts";
import { isApprovedEndpoint, resolveCodePath } from "../../config/settings.ts";
import { resolveAsset } from "../../assets/resolver.ts";
import { PnpError } from "../../core/errors.ts";
/** A variable holding nothing but blanks names nothing. Load, probe and prepare all read it the same
 *  way, so a variable exported without a value cannot be "set" for one of them and unset for another. */
function unset(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}
export interface ConfiguredModel {
  selection: ModelSelection;
  /** Exactly one of these two is set (the settings parser enforces it): a literal URL, or the NAME
   *  of an environment variable that holds it. The shipped settings use the variable form so a
   *  public repository never carries a deployment address, the same way headers already work. */
  endpoint?: string;
  endpointEnvironment?: string;
  protocol: "openai-chat" | "anthropic-messages";
  headerEnvironment: Readonly<Record<string, string>>;
  /** The variable whose value already replaced `selection.modelID` at load, kept so a prompt on this
   *  model still fails by name when the variable is absent. */
  modelIDEnvironment?: string;
  apiKeyEnvironment?: string;
  headersEnvironment?: string;
  caFileEnvironment?: string;
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
  private readonly defaultSelection?: ModelSelection;
  /** The structure `policy` decides from, published on every context so an Engine Pack projects the same one. */
  private readonly permissions?: PermissionPolicy;
  /** Absolute instruction files from the effective settings, in declaration order. */
  private readonly instructions: readonly string[];
  // Competition default is allow; deny is reserved for policy that explicitly opts in (see
  // config/settings.json). This does not weaken an explicit organizational deny: a policy function
  // derived from actual settings (loadIntegration) always wins over this default.
  constructor(models: readonly ConfiguredModel[], tools: readonly ToolBinding[] = [], policy: (operation: string) => AuthorizationDecision = () => ({ effect: "allow", reasonCode: "COMPETITION_DEFAULT_ALLOW" }), environment: NodeJS.ProcessEnv = process.env, strictModel = false, defaultSelection?: ModelSelection, permissions?: PermissionPolicy, instructions: readonly string[] = []) {
    this.models = models; this.tools = tools; this.policy = policy; this.environment = environment; this.strictModel = strictModel; this.defaultSelection = defaultSelection; this.permissions = permissions; this.instructions = instructions;
  }
  private defaultModel(): ConfiguredModel {
    const configured = this.defaultSelection === undefined ? undefined : this.models.find((m) =>
      m.selection.providerID === this.defaultSelection?.providerID && m.selection.modelID === this.defaultSelection?.modelID);
    const fallback = configured ?? this.models[0];
    if (fallback === undefined) throw new PnpError("INTEGRATION_CONFIG_INVALID", "At least one model is required.", 503);
    return fallback;
  }
  /**
   * Resolves the caller's selection against the effective settings. The settings -- not the request -- are the
   * endpoint allow-list, so falling back to the effective default model cannot widen any access: the request
   * only ever supplies a name (see docs/engineering-review-3.md section 7, R2). `PNP_MODEL_STRICT=1`
   * restores the 403 for a deployment that would rather fail the request than answer it on a model
   * the caller did not name.
   */
  private resolve(requested: ModelSelection): { model: ConfiguredModel; resolution: ModelResolution } {
    // The gateway route sends this sentinel when the caller omitted `model`.
    const wantsDefault = requested.providerID === "" && requested.modelID === "";
    const exact = wantsDefault ? undefined : this.models.find((m) => m.selection.providerID === requested.providerID && m.selection.modelID === requested.modelID);
    if (exact !== undefined) return { model: exact, resolution: { requested, outcome: "exact" } };
    if (!wantsDefault && this.strictModel) throw new PnpError("MODEL_NOT_ALLOWED", "Requested model is not configured.", 403);
    const fallback = this.defaultModel();
    if (wantsDefault) return { model: fallback, resolution: { requested, outcome: "default" } };
    // Identifiers only: a name the caller chose is not a credential, and the selected model's
    // endpoint and headers stay out of the record.
    console.warn(JSON.stringify({ event: "model.substituted", requested, selected: fallback.selection }));
    return { model: fallback, resolution: { requested, outcome: "substituted" } };
  }
  /**
   * Resolves the model's endpoint and applies the shared transport rule to whatever came back:
   * https anywhere, http on loopback, http elsewhere only when the deployment set
   * `PNP_ALLOW_HTTP_ENDPOINTS=1`, never credentials in the URL. A variable-backed endpoint is
   * checked here rather than at load time because the value only exists in the process environment.
   * Neither the value nor any part of it appears in a thrown message.
   */
  private endpointOf(model: ConfiguredModel): string {
    const endpoint = model.endpointEnvironment === undefined ? model.endpoint : this.environment[model.endpointEnvironment];
    if (endpoint === undefined || endpoint === "") throw model.endpointEnvironment === undefined
      ? new PnpError("INTEGRATION_CONFIG_INVALID", "The configured model has no endpoint.", 503)
      : new PnpError("MODEL_ENDPOINT_MISSING", "Required model endpoint environment variable is absent.", 503);
    let url: URL;
    try { url = new URL(endpoint); }
    catch { throw new PnpError("MODEL_ENDPOINT_INVALID", "Model endpoint is not a valid URL.", 400); }
    if (url.username || url.password) throw new PnpError("UNSAFE_MODEL_ENDPOINT", "Credentials are not allowed in a URL.", 400);
    if (!isApprovedEndpoint(url, this.environment)) throw new PnpError("INSECURE_MODEL_ENDPOINT", "Non-local model transport requires TLS.", 400);
    return endpoint;
  }
  /**
   * The model identifier the endpoint expects. A settings entry may name a variable for it, because
   * the deployment -- not this repository -- knows what the intranet endpoint calls its model. The
   * substitution already happened at load, so the whole gateway (the trace, `model.resolved`, the
   * driver) sees one identifier; this is the guard for the entry whose variable is still absent.
   */
  private modelIdOf(model: ConfiguredModel): string {
    if (model.modelIDEnvironment !== undefined && unset(this.environment[model.modelIDEnvironment])) {
      throw new PnpError("MODEL_ENVIRONMENT_MISSING",
        `The configured model settings name environment variables that are not set: ${model.modelIDEnvironment}.`, 503);
    }
    return model.selection.modelID;
  }
  /**
   * The request headers for one turn, assembled from the three sources in a fixed order:
   * `headerEnvironment` (each named variable required), then `headersEnvironment` (one variable
   * holding a JSON object, for an appid or a tenant header), then `apiKeyEnvironment`, which adds
   * `Authorization: Bearer <value>` only when nothing above already set an Authorization header --
   * compared case-insensitively, because a header name is case-insensitive and a deployment that
   * wrote `authorization` must not end up sending two of them. Messages name variables, never values.
   */
  private headersOf(model: ConfiguredModel): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [name, variable] of Object.entries(model.headerEnvironment)) {
      const value = this.environment[variable];
      if (!value) throw new PnpError("MODEL_AUTH_MISSING", "Required credential environment variable is absent.", 503);
      headers[name] = value;
    }
    if (model.headersEnvironment !== undefined) {
      const raw = this.environment[model.headersEnvironment];
      if (!unset(raw)) {
        let parsed: unknown;
        try { parsed = JSON.parse(raw!); }
        catch { throw new PnpError("MODEL_ENVIRONMENT_INVALID", `${model.headersEnvironment} must hold a JSON object of headers.`, 503); }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new PnpError("MODEL_ENVIRONMENT_INVALID", `${model.headersEnvironment} must hold a JSON object of headers.`, 503);
        }
        for (const [name, value] of Object.entries(parsed)) {
          if (typeof value !== "string") {
            throw new PnpError("MODEL_ENVIRONMENT_INVALID", `${model.headersEnvironment} must hold string header values.`, 503);
          }
          headers[name] = value;
        }
      }
    }
    if (model.apiKeyEnvironment !== undefined) {
      const key = this.environment[model.apiKeyEnvironment];
      const declared = Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
      // An unset key is not an error: an intranet endpoint that authenticates by header or by
      // network position is a normal deployment, and inventing an empty Bearer would only fail later.
      if (!unset(key) && !declared) headers.Authorization = `Bearer ${key!}`;
    }
    return headers;
  }
  /** The PEM bundle this model needs, absolute. A relative path is taken from the package root, the
   *  one directory a deployment can name without knowing where the delivery was unpacked. */
  private caFileOf(model: ConfiguredModel): string | undefined {
    if (model.caFileEnvironment === undefined) return undefined;
    const raw = this.environment[model.caFileEnvironment];
    if (unset(raw)) return undefined;
    return resolveCodePath(raw!.trim());
  }
  /** Instruction assets for this turn, content-addressed by the shared resolver. The settings file is
   *  trusted deployment configuration and names each file directly, including one outside the
   *  package, so the file's own directory is the resolver root: what it contributes here is the
   *  digest and the bounded-regular-file check, not a containment boundary the settings never had. */
  private async instructionAssets(): Promise<AssetBinding[]> {
    const assets: AssetBinding[] = [];
    for (const file of this.instructions) {
      assets.push(await resolveAsset(path.dirname(file), {
        id: `instruction:${path.basename(file, path.extname(file))}`,
        kind: "instruction", path: path.basename(file), required: true,
      }));
    }
    return assets;
  }
  /** Optional startup probe (see `probeIntegration` in ../index.ts). Confirms that every
   *  environment variable the default model requires — its endpoint, its model identifier and its
   *  headers — is currently resolvable, that the resolved endpoint is an approved transport, that
   *  an extra-headers variable holds what it claims, and that a named CA bundle is actually there.
   *  Startup output is read by the operator, so a message names the missing VARIABLES; no value is
   *  ever read out, kept or logged, and headers are still re-resolved fresh on every prepare(). */
  async probe(): Promise<void> {
    const defaultModel = this.defaultModel();
    const required = [
      ...(defaultModel.endpointEnvironment === undefined ? [] : [defaultModel.endpointEnvironment]),
      ...(defaultModel.modelIDEnvironment === undefined ? [] : [defaultModel.modelIDEnvironment]),
      ...Object.values(defaultModel.headerEnvironment),
    ];
    const missing = required.filter((variable) => unset(this.environment[variable]));
    if (missing.length > 0) throw new PnpError("MODEL_ENVIRONMENT_MISSING", `The configured model settings name environment variables that are not set: ${[...new Set(missing)].join(", ")}.`, 503);
    this.endpointOf(defaultModel);
    this.headersOf(defaultModel);
    const caFile = this.caFileOf(defaultModel);
    if (caFile !== undefined) {
      try { await access(caFile, constants.R_OK); }
      catch {
        throw new PnpError("MODEL_CA_FILE_MISSING",
          `${defaultModel.caFileEnvironment} names a certificate file that is missing or unreadable.`, 503);
      }
    }
    // The instruction files are part of the same startup contract as the model variables: they were
    // checked when the settings loaded, and this confirms they are still readable now.
    await this.instructionAssets();
  }
  async prepare(input: Parameters<IntegrationProvider["prepare"]>[0]): Promise<IntegrationContext> {
    if (input.signal.aborted) throw new PnpError("EXECUTION_CANCELLED", "Model preparation was cancelled.", 409);
    const { model, resolution } = this.resolve(input.request.model);
    const endpoint = this.endpointOf(model);
    const selection = { providerID: model.selection.providerID, modelID: this.modelIdOf(model) };
    const headers = this.headersOf(model);
    const caFile = this.caFileOf(model);
    return {
      model: {
        selection, endpoint, protocol: model.protocol, headers, resolution,
        ...(caFile === undefined ? {} : { caFile }),
        // A last-resort deployment switch, carried on the binding so an Engine Pack projects it
        // instead of each adapter inventing its own variable.
        ...(this.environment.PNP_MODEL_TLS_INSECURE === "1" ? { tlsInsecure: true } : {}),
      },
      tools: this.tools, assets: await this.instructionAssets(),
      authorize: async (request) => this.policy(request.operation),
      ...(this.permissions === undefined ? {} : { permissions: this.permissions }),
    };
  }
}
