import * as Schema from 'effect/Schema';

export const NonNegativeInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

/**
 * Token counts for one model call, in the OpenTelemetry GenAI split: `input`
 * covers the whole prompt — cached portions included — with `cacheRead` and
 * `cacheWrite` breaking out the slice served from, or written to, a prompt
 * cache. `reasoning` is likewise the hidden chain-of-thought subset of
 * `output`. Summing the fields therefore double-counts; price and render each
 * breakdown against its parent, never alongside it.
 */
export const TokenUsage = Schema.Struct({
  input: NonNegativeInt,
  cacheRead: NonNegativeInt,
  cacheWrite: NonNegativeInt,
  output: NonNegativeInt,
  reasoning: NonNegativeInt,
  total: NonNegativeInt,
});

/**
 * Token counts plus the USD they priced out to. `cost` is absent when the
 * model's rates are unknown, which is not the same as free.
 */
export const Usage = Schema.Struct({
  tokens: TokenUsage,
  cost: Schema.optional(Schema.Finite),
});

/**
 * What tokens cost in USD, split the way providers bill them: uncached input,
 * cache reads, cache writes and output. `reasoning` is the share of `output`
 * spent on hidden thinking, so it is included in `output`, not added to it.
 */
export const CostBreakdown = Schema.Struct({
  input: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  total: Schema.Finite,
});

export type TokenUsage = Schema.Schema.Type<typeof TokenUsage>;
export type CostBreakdown = Schema.Schema.Type<typeof CostBreakdown>;
export type Usage = Schema.Schema.Type<typeof Usage>;

export const emptyTokenUsage: TokenUsage = {
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  total: 0,
};

export const addTokenUsage = (left: TokenUsage, right: TokenUsage): TokenUsage => ({
  input: left.input + right.input,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
  output: left.output + right.output,
  reasoning: left.reasoning + right.reasoning,
  total: left.total + right.total,
});

export const addCostBreakdown = (left: CostBreakdown, right: CostBreakdown): CostBreakdown => ({
  input: left.input + right.input,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
  output: left.output + right.output,
  reasoning: left.reasoning + right.reasoning,
  total: left.total + right.total,
});
