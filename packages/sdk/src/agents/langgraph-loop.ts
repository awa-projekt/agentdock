import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { tool } from '@langchain/core/tools';
import { Command, interrupt } from '@langchain/langgraph';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { createAgent, ToolStrategy } from 'langchain';
import { coerceJson, isJsonObject, isJsonString, type Json, jsonProperty, jsonString } from '../schemas/json';
import type { ReasoningEffort } from '../schemas/reasoning';
import type { AgentTool, AgentToolSet } from '../tools';
import { contentPartsMiddleware, toolOutputContent, toolRunFailureMiddleware, userMessage } from './content';
import { inputRequiredRequestFromToolOutput } from './input-required';
import { createAgentOtelCallback } from './langgraph-otel';
import {
  type AgentLoop,
  AgentLoopError,
  AgentLoopFactory,
  type AgentLoopOptions,
  type AgentLoopOutcome,
  type AgentLoopStreamOptions,
  type ResolvedModel,
} from './loop';
import { contentFormatOf, createChatModel } from './providers';
import { ModelCallRecorder } from './usage';

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * Builds the LangChain chat model for a resolved model reference. A prebuilt
 * instance (test fakes, hosts that construct their own) wins; otherwise the
 * reference is built from its parts.
 */
const resolveChatModelInstance = (model: ResolvedModel, reasoningEffort: ReasoningEffort | undefined): BaseChatModel =>
  model.config?.chatModel ?? createChatModel(model.provider, model.modelId, model.config, reasoningEffort);

export const resumableToolOutput = async (tools: AgentToolSet, output: Json): Promise<Json> => {
  let current = output;
  while (true) {
    const request = inputRequiredRequestFromToolOutput(current);
    if (!request) return current;

    const response = coerceJson(interrupt(request));
    const continuation = request.resume;
    const toolName = isJsonObject(continuation) ? jsonString(continuation, 'toolName') : undefined;
    const continuationInput = isJsonObject(continuation) ? continuation.input : undefined;
    if (toolName === undefined || !isJsonObject(continuationInput)) {
      return response;
    }
    const resumeTool = tools.find((candidate) => candidate.name === toolName);
    if (!resumeTool) {
      throw new Error(`Input-required continuation tool '${toolName}' is not available.`);
    }
    const responseFields = isJsonObject(response) ? response : { content: response };
    current = await resumeTool.invoke({ ...continuationInput, ...responseFields });
  }
};

// LangChain accepts either a zod schema or JSON Schema, so tools that carry only
// `parameters` (executor tools, whose schemas come from plugin metadata) pass
// theirs through as-is rather than being narrowed to a zod approximation.
const toLangChainTool = (agentTool: AgentTool, tools: AgentToolSet) =>
  tool(async (input: Json) => toolOutputContent(await resumableToolOutput(tools, await agentTool.invoke(input))), {
    name: agentTool.name,
    description: agentTool.description,
    schema: agentTool.schema ?? agentTool.parameters,
  });

const toLangChainTools = (tools: AgentToolSet) => Array.from(tools, (agentTool) => toLangChainTool(agentTool, tools));

/**
 * Awaits the caller's `onEvent` handler so a subscriber that does async work
 * (e.g. writing to a UI, persisting) is a real sequencing barrier — the loop
 * won't emit the next event until the current one is fully handled.
 */
const emit = async (
  options: AgentLoopStreamOptions,
  event: Parameters<AgentLoopStreamOptions['onEvent']>[0],
): Promise<void> => {
  await options.onEvent(event);
};

export const createAgentGraph = (options: AgentLoopOptions) => {
  const base = {
    name: options.name,
    model: resolveChatModelInstance(options.model, options.reasoningEffort),
    systemPrompt: options.systemPrompt,
    tools: toLangChainTools(options.tools),
    middleware: [
      contentPartsMiddleware(contentFormatOf(options.model.provider, options.model.config)),
      toolRunFailureMiddleware,
    ],
  };
  // `checkpointer` is left off entirely when the caller has no persistence: passing
  // `false` would opt the graph out of the parent graph's checkpointer as well.
  const checkpointer =
    options.persistence?.kind === 'langgraph-checkpoint' ? options.persistence.checkpointer : undefined;
  const responseFormat =
    options.responseFormat === undefined ? undefined : ToolStrategy.fromSchema(options.responseFormat);

  if (checkpointer === undefined) {
    return responseFormat === undefined ? createAgent(base) : createAgent({ ...base, responseFormat });
  }
  return responseFormat === undefined
    ? createAgent({ ...base, checkpointer })
    : createAgent({ ...base, checkpointer, responseFormat });
};

