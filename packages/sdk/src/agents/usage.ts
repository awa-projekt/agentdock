import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { isAIMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import { coerceJson, type Json, jsonNumber, jsonProperty, renderJson } from '../schemas/json';
import type { TokenUsage } from '../schemas/usage';
import { generationMessage } from './langgraph-otel';

const count = (usage: Json | undefined, path: ReadonlyArray<string>): number => {
  const [head, ...rest] = path;
  if (head === undefined) return 0;
  if (rest.length > 0) return count(jsonProperty(usage, head), rest);
  const value = jsonNumber(usage, head);
  return value === undefined ? 0 : Math.max(0, Math.round(value));
};

/**
 * LangChain normalises every provider's accounting onto a message's
 * `usage_metadata`: `input_tokens` covers the whole prompt with
 * `input_token_details` breaking out the cached slice, and
 * `output_token_details.reasoning` the hidden thinking inside the output.
 * Absent when the provider reported nothing.
 */
export const tokenUsageFromUsageMetadata = (usage: Json | undefined): TokenUsage | undefined => {
  const input = count(usage, ['input_tokens']);
  const output = count(usage, ['output_tokens']);
  if (input === 0 && output === 0) return undefined;
  return {
    input,
    cacheRead: count(usage, ['input_token_details', 'cache_read']),
    cacheWrite: count(usage, ['input_token_details', 'cache_creation']),
    output,
    reasoning: Math.min(output, count(usage, ['output_token_details', 'reasoning'])),
    total: count(usage, ['total_tokens']) || input + output,
  };
};

/** The usual rule of thumb for English text and JSON; only used where a provider gave no count. */
const CHARS_PER_TOKEN = 4;

/**
 * Anthropic bills thinking inside `output_tokens` without saying how much of
 * it was thinking, and may return the thinking only summarised. For a call
 * that visibly reasoned, the thinking share is therefore estimated as the
 * output beyond what the call visibly produced (answer text and tool-call
 * arguments). Calls whose provider counted reasoning, or that did not reason,
 * pass through unchanged.
 */
export type ReasoningEstimate = { readonly tokens: TokenUsage; readonly estimated: boolean };

export const withReasoningEstimate = (
  tokens: TokenUsage,
  visibleChars: number,
  reasoned: boolean,
): ReasoningEstimate => {
  if (tokens.reasoning > 0 || !reasoned) return { tokens, estimated: false };
  const visible = Math.ceil(visibleChars / CHARS_PER_TOKEN);
  return { tokens: { ...tokens, reasoning: Math.max(0, tokens.output - visible) }, estimated: true };
};

/** What one model call reported, as the loop hands it on in a `model-call` event. */
export type ModelCallReport = {
  readonly usage: TokenUsage | undefined;
  readonly toolCalls: number;
  readonly reasoningEstimated: boolean;
};

/**
 * Chat models that predate LangChain's `usage_metadata` only fill
 * `llmOutput.tokenUsage`, which has no cache or reasoning breakdown.
 */
const legacyTokenUsage = (llmOutput: Json | undefined): TokenUsage | undefined => {
  const legacy = jsonProperty(llmOutput, 'tokenUsage');
  const input = count(legacy, ['promptTokens']);
  const output = count(legacy, ['completionTokens']);
  if (input === 0 && output === 0) return undefined;
  return {
    input,
    cacheRead: 0,
    cacheWrite: 0,
    output,
    reasoning: 0,
    total: count(legacy, ['totalTokens']) || input + output,
  };
};

/**
 * Reads one finished model call: its usage, how many tools it called, and,
 * for providers that bill thinking inside output without counting it, an
 * estimate of the thinking share from what the call visibly produced.
 */
export const modelCallReport = (result: LLMResult): ModelCallReport => {
  const message = generationMessage(result.generations[0]?.[0]);
  const ai = message !== undefined && isAIMessage(message) ? message : undefined;
  const toolCalls = ai?.tool_calls ?? [];
  const blocks = ai?.contentBlocks ?? [];
  const visibleChars =
    blocks.reduce((total, block) => total + (block.type === 'text' ? String(block.text).length : 0), 0) +
    toolCalls.reduce((total, call) => total + renderJson(coerceJson(call.args)).length, 0);
  const tokens =
    tokenUsageFromUsageMetadata(coerceJson(ai?.usage_metadata)) ?? legacyTokenUsage(coerceJson(result.llmOutput));
  const counted =
    tokens === undefined
      ? undefined
      : withReasoningEstimate(
          tokens,
          visibleChars,
          blocks.some((block) => block.type === 'reasoning'),
        );
  return {
    usage: counted?.tokens,
    toolCalls: toolCalls.length,
    reasoningEstimated: counted?.estimated ?? false,
  };
};

/**
 * A callback that reports every model call the agent graph makes. It is
 * awaited, so a report lands before the loop moves on and none is lost when
 * the run ends right after its last call.
 */
export class ModelCallRecorder extends BaseCallbackHandler {
  name = 'agentdock-model-calls';

  constructor(private readonly onReport: (report: ModelCallReport) => void | Promise<void>) {
    super({ _awaitHandler: true });
  }

  override async handleLLMEnd(result: LLMResult): Promise<void> {
    await this.onReport(modelCallReport(result));
  }
}
