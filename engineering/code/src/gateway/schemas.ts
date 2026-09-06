import { Type, type Static } from "@sinclair/typebox";
/**
 * Inbound bodies from the assessment client ignore fields they do not know: an evaluation script
 * that carries its own `trace_id` or run mode must not lose the case to a 400. Required fields and
 * their types are still validated, and nothing unknown is ever read — the handlers project these
 * bodies onto the public contract types field by field.
 */
export const CreateSessionSchema = Type.Object({
  title: Type.Optional(Type.String()),
  directory: Type.String({ minLength: 1 }),
});
export type CreateSessionBody = Static<typeof CreateSessionSchema>;
/**
 * `model` accepts the baseline object shape or a `"provider/model"` shorthand string, and may be
 * omitted entirely (the handler then asks the integration provider for its configured default).
 * `parts` accepts any item shape at the schema layer; unrecognized part types are dropped by the
 * route handler rather than rejecting the whole request (a 400 is only raised when no recognized
 * part remains).
 */
export const PromptSchema = Type.Object({
  parts: Type.Array(Type.Unknown(), { minItems: 1 }),
  model: Type.Optional(Type.Union([
    Type.Object({
      providerID: Type.String({ minLength: 1 }), modelID: Type.String({ minLength: 1 }),
    }),
    Type.String({ minLength: 1 }),
  ])),
  agent: Type.Optional(Type.String()),
});
export type PromptBody = Static<typeof PromptSchema>;
