import type { IntegrationContext, IntegrationProvider } from "../../contracts/index.ts";
import { PnpError } from "../../core/errors.ts";
/** C supplies private model, tool and authorization bindings through this interface. */
export class InternalIntegration implements IntegrationProvider {
  readonly id = "internal";
  readonly developmentOnly = false;
  async prepare(_input: Parameters<IntegrationProvider["prepare"]>[0]): Promise<IntegrationContext> {
    throw new PnpError("INTEGRATION_UNAVAILABLE", "Internal model, tool and policy integration is not configured.", 503);
  }
}
