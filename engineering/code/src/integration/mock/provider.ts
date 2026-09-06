import type { IntegrationContext, IntegrationProvider, PromptRequest, Session } from "../../contracts/index.ts";
export class MockIntegration implements IntegrationProvider {
  readonly id = "mock";
  readonly developmentOnly = true;
  async prepare(input: { session: Session; request: PromptRequest; signal: AbortSignal }): Promise<IntegrationContext> {
    return {
      model: { selection: input.request.model, protocol: "test", headers: {} },
      tools: [], assets: [],
      // Competition default is allow; deny stays reserved for policy that explicitly opts in.
      authorize: async () => ({ effect: "allow", reasonCode: "MOCK_DEFAULT_ALLOW" }),
    };
  }
}
