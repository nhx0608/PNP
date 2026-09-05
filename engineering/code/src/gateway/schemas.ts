import { Type, type Static } from "@sinclair/typebox";
export const CreateSessionSchema = Type.Object({
  title: Type.Optional(Type.String()),
  directory: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export type CreateSessionBody = Static<typeof CreateSessionSchema>;
export const PromptSchema = Type.Object({
  parts: Type.Array(Type.Object({
    type: Type.Literal("text"), text: Type.String(),
  }), { minItems: 1 }),
  model: Type.Object({
    providerID: Type.String({ minLength: 1 }), modelID: Type.String({ minLength: 1 }),
  }),
  agent: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type PromptBody = Static<typeof PromptSchema>;
