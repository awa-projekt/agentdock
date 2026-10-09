import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import * as Clock from 'effect/Clock';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { randomUUIDv4 } from '../random';
import type { AgentRunMessage, AgentRunOrigin, AgentRunRecord } from '../schemas/agent-runs';
import { coerceJson, isJsonObject, type Json, type JsonObject } from '../schemas/json';
import type { AgentToolSet } from '../tools';
import type { AgentDefinition } from './definition';
import { inputRequiredRequestFromToolOutput } from './input-required';
import { type AgentLoopEvent, AgentLoopFactory, type AgentLoopInput, type AgentLoopTraceContext } from './loop';
import { ModelProvider } from './model-provider';
import { AgentRunStore, type AgentRunStoreError } from './run-store';
import { type AgentToolContext, AgentToolResolver } from './tool-resolver';

export class AgentRunError extends Schema.TaggedError<AgentRunError>()('AgentRunError', {
  message: Schema.String,
  error: Schema.Defect(),
}) {}

export type RunAgentOptions = {
  readonly deployment?: import('../runtime/types').GraphDeployment | undefined;
  /** Continue an existing record: appends to its history and reuses its contextId. */
  readonly recover?: boolean | undefined;
  readonly taskId?: string | undefined;
  readonly contextId?: string | undefined;
  /** Defaults to `{ surface: 'sdk' }` for direct programmatic runs. */
  readonly origin?: AgentRunOrigin | undefined;
  readonly checkpointer?: BaseCheckpointSaver | undefined;
  /** Defaults to `agent:${agent.id}:context:${contextId}`. */
  readonly threadId?: string | undefined;
  /**
   * The id of the inbound user message. Defaults to a generated UUID; the a2a
   * executor passes the real request message id so the persisted record and
   * OTel span carry the genuine inbound id rather than a synthetic one.
   */
  readonly userMessageId?: string | undefined;
  /** Merged after the tool resolver's output. */
  readonly tools?: AgentToolSet | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onEvent?: ((event: AgentLoopEvent) => void | Promise<void>) | undefined;
  /** Handed to tools that relay activity onto the caller's stream, such as `send_task`. */
  readonly emit?: AgentToolContext['emit'];
  /** Defaults to true. A transport with its own task store can own persistence instead. */
  readonly persist?: boolean | undefined;
  /**
   * Populates the resolved tool context's `workflow` field, letting tools
   * (e.g. `send_task`) nest their progress under the enclosing workflow node
   * call. Set by workflow agent nodes from the enclosing a2a task's
   * taskId/contextId; absent for a2a and direct SDK calls.
   */
  readonly workflow?: AgentToolContext['workflow'] | undefined;
  /** Integrations this run reaches somewhere else than registered, handed to its tools. */
  readonly integrations?: AgentToolContext['integrations'] | undefined;
};

export type AgentRunResult = {
  readonly taskId: string;
  readonly contextId: string;
  readonly status: 'completed' | 'input-required' | 'canceled' | 'failed';
  readonly text: string;
  readonly structured?: JsonObject | undefined;
  readonly inputRequired?: JsonObject | undefined;
  readonly record: AgentRunRecord;
};

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const mapStoreError = <A>(effect: Effect.Effect<A, AgentRunStoreError>): Effect.Effect<A, AgentRunError> =>
  effect.pipe(Effect.mapError((error) => new AgentRunError({ message: error.message, error })));