const createLangGraphLoop = (options: AgentLoopOptions): AgentLoop => ({
  stream: (input, streamOptions) =>
    Effect.tryPromise({
      try: () =>
        AsyncLocalStorageProviderSingleton.runWithConfig(
          {},
          async () => {
            const agent = createAgentGraph(options);

            const abortSignal = streamOptions.signal ?? new AbortController().signal;

            // Only consulted when recovering: reading the checkpoint state throws
            // for a graph that was built without a checkpointer.
            const alreadyStreamedThisRequest =
              streamOptions.recover === true &&
              (await agent.graph
                .getState({ configurable: { thread_id: streamOptions.threadId } })
                .then(
                  (state) =>
                    jsonProperty(coerceJson(state.metadata), 'request_id') === streamOptions.trace?.userMessageId &&
                    Boolean(state.createdAt),
                ));
            const streamInput = alreadyStreamedThisRequest
              ? null
              : 'resume' in input
                ? new Command({ resume: input.resume })
                : { messages: [userMessage(input.parts)] };
            const streamConfig = {
              version: 'v3' as const,
              metadata: { request_id: streamOptions.trace?.userMessageId },
              durability: 'sync' as const,
              signal: abortSignal,
              configurable: { thread_id: streamOptions.threadId },
              callbacks: [
                // Each model call reports its own usage and tool calls. The stream's messages carry
                // usage but leave tool calls empty for a model that does not stream them.
                new ModelCallRecorder((report) =>
                  emit(streamOptions, { type: 'model-call', model: options.model.model, ...report }),
                ),
                ...(streamOptions.trace === undefined ? [] : [createAgentOtelCallback(streamOptions.trace)]),
              ],
            };
            const stream = await (streamOptions.context === undefined
              ? agent.streamEvents(streamInput, streamConfig)
              : agent.streamEvents(streamInput, { ...streamConfig, context: streamOptions.context }));

            let finalText = '';
            let finishData: { readonly finishReason: string; readonly usage: Json } | undefined;

            await Promise.all([
              (async () => {
                for await (const message of stream.messages) {
                  if (abortSignal.aborted) return;

                  for await (const text of message.text) {
                    if (abortSignal.aborted) return;
                    if (text.length === 0) continue;

                    finalText += text;
                    await emit(streamOptions, { type: 'text-delta', text });
                  }

                  for await (const reasoning of message.reasoning) {
                    if (reasoning.length > 0) await emit(streamOptions, { type: 'reasoning', text: reasoning });
                  }

                  const usage = await message.usage;
                  if (usage) finishData = { finishReason: 'stop', usage: coerceJson(usage) };
                }
              })(),
              (async () => {
                for await (const call of stream.toolCalls) {
                  if (abortSignal.aborted) return;
                  const toolCallId = call.callId;

                  // `call.output` rejects when the tool errors. We read `call.error`
                  // below and may `continue`/`return` without ever awaiting `output`,
                  // which would surface as an unhandled rejection and crash the
                  // process. Attach a no-op handler eagerly so the rejection is
                  // always consumed; the success branch still awaits `output`.
                  void call.output.catch(() => {});

                  await emit(streamOptions, {
                    type: 'tool-call',
                    toolCallId,
                    toolName: call.name,
                    input: coerceJson(call.input),
                  });

                  const error = await call.error;
                  if (error) {
                    await emit(streamOptions, {
                      type: 'tool-error',
                      toolCallId,
                      toolName: call.name,
                      error: errorMessage(error),
                    });
                    continue;
                  }

                  const output = await call.output;
                  await emit(streamOptions, {
                    type: 'tool-result',
                    toolCallId,
                    toolName: call.name,
                    output: coerceJson(output),
                  });
                }
              })(),
            ]);

            if (abortSignal.aborted) {
              return { text: finalText, interrupted: false };
            }

            if (finishData)
              await emit(streamOptions, {
                type: 'finish',
                finishReason: finishData.finishReason,
                usage: finishData.usage,
              });

            if (stream.interrupted)
              return { text: finalText, interrupted: true, interrupts: coerceJson(stream.interrupts) };
            const finalState = await stream.output;
            const structuredResponse =
              options.responseFormat === undefined
                ? undefined
                : jsonProperty(coerceJson(finalState), 'structuredResponse');

            const finalMessage = finalState.messages.at(-1);
            const finalContent = coerceJson(finalMessage?.content);
            const outcome: AgentLoopOutcome = {
              text: isJsonString(finalContent) ? finalContent : finalText,
              interrupted: stream.interrupted,
            };
            const withStructured = structuredResponse === undefined ? outcome : { ...outcome, structuredResponse };
            return stream.interrupted
              ? { ...withStructured, interrupts: coerceJson(stream.interrupts) }
              : withStructured;
          },
          true,
        ),
      catch: (error) => new AgentLoopError({ message: errorMessage(error), error }),
    }),
});

export const AgentLoopFactoryLive: Layer.Layer<AgentLoopFactory> = Layer.succeed(
  AgentLoopFactory,
  AgentLoopFactory.of({
    create: (options) => Effect.succeed(createLangGraphLoop(options)),
  }),
);
