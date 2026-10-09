import * as Schema from 'effect/Schema';
import { ReasoningEffort } from './reasoning';

export const ModelSchema = Schema.Struct({
  value: Schema.String,
  provider: Schema.String,
  providerName: Schema.String,
  id: Schema.String,
  name: Schema.String,
  contextWindow: Schema.optional(Schema.Number),
  maxOutputTokens: Schema.optional(Schema.Number),
  inputCostPerMillion: Schema.optional(Schema.Number),
  outputCostPerMillion: Schema.optional(Schema.Number),
  cacheReadCostPerMillion: Schema.optional(Schema.Number),
  cacheWriteCostPerMillion: Schema.optional(Schema.Number),
  toolCall: Schema.optional(Schema.Boolean),
  reasoning: Schema.optional(Schema.Boolean),
  /** Effort tiers the agent editor offers for this model, weakest first; empty or absent hides the knob. */
  reasoningEfforts: Schema.optional(Schema.Array(ReasoningEffort)),
  releaseDate: Schema.optional(Schema.String),
  suggested: Schema.optional(Schema.Boolean),
});

export const ModelListSchema = Schema.Array(ModelSchema);

export const ProviderKeySourceSchema = Schema.Literals(['stored', 'env', 'none']);

export const CustomProviderKindSchema = Schema.Literals(['openai-compatible', 'azure-openai']);

export const ProviderKeySchema = Schema.Struct({
  provider: Schema.String,
  name: Schema.String,
  source: ProviderKeySourceSchema,
  maskedKey: Schema.optional(Schema.String),
  custom: Schema.optional(Schema.Boolean),
  baseUrl: Schema.optional(Schema.String),
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  kind: Schema.optional(CustomProviderKindSchema),
});

export const ProviderKeyListSchema = Schema.Array(ProviderKeySchema);

export const SetProviderKeyInputSchema = Schema.Struct({
  apiKey: Schema.String,
  baseUrl: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  kind: Schema.optional(CustomProviderKindSchema),
});

export const RemoveProviderKeyResponseSchema = Schema.Struct({
  removed: Schema.Boolean,
});

export const ValidateModelInputSchema = Schema.Struct({
  model: Schema.String,
});

export const ValidateModelResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
});

export type Model = Schema.Schema.Type<typeof ModelSchema>;
export type ProviderKey = Schema.Schema.Type<typeof ProviderKeySchema>;
export type SetProviderKeyInput = Schema.Schema.Type<typeof SetProviderKeyInputSchema>;
export type ValidateModelInput = Schema.Schema.Type<typeof ValidateModelInputSchema>;
export type ValidateModelResult = Schema.Schema.Type<typeof ValidateModelResultSchema>;
