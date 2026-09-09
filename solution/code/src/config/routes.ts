import { PnpError } from "../core/errors.ts";
import { ConfigConflictError, SettingsInvalidError } from "./service.ts";
import type { ConfigService } from "./service.ts";

/**
 * The /config family as data rather than as Fastify calls: `src/gateway/app.ts` mounts this table
 * in one loop, and every request/response pair here is exercised by tests/unit/config-service.test.ts
 * without an HTTP server. Keeping the table transport-agnostic is also what keeps the rule
 * "no credential crosses HTTP" checkable in one place - `ConfigService` is the only thing that
 * touches the settings file, and nothing in this module can reach runtime\local.env.
 */
export interface ConfigRequest {
  /** Parsed query string. */
  query?: Readonly<Record<string, string | undefined>>;
  /** Path parameters; the wildcard tail of a `*` route arrives as `params["*"]`. */
  params?: Readonly<Record<string, string | undefined>>;
  /** Parsed JSON body, or undefined for a body-less method. */
  body?: unknown;
}

export interface ConfigResponse {
  status: number;
  body: unknown;
  headers?: Readonly<Record<string, string>>;
}

export interface ConfigRoute {
  method: "GET" | "POST" | "PUT";
  /** Fastify-shaped path, so mounting is `app[route.method.toLowerCase()](route.path, ...)`. */
  path: string;
  /** True for the routes PNP_CONFIG_READONLY turns into 403. */
  write: boolean;
  summary: string;
  handle(request: ConfigRequest): Promise<ConfigResponse>;
}

type JsonObject = Record<string, unknown>;

function body(request: ConfigRequest): JsonObject {
  const value = request.body;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PnpError("VALIDATION_ERROR", "A JSON object body is required.", 400);
  }
  return value as JsonObject;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PnpError("VALIDATION_ERROR", `${field} must be a non-empty string.`, 400);
  }
  return value;
}

function engineList(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new PnpError("VALIDATION_ERROR", "engines must be an array of engine ids.", 400);
  }
  return value;
}

function tail(request: ConfigRequest): string {
  return requiredString(request.params?.["*"], "path");
}

/**
 * A conflict and an invalid document are both ordinary answers for an editor: it needs the digest
 * to re-base on, or the list of problems to anchor to fields - including on the read side, where a
 * stored file that no longer parses is exactly what the page has been opened to repair. The gateway's generic error handler
 * would flatten both to { code, message }, so these two are answered rather than thrown.
 */
async function answered(run: () => Promise<ConfigResponse>): Promise<ConfigResponse> {
  try { return await run(); }
  catch (error) {
    if (error instanceof ConfigConflictError) {
      return { status: 409, body: { code: error.code, message: error.message, current: error.current } };
    }
    if (error instanceof SettingsInvalidError) {
      return { status: 400, body: { code: error.code, message: error.message, problems: error.problems } };
    }
    throw error;
  }
}

export function configRoutes(service: ConfigService): readonly ConfigRoute[] {
  return [
    {
      method: "GET", path: "/config", write: false,
      summary: "Effective settings for one engine, every value labelled with the layer it came from.",
      handle: async (request) => answered(async () => {
        const engine = request.query?.engine;
        return { status: 200, body: await service.read(engine === undefined || engine === "" ? undefined : engine) };
      }),
    },
    {
      method: "GET", path: "/config/raw", write: false,
      summary: "The settings document as stored, with its digest as the ETag.",
      handle: async () => {
        const result = await service.raw();
        return { status: 200, body: result, headers: { ETag: `"${result.sha256}"` } };
      },
    },
    {
      method: "POST", path: "/config/validate", write: false,
      summary: "Check a candidate document against the shipped parser without writing anything.",
      handle: async (request) => {
        const input = body(request);
        if (!Object.hasOwn(input, "settings")) {
          throw new PnpError("VALIDATION_ERROR", "settings is required.", 400);
        }
        return { status: 200, body: await service.validate(input.settings, engineList(input.engines)) };
      },
    },
    {
      method: "GET", path: "/config/environment", write: false,
      summary: "Names of the environment variables this document references, each with a set flag. Never a value.",
      handle: async () => ({ status: 200, body: await service.environmentStatus() }),
    },
    {
      method: "GET", path: "/config/files", write: false,
      summary: "The instruction files that can be opened and edited.",
      handle: async (request) => {
        const kind = request.query?.kind ?? "instruction";
        if (kind !== "instruction") {
          throw new PnpError("VALIDATION_ERROR", "kind must be \"instruction\".", 400);
        }
        return { status: 200, body: await service.listInstructions() };
      },
    },
    {
      method: "GET", path: "/config/files/instruction/*", write: false,
      summary: "One instruction file as text, with the digest an edit has to quote back.",
      handle: async (request) => ({ status: 200, body: await service.readInstruction(tail(request)) }),
    },
    {
      method: "PUT", path: "/config", write: true,
      summary: "Validate, back up, then atomically replace the settings document.",
      handle: async (request) => answered(async () => {
        const input = body(request);
        if (!Object.hasOwn(input, "settings")) {
          throw new PnpError("VALIDATION_ERROR", "settings is required.", 400);
        }
        const label = input.label === undefined ? undefined : requiredString(input.label, "label");
        return {
          status: 200,
          body: await service.write(input.settings, requiredString(input.baseSha256, "baseSha256"), label),
        };
      }),
    },
    {
      method: "PUT", path: "/config/files/instruction/*", write: true,
      summary: "Replace one instruction file atomically, guarded by its digest.",
      handle: async (request) => answered(async () => {
        const input = body(request);
        if (typeof input.text !== "string") {
          throw new PnpError("VALIDATION_ERROR", "text must be a string.", 400);
        }
        return {
          status: 200,
          body: await service.writeInstruction(tail(request), input.text, requiredString(input.ifMatch, "ifMatch")),
        };
      }),
    },
  ];
}