type LoopOutcomeResult =
  | { readonly kind: 'success'; readonly text: string; readonly structured: Json | undefined }
  | { readonly kind: 'input-required'; readonly request: JsonObject }
  | { readonly kind: 'canceled' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Runs one turn of an agent: resolves its model and tools, creates or
 * continues its `AgentRunRecord`, drives the agent loop, and persists the
 * outcome. This is the primitive every surface builds on: A2A and AG-UI adapt
 * its raw events independently, while workflow nodes invoke it in-process.
 * Every agent invocation is therefore recorded the same way and individually
 * inspectable.
 */
export const runAgent = (
  agent: AgentDefinition,
  input: AgentLoopInput,
  options?: RunAgentOptions,
): Effect.Effect<AgentRunResult, AgentRunError, AgentLoopFactory | ModelProvider | AgentToolResolver | AgentRunStore> =>
  Effect.gen(function* () {
    const loopFactory = yield* AgentLoopFactory;
    const modelProvider = yield* ModelProvider;
    const toolResolver = yield* AgentToolResolver;
    const runStore = yield* AgentRunStore;

    // Captured once: these records are plain data assembled inline, and
    // `currentTimeMillisUnsafe` is the Clock's synchronous accessor, so the
    // timestamps still follow `TestClock` without threading an effect through
    // every field.
    const clock = yield* Clock.Clock;
    const now = (): string => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));
    const origin: AgentRunOrigin = options?.origin ?? { surface: 'sdk' };
    const persist = options?.persist ?? true;

    const existing = persist && options?.taskId ? yield* mapStoreError(runStore.get(options.taskId)) : null;
    const taskId = existing?.id ?? options?.taskId ?? (yield* randomUUIDv4);
    const contextId = existing?.contextId ?? options?.contextId ?? (yield* randomUUIDv4);
    const userMessageId = options?.userMessageId ?? (yield* randomUUIDv4);
    const threadId = options?.threadId ?? `agent:${agent.id}:context:${contextId}`;

    // Ids only have to be unique inside the record they land in; this turn's
    // own id makes the counter unique across the turns of a resumed run.
    const turnId = yield* randomUUIDv4;
    let sequence = 0;
    const nextId = (): string => {
      sequence += 1;
      return `${turnId}:${sequence}`;
    };
    const dataMessage = (data: JsonObject): AgentRunMessage => ({
      role: 'agent',
      messageId: nextId(),
      parts: [{ kind: 'data', data }],
    });

    const userMessage: AgentRunMessage = {
      role: 'user',
      messageId: userMessageId,
      parts: 'resume' in input ? [{ kind: 'data', data: { type: 'resume', response: input.resume } }] : input.parts,
    };

    let record: AgentRunRecord =
      existing ??
      ({
        id: taskId,
        contextId,
        agentId: agent.id,
        status: { state: 'submitted', timestamp: now() },
        history: [],
        artifacts: [],
        origin,
        createdAt: now(),
        updatedAt: now(),
      } satisfies AgentRunRecord);

    if (persist && !existing) {
      yield* mapStoreError(runStore.save(record));
    }

    record = {
      ...record,
      status: { state: 'working', timestamp: now() },
      history: [...record.history, userMessage],
      updatedAt: now(),
    };
    if (persist) yield* mapStoreError(runStore.save(record));

    const toolContext: AgentToolContext = {
      deployment: options?.deployment,
      taskId,
      contextId,
      userMessageId,
      emit: options?.emit,
      workflow: options?.workflow,
      integrations: options?.integrations,
    };
    const extraMessages: Array<AgentRunMessage> = [];
    let inputRequiredRequest: JsonObject | null = null;

    const abortController = new AbortController();
    if (options?.signal) {
      if (options.signal.aborted) abortController.abort();
      else options.signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    const onEvent = (event: AgentLoopEvent): void | Promise<void> => {
      if (event.type === 'tool-call') {
        extraMessages.push(
          dataMessage({
            type: 'tool-call',
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            input: coerceJson(event.input),
          }),
        );
      } else if (event.type === 'tool-result') {
        extraMessages.push(
          dataMessage({
            type: 'tool-result',
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            output: coerceJson(event.output),
          }),
        );
        const request = inputRequiredRequestFromToolOutput(event.output);
        if (request) {
          inputRequiredRequest = request;
          abortController.abort();
        }
      } else if (event.type === 'tool-error') {
        extraMessages.push(
          dataMessage({
            type: 'tool-error',
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            error: event.error,
          }),
        );
      } else if (event.type === 'reasoning') {
        extraMessages.push(dataMessage({ type: 'reasoning', text: event.text }));
      }
      return options?.onEvent?.(event);
    };

    const outcomeResult: LoopOutcomeResult = yield* Effect.gen(function* () {
      const model = yield* modelProvider.resolve(agent.model);
      const resolvedTools = yield* toolResolver.resolve(agent, toolContext);
      const loop = yield* loopFactory.create({
        name: agent.id,
        model,
        reasoningEffort: agent.reasoningEffort ?? undefined,
        systemPrompt: agent.instructions,
        tools: [...resolvedTools, ...(options?.tools ?? [])],
        responseFormat: agent.outputSchema,
        persistence:
          options?.checkpointer === undefined
            ? undefined
            : { kind: 'langgraph-checkpoint', checkpointer: options.checkpointer },
      });

      const trace: AgentLoopTraceContext = {
        agentId: agent.id,
        agentName: agent.name,
        model: agent.model,
        taskId,
        contextId,
        userMessageId,
      };

      const outcome = yield* loop.stream(input, {
        threadId,
        signal: abortController.signal,
        trace,
        onEvent,
        recover: options?.recover,
      });

      if (inputRequiredRequest) return { kind: 'input-required', request: inputRequiredRequest } as const;
      if (options?.signal?.aborted) return { kind: 'canceled' } as const;
      if (outcome.interrupted) {
        return {
          kind: 'input-required',
          request: {
            type: 'input-required',
            source: 'agent-loop-interrupt',
            interrupts: coerceJson(outcome.interrupts),
          },
        } as const;
      }
      return { kind: 'success', text: outcome.text, structured: outcome.structuredResponse } as const;
    }).pipe(
      Effect.catch(
        (error): Effect.Effect<LoopOutcomeResult> =>
          Effect.succeed(
            options?.signal?.aborted ? { kind: 'canceled' } : { kind: 'failed', message: errorMessage(error) },
          ),
      ),
    );

    switch (outcomeResult.kind) {
      case 'success': {
        const coerced =
          agent.outputSchema && outcomeResult.structured !== undefined
            ? coerceJson(outcomeResult.structured)
            : undefined;
        // Structured outputs are object-shaped by contract; a non-object
        // response falls back to the plain-text path.
        const structured = isJsonObject(coerced) ? coerced : undefined;
        const message: AgentRunMessage =
          structured !== undefined
            ? { role: 'agent', messageId: nextId(), parts: [{ kind: 'data', data: structured }] }
            : { role: 'agent', messageId: nextId(), parts: [{ kind: 'text', text: outcomeResult.text }] };
        const artifact =
          structured !== undefined
            ? { artifactId: nextId(), name: agent.name, parts: [{ kind: 'data' as const, data: structured }] }
            : {
                artifactId: nextId(),
                name: agent.name,
                parts: [{ kind: 'text' as const, text: outcomeResult.text }],
              };
        record = {
          ...record,
          status: { state: 'completed', timestamp: now(), message },
          history: [...record.history, ...extraMessages, message],
          artifacts: [...record.artifacts, artifact],
          updatedAt: now(),
        };
        if (persist) yield* mapStoreError(runStore.save(record));
        return {
          taskId,
          contextId,
          status: 'completed',
          text: outcomeResult.text,
          structured,
          record,
        } satisfies AgentRunResult;
      }
      case 'input-required': {
        const message = dataMessage(outcomeResult.request);
        record = {
          ...record,
          status: { state: 'input-required', timestamp: now(), message },
          history: [...record.history, ...extraMessages, message],
          updatedAt: now(),
        };
        if (persist) yield* mapStoreError(runStore.save(record));
        return {
          taskId,
          contextId,
          status: 'input-required',
          text: '',
          inputRequired: outcomeResult.request,
          record,
        } satisfies AgentRunResult;
      }
      case 'canceled': {
        record = {
          ...record,
          status: { state: 'canceled', timestamp: now() },
          history: [...record.history, ...extraMessages],
          updatedAt: now(),
        };
        if (persist) yield* mapStoreError(runStore.save(record));
        return { taskId, contextId, status: 'canceled', text: '', record } satisfies AgentRunResult;
      }
      case 'failed': {
        const message: AgentRunMessage = {
          role: 'agent',
          messageId: nextId(),
          parts: [{ kind: 'text', text: outcomeResult.message }],
        };
        record = {
          ...record,
          status: { state: 'failed', timestamp: now(), message },
          history: [...record.history, ...extraMessages, message],
          updatedAt: now(),
        };
        if (persist) yield* mapStoreError(runStore.save(record));
        return { taskId, contextId, status: 'failed', text: '', record } satisfies AgentRunResult;
      }
    }

    // Unreachable: `outcomeResult.kind` is exhaustively handled above. Keeps
    // the generator's inferred return type `AgentRunResult` instead of
    // `AgentRunResult | undefined`.
    return outcomeResult;
  });
