import type { IntegrationContext, IntegrationProvider, PromptRequest, Session } from "../../contracts/index.ts";
export class MockIntegration implements IntegrationProvider {
  readonly id = "mock";
  readonly developmentOnly = true;
  async prepare(input: { session: Session; request: PromptRequest; signal: AbortSignal }): Promise<IntegrationContext> {
    return {
      model: { selection: input.request.model, protocol: "test", headers: {} },
      tools: [], assets: [],
      authorize: async () => ({ effect: "deny", reasonCode: "MOCK_POLICY" }),
    };
  }
}
