import type { CostBreakdown, Model, TokenUsage } from 'agentdock-sdk/schemas';

const PER_MILLION = 1_000_000;

/**
 * Prices one model call in USD from the models.dev rates, split by how each
 * slice is billed.
 *
 * `tokens.input` is the whole prompt, so the cached slices are billed at their
 * own rates and subtracted from the uncached remainder. Reasoning tokens are
 * already part of `tokens.output` and carry no separate rate; `reasoning` is
 * their share of the output cost. A model the catalog has no rates for prices
 * to `undefined` — unknown, not free.
 */
export const estimateCostBreakdown = (model: Model, tokens: TokenUsage): CostBreakdown | undefined => {
  const inputRate = model.inputCostPerMillion;
  const outputRate = model.outputCostPerMillion;
  if (inputRate === undefined && outputRate === undefined) return undefined;

  const cacheReadRate = model.cacheReadCostPerMillion ?? inputRate ?? 0;
  const cacheWriteRate = model.cacheWriteCostPerMillion ?? inputRate ?? 0;
  const uncachedInput = Math.max(0, tokens.input - tokens.cacheRead - tokens.cacheWrite);
  const input = (uncachedInput * (inputRate ?? 0)) / PER_MILLION;
  const cacheRead = (tokens.cacheRead * cacheReadRate) / PER_MILLION;
  const cacheWrite = (tokens.cacheWrite * cacheWriteRate) / PER_MILLION;
  const output = (tokens.output * (outputRate ?? 0)) / PER_MILLION;
  const reasoning = (Math.min(tokens.reasoning, tokens.output) * (outputRate ?? 0)) / PER_MILLION;
  return { input, cacheRead, cacheWrite, output, reasoning, total: input + cacheRead + cacheWrite + output };
};

/** The total of {@link estimateCostBreakdown}. */
export const estimateCost = (model: Model, tokens: TokenUsage): number | undefined =>
  estimateCostBreakdown(model, tokens)?.total;
