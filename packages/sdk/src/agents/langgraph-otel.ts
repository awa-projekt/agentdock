import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { BaseMessage } from '@langchain/core/messages';
import type { Generation, LLMResult } from '@langchain/core/outputs';
import { context as otelContext, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import * as Predicate from 'effect/Predicate';
import {
  coerceJson,
  isJsonArray,
  isJsonNumber,
  isJsonString,
  type Json,
  jsonProperty,
  renderJson,
} from '../schemas/json';

type SpanAttribute = string | number | boolean;

/**
 * Span attributes accumulate key by key as a run unfolds, so they live in a Map
 * and are converted to the plain object OpenTelemetry expects at the one point
 * they are handed to a span.
 */
type SpanAttributes = Map<string, SpanAttribute>;

export type AgentOtelMetadata = {
  readonly agentId: string;
  readonly agentName: string;
  readonly model: string;
  readonly taskId: string;
  readonly contextId: string;
  readonly userMessageId: string;
};

const tracer = trace.getTracer('agentdock.langgraph');

const truncate = (value: string, maxLength = 16_384): string =>
  value.length > maxLength ? `${value.slice(0, maxLength)}...[truncated]` : value;

/** Renders a decoded payload for an `input.value`/`output.value` attribute. */
const describe = (value: Json | undefined): string => truncate(renderJson(value));

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const maybeNumber = (value: Json | undefined): number | undefined => {
  if (isJsonNumber(value) && Number.isFinite(value)) return value;
  if (isJsonString(value) && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const setIfPresent = (attributes: SpanAttributes, key: string, value: Json | undefined): void => {
  if (isJsonString(value)) {
    if (value.length > 0) attributes.set(key, value);
    return;
  }
  if (isJsonNumber(value)) {
    if (Number.isFinite(value)) attributes.set(key, value);
    return;
  }
  if (Predicate.isBoolean(value)) attributes.set(key, value);
};

const baseAttributes = (metadata: AgentOtelMetadata): SpanAttributes =>
  new Map<string, SpanAttribute>([
    ['agent.id', metadata.agentId],
    ['agent.name', metadata.agentName],
    ['a2a.task.id', metadata.taskId],
    ['a2a.context.id', metadata.contextId],
    ['a2a.message.id', metadata.userMessageId],
    ['gen_ai.request.model', metadata.model],
  ]);

const serializedName = (serialized: Json | undefined): string | undefined => {
  const name = jsonProperty(serialized, 'name') ?? jsonProperty(serialized, 'id') ?? jsonProperty(serialized, 'lc_id');
  if (isJsonString(name)) return name;
  return isJsonArray(name) ? name.map(renderJson).join('.') : undefined;
};

const messageRole = (message: BaseMessage): string => {
  const type = message.getType();
  switch (type) {
    case 'human':
      return 'user';
    case 'ai':
      return 'assistant';
    default:
      return type;
  }
};

const addChatPromptAttributes = (attributes: SpanAttributes, messages: readonly BaseMessage[]): void => {
  messages.forEach((message, index) => {
    attributes.set(`gen_ai.prompt.${index}.role`, messageRole(message));
    attributes.set(`gen_ai.prompt.${index}.content`, truncate(message.text));
  });
  attributes.set('gen_ai.input.messages', describe(coerceJson(messages.map((message) => message.toDict()))));
};

const readNested = (source: Json | undefined, path: readonly string[]): Json | undefined =>
  path.reduce<Json | undefined>((current, segment) => jsonProperty(current, segment), source);

const setNumberAttribute = (span: Span, key: string, value: number | undefined): void => {
  if (value !== undefined) span.setAttribute(key, value);
};

/** The chat message a generation carries, when it came from a chat model. */
export const generationMessage = (generation: Generation | undefined): BaseMessage | undefined => {
  if (generation === undefined || !('message' in generation)) return undefined;
  // SAFETY: only `ChatGeneration` declares `message`, and it types it as a `BaseMessage`.
  return generation.message as BaseMessage;
};

/**
 * LangChain normalises every provider's token accounting onto the generated
 * message as `usage_metadata`, where `input_tokens` covers the whole prompt and
 * `input_token_details` breaks out the cached slice. Chat models that predate
 * that contract only fill `llmOutput.tokenUsage`, which carries no cache
 * breakdown — hence prompt/completion totals alone in the fallback.
 */
const addUsageAttributes = (span: Span, result: LLMResult): void => {
  const message = generationMessage(result.generations[0]?.[0]);
  const usage = coerceJson(message !== undefined && 'usage_metadata' in message ? message.usage_metadata : undefined);
  const legacy = jsonProperty(coerceJson(result.llmOutput), 'tokenUsage');
  const responseMetadata = coerceJson(message?.response_metadata);

  setNumberAttribute(
    span,
    'gen_ai.usage.input_tokens',
    maybeNumber(jsonProperty(usage, 'input_tokens')) ?? maybeNumber(jsonProperty(legacy, 'promptTokens')),
  );
  setNumberAttribute(
    span,
    'gen_ai.usage.output_tokens',
    maybeNumber(jsonProperty(usage, 'output_tokens')) ?? maybeNumber(jsonProperty(legacy, 'completionTokens')),
  );
  setNumberAttribute(
    span,
    'gen_ai.usage.total_tokens',
    maybeNumber(jsonProperty(usage, 'total_tokens')) ?? maybeNumber(jsonProperty(legacy, 'totalTokens')),
  );
  setNumberAttribute(
    span,
    'gen_ai.usage.cache_read_input_tokens',
    maybeNumber(readNested(usage, ['input_token_details', 'cache_read'])),
  );
  setNumberAttribute(
    span,
    'gen_ai.usage.cache_creation_input_tokens',
    maybeNumber(readNested(usage, ['input_token_details', 'cache_creation'])),
  );
  setNumberAttribute(
    span,
    'gen_ai.usage.reasoning_tokens',
    maybeNumber(readNested(usage, ['output_token_details', 'reasoning'])),
  );

  // The model that actually served the call — a dated snapshot id where the
  // request named an alias.
  const attributes: SpanAttributes = new Map();
  setIfPresent(attributes, 'gen_ai.response.model', jsonProperty(responseMetadata, 'model_name'));
  setIfPresent(attributes, 'gen_ai.response.finish_reason', jsonProperty(responseMetadata, 'finish_reason'));
  span.setAttributes(Object.fromEntries(attributes));
};

const addCompletionAttributes = (span: Span, result: LLMResult): void => {
  const generations = result.generations[0] ?? [];
  generations.forEach((generation, index) => {
    span.setAttribute(`gen_ai.completion.${index}.content`, truncate(generation.text));
    const message = generationMessage(generation);
    if (message !== undefined) {
      span.setAttribute(`gen_ai.completion.${index}.role`, messageRole(message));
    }
  });
  if (generations.length > 0) {
    span.setAttribute('gen_ai.output.messages', describe(coerceJson(generations)));
  }
};

export const createAgentOtelCallback = (metadata: AgentOtelMetadata): BaseCallbackHandler => {
  const spans = new Map<string, Span>();
  // The root graph span. LangGraph emits a chain run for every internal pregel step,
  // middleware hook, and Runnable wrapper, none of which we trace. Their child LLM/tool
  // runs therefore can't find their immediate parent in `spans`, so they fall back to the
  // root and nest directly under it.
  let rootSpan: Span | undefined;

  const startSpan = (
    runId: string,
    parentRunId: string | undefined,
    name: string,
    attributes: SpanAttributes,
  ): void => {
    const parentSpan = (parentRunId ? spans.get(parentRunId) : undefined) ?? rootSpan;
    const parentContext = parentSpan ? trace.setSpan(otelContext.active(), parentSpan) : otelContext.active();
    const span = tracer.startSpan(name, { attributes: Object.fromEntries(attributes) }, parentContext);
    spans.set(runId, span);
    if (parentRunId === undefined) rootSpan = span;
  };

  const endSpan = (runId: string): Span | undefined => {
    const span = spans.get(runId);
    if (span) {
      span.end();
      spans.delete(runId);
      if (span === rootSpan) rootSpan = undefined;
    }
    return span;
  };

  const failSpan = (runId: string, cause: unknown): void => {
    const span = spans.get(runId);
    if (!span) return;
    if (cause instanceof Error) span.recordException(cause);
    span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(cause) });
    span.setAttribute('error.message', errorMessage(cause));
    endSpan(runId);
  };

  return BaseCallbackHandler.fromMethods({
    handleChainStart: (chain, inputs, runId, runType, tags, callbackMetadata, runName, parentRunId) => {
      // Only trace the root graph invocation. Nested chain runs are LangGraph plumbing
      // (pregel steps, middleware before_agent/after_model hooks, RunnableSequence/Lambda
      // wrappers) that carry no signal and would stack near-duplicate spans around the LLM
      // call. The meaningful work surfaces through the LLM and tool callbacks instead.
      if (parentRunId !== undefined) return;
      const attributes = baseAttributes(metadata);
      attributes.set('langchain.run.id', runId);
      setIfPresent(attributes, 'langchain.run.type', runType);
      setIfPresent(attributes, 'langchain.run.name', runName);
      setIfPresent(attributes, 'langchain.serialized.name', serializedName(coerceJson(chain)));
      if (tags && tags.length > 0) attributes.set('langchain.tags', tags.join(','));
      if (callbackMetadata && Object.keys(callbackMetadata).length > 0) {
        attributes.set('langchain.metadata', describe(coerceJson(callbackMetadata)));
      }
      attributes.set('input.value', describe(coerceJson(inputs)));
      startSpan(runId, parentRunId, 'agentdock.langgraph.chain', attributes);
    },
    handleChainEnd: (outputs, runId) => {
      const span = spans.get(runId);
      if (span) span.setAttribute('output.value', describe(coerceJson(outputs)));
      endSpan(runId);
    },
    handleChainError: (error, runId) => failSpan(runId, error),
    handleToolStart: (tool, input, runId, parentRunId, tags, callbackMetadata, runName, toolCallId) => {
      const toolName = runName ?? serializedName(coerceJson(tool)) ?? 'tool';
      const attributes = baseAttributes(metadata);
      attributes.set('langchain.run.id', runId);
      attributes.set('gen_ai.tool.name', toolName);
      attributes.set('tool.name', toolName);
      attributes.set('input.value', truncate(input));
      setIfPresent(attributes, 'tool.call.id', toolCallId);
      if (tags && tags.length > 0) attributes.set('langchain.tags', tags.join(','));
      if (callbackMetadata && Object.keys(callbackMetadata).length > 0) {
        attributes.set('langchain.metadata', describe(coerceJson(callbackMetadata)));
      }
      startSpan(runId, parentRunId, `agentdock.langgraph.tool.${toolName}`, attributes);
    },
    handleToolEnd: (output, runId) => {
      const span = spans.get(runId);
      if (span) span.setAttribute('output.value', describe(coerceJson(output)));
      endSpan(runId);
    },
    handleToolError: (error, runId) => failSpan(runId, error),
    handleChatModelStart: (model, messages, runId, parentRunId, extraParams, tags, callbackMetadata, runName) => {
      const attributes = baseAttributes(metadata);
      attributes.set('langchain.run.id', runId);
      attributes.set('gen_ai.operation.name', 'chat');
      attributes.set('llm.request.type', 'chat');
      setIfPresent(attributes, 'langchain.run.name', runName);
      setIfPresent(attributes, 'langchain.serialized.name', serializedName(coerceJson(model)));
      if (tags && tags.length > 0) attributes.set('langchain.tags', tags.join(','));
      if (extraParams && Object.keys(extraParams).length > 0) {
        attributes.set('llm.invocation_parameters', describe(coerceJson(extraParams)));
      }
      if (callbackMetadata && Object.keys(callbackMetadata).length > 0) {
        attributes.set('langchain.metadata', describe(coerceJson(callbackMetadata)));
      }
      addChatPromptAttributes(attributes, messages[0] ?? []);
      startSpan(runId, parentRunId, 'agentdock.langgraph.llm', attributes);
    },
    handleLLMStart: (model, prompts, runId, parentRunId, extraParams, tags, callbackMetadata, runName) => {
      const attributes = baseAttributes(metadata);
      attributes.set('langchain.run.id', runId);
      attributes.set('gen_ai.operation.name', 'completion');
      attributes.set('llm.request.type', 'completion');
      setIfPresent(attributes, 'langchain.run.name', runName);
      setIfPresent(attributes, 'langchain.serialized.name', serializedName(coerceJson(model)));
      prompts.forEach((prompt, index) => {
        attributes.set(`gen_ai.prompt.${index}.content`, truncate(prompt));
      });
      attributes.set('gen_ai.prompt', describe(coerceJson(prompts)));
      if (tags && tags.length > 0) attributes.set('langchain.tags', tags.join(','));
      if (extraParams && Object.keys(extraParams).length > 0) {
        attributes.set('llm.invocation_parameters', describe(coerceJson(extraParams)));
      }
      if (callbackMetadata && Object.keys(callbackMetadata).length > 0) {
        attributes.set('langchain.metadata', describe(coerceJson(callbackMetadata)));
      }
      startSpan(runId, parentRunId, 'agentdock.langgraph.llm', attributes);
    },
    handleLLMEnd: (result: LLMResult, runId) => {
      const span = spans.get(runId);
      if (span) {
        addUsageAttributes(span, result);
        addCompletionAttributes(span, result);
      }
      endSpan(runId);
    },
    handleLLMError: (error, runId) => failSpan(runId, error),
  });
};
