import type { JsonObject, Model } from 'agentdock-sdk/schemas';
import { describe, expect, it } from 'vitest';
import { rollUpUsage, spanUsage } from './usage';

const sonnet: Model = {
  value: 'anthropic:claude-sonnet-4-6',
  provider: 'anthropic',
  providerName: 'Anthropic',
  id: 'claude-sonnet-4-6',
  name: 'Claude Sonnet 4.6',
  inputCostPerMillion: 3,
  outputCostPerMillion: 15,
  cacheReadCostPerMillion: 0.3,
  cacheWriteCostPerMillion: 3.75,
};

const unpriced: Model = {
  value: 'ollama:llama4',
  provider: 'ollama',
  providerName: 'Ollama',
  id: 'llama4',
  name: 'Llama 4',
};

const attributes = (values: Record<string, number | string>): JsonObject => values;

describe('spanUsage', () => {
  it('ignores spans that reported no token counts', () => {
    expect(spanUsage(attributes({ 'gen_ai.request.model': sonnet.value }), [sonnet])).toBeUndefined();
  });

  it('bills the cached slices at their own rates instead of the full input rate', () => {
    const usage = spanUsage(
      attributes({
        'gen_ai.request.model': sonnet.value,
        'gen_ai.usage.input_tokens': 100_000,
        'gen_ai.usage.cache_read_input_tokens': 80_000,
        'gen_ai.usage.cache_creation_input_tokens': 10_000,
        'gen_ai.usage.output_tokens': 1_000,
      }),
      [sonnet],
    );

    expect(usage?.tokens).toEqual({
      input: 100_000,
      cacheRead: 80_000,
      cacheWrite: 10_000,
      output: 1_000,
      reasoning: 0,
      total: 101_000,
    });
    // 10k uncached @ $3 + 80k read @ $0.30 + 10k write @ $3.75 + 1k out @ $15.
    expect(usage?.cost).toBeCloseTo((10_000 * 3 + 80_000 * 0.3 + 10_000 * 3.75 + 1_000 * 15) / 1_000_000, 10);
  });

  it('reports tokens without a cost when the model has no catalog rates', () => {
    const usage = spanUsage(
      attributes({
        'gen_ai.request.model': unpriced.value,
        'gen_ai.usage.input_tokens': 500,
        'gen_ai.usage.output_tokens': 50,
      }),
      [unpriced],
    );

    expect(usage?.tokens.input).toBe(500);
    expect(usage?.cost).toBeUndefined();
  });

  it('reports tokens without a cost for a model missing from the catalog', () => {
    const usage = spanUsage(
      attributes({
        'gen_ai.request.model': 'anthropic:some-unreleased-model',
        'gen_ai.usage.input_tokens': 500,
        'gen_ai.usage.output_tokens': 50,
      }),
      [sonnet],
    );

    expect(usage?.cost).toBeUndefined();
  });
});

describe('rollUpUsage', () => {
  const priced = spanUsage(
    attributes({
      'gen_ai.request.model': sonnet.value,
      'gen_ai.usage.input_tokens': 1_000,
      'gen_ai.usage.output_tokens': 100,
    }),
    [sonnet],
  );
  const unavailable = spanUsage(
    attributes({
      'gen_ai.request.model': unpriced.value,
      'gen_ai.usage.input_tokens': 200,
      'gen_ai.usage.output_tokens': 20,
    }),
    [unpriced],
  );

  it('sums the token counts and costs of every model call', () => {
    const total = rollUpUsage([priced!, priced!]);
    expect(total?.tokens.input).toBe(2_000);
    expect(total?.tokens.output).toBe(200);
    expect(total?.cost).toBeCloseTo(2 * priced!.cost!, 10);
  });

  it('drops the cost rather than under-report when one call could not be priced', () => {
    const total = rollUpUsage([priced!, unavailable!]);
    expect(total?.tokens.input).toBe(1_200);
    expect(total?.cost).toBeUndefined();
  });

  it('has nothing to report for a trace without model calls', () => {
    expect(rollUpUsage([])).toBeUndefined();
  });
});
