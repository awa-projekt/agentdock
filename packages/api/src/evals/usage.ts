import type { EvalUsage, TokenUsage } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import type { ModelCatalogService } from '../models/catalog';
import { estimateCostBreakdown } from '../models/cost';

/**
 * Prices one model call by the rates of the `provider:model` it was configured
 * with. Pricing happens when the trial is recorded, so a run keeps the bill it
 * actually ran up even after the catalog's rates change.
 */
export const priceModelCall = (
  catalog: ModelCatalogService,
  model: string,
  tokens: TokenUsage,
  reasoningEstimated: boolean,
): Effect.Effect<EvalUsage> =>
  Effect.map(catalog.find(model), (entry) => {
    const usage: EvalUsage = { calls: 1, tokens, reasoningEstimated };
    const cost = estimateCostBreakdown(entry, tokens);
    return cost === undefined ? usage : { ...usage, cost };
  });
