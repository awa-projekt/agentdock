import {
  addTokenUsage,
  emptyTokenUsage,
  type JsonObject,
  jsonNumber,
  jsonString,
  type Model,
  type TokenUsage,
  type Usage,
} from 'agentdock-sdk/schemas';
import { estimateCost } from '../models/cost';

/**
 * Token counts as `packages/sdk/src/agents/langgraph-otel.ts` writes them. The
 * cache and reasoning keys have no stable OpenTelemetry semconv yet; these are
 * the names the wider GenAI instrumentation ecosystem has settled on.
 */
const INPUT_TOKENS = 'gen_ai.usage.input_tokens';
const OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
const TOTAL_TOKENS = 'gen_ai.usage.total_tokens';
const CACHE_READ_TOKENS = 'gen_ai.usage.cache_read_input_tokens';
const CACHE_WRITE_TOKENS = 'gen_ai.usage.cache_creation_input_tokens';
const REASONING_TOKENS = 'gen_ai.usage.reasoning_tokens';
const REQUEST_MODEL = 'gen_ai.request.model';

const tokenCount = (attributes: JsonObject, key: string): number | undefined => {
  const value = jsonNumber(attributes, key);
  return value === undefined ? undefined : Math.max(0, Math.round(value));
};

const tokenUsageFromAttributes = (attributes: JsonObject): TokenUsage | undefined => {
  const input = tokenCount(attributes, INPUT_TOKENS);
  const output = tokenCount(attributes, OUTPUT_TOKENS);
  if (input === undefined && output === undefined) return undefined;
  return {
    input: input ?? 0,
    cacheRead: tokenCount(attributes, CACHE_READ_TOKENS) ?? 0,
    cacheWrite: tokenCount(attributes, CACHE_WRITE_TOKENS) ?? 0,
    output: output ?? 0,
    reasoning: tokenCount(attributes, REASONING_TOKENS) ?? 0,
    total: tokenCount(attributes, TOTAL_TOKENS) ?? (input ?? 0) + (output ?? 0),
  };
};

/**
 * Prices a span at read time rather than baking the cost into the span, so a
 * catalog rate correction reprices history instead of only future traces. The
 * lookup key is the `provider:model` string the agent was configured with,
 * which is what the catalog is keyed by.
 */
export const spanUsage = (attributes: JsonObject, models: ReadonlyArray<Model>): Usage | undefined => {
  const tokens = tokenUsageFromAttributes(attributes);
  if (!tokens) return undefined;
  const modelValue = jsonString(attributes, REQUEST_MODEL);
  const model = modelValue === undefined ? undefined : models.find((candidate) => candidate.value === modelValue);
  const cost = model === undefined ? undefined : estimateCost(model, tokens);
  return cost === undefined ? { tokens } : { tokens, cost };
};

export const rollUpUsage = (spanUsages: ReadonlyArray<Usage>): Usage | undefined => {
  if (spanUsages.length === 0) return undefined;
  const tokens = spanUsages.reduce((total, usage) => addTokenUsage(total, usage.tokens), emptyTokenUsage);
  // One unpriced model call makes the trace total a floor rather than a sum,
  // so the rollup drops its cost instead of quietly under-reporting.
  if (spanUsages.some((usage) => usage.cost === undefined)) return { tokens };
  return { tokens, cost: spanUsages.reduce((total, usage) => total + (usage.cost ?? 0), 0) };
};
