import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import type { AgentRunPart } from '../schemas/agent-runs';
import type { Json, JsonObject } from '../schemas/json';
import type { ReasoningEffort } from '../schemas/reasoning';
import type { TokenUsage } from '../schemas/usage';
import type { AgentToolSet } from '../tools';
import type { ModelRuntimeConfig } from './providers';

export type ResolvedModel = {
  /** The original `provider:modelId` string the agent was configured with. */
  readonly model: string;
  readonly provider: string;
  readonly modelId: string;
  /** Provider credentials/runtime overrides (api key, base URL, custom kind). */
  readonly config?: ModelRuntimeConfig | undefined;
};

export type AgentLoopPersistence = {
  readonly kind: 'langgraph-checkpoint';
  readonly checkpointer: BaseCheckpointSaver;
};

export type AgentLoopTraceContext = {
  readonly agentId: string;
  readonly agentName: string;
  readonly model: string;
  readonly taskId: string;
  readonly contextId: string;
  readonly userMessageId: string;
};

export type AgentLoopEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'tool-call'; readonly toolCallId: string; readonly toolName: string; readonly input: Json }
  | { readonly type: 'tool-result'; readonly toolCallId: string; readonly toolName: string; readonly output: Json }
  | { readonly type: 'tool-error'; readonly toolCallId: string; readonly toolName: string; readonly error: string }
  | { readonly type: 'finish'; readonly finishReason: string; readonly usage: Json }
  /**
   * One model call completed. The loop makes one per step: calls that end in
   * tool calls, and the call that writes the answer.
   */
  | {
      readonly type: 'model-call';
      /** The configured `provider:model` the call went to, the key the model catalog prices by. */
      readonly model: string;
      /** Absent when the provider reported no usage for the call. */
      readonly usage: TokenUsage | undefined;
      readonly toolCalls: number;
      /** The thinking share of `usage.output` is an estimate: the provider did not count it separately. */
      readonly reasoningEstimated: boolean;
    };

export type AgentLoopOutcome = {
  /** Accumulated final text (empty when the turn only produced structured output). */
  readonly text: string;
  /** Present when the loop ran with a `responseFormat` and produced a structured answer. */
  readonly structuredResponse?: Json | undefined;

  readonly interrupted: boolean;
  readonly interrupts?: Json | undefined;
};

export type AgentLoopStreamOptions = {
  readonly recover?: boolean | undefined;
  readonly threadId: string;
  readonly signal?: AbortSignal | undefined;

  readonly trace?: AgentLoopTraceContext | undefined;

  readonly context?: JsonObject;
  readonly onEvent: (event: AgentLoopEvent) => void | Promise<void>;
};

/** A user turn as the caller's message parts (text, files, data), or the answer that resumes an interrupt. */
export type AgentLoopInput = { readonly parts: ReadonlyArray<AgentRunPart> } | { readonly resume: Json };

export type AgentLoop = {
  readonly stream: (
    input: AgentLoopInput,
    options: AgentLoopStreamOptions,
  ) => Effect.Effect<AgentLoopOutcome, AgentLoopError>;
};

export type AgentLoopOptions = {
  readonly name: string;
  readonly model: ResolvedModel;
  readonly reasoningEffort?: ReasoningEffort | undefined;
  readonly systemPrompt: string;
  readonly tools: AgentToolSet;
  /** Parsed JSON Schema; when set the loop runs with structured output. */
  readonly responseFormat?: JsonObject | undefined;
  readonly persistence?: AgentLoopPersistence | undefined;
};

export class AgentLoopError extends Schema.TaggedError<AgentLoopError>()('AgentLoopError', {
  message: Schema.String,
  error: Schema.Defect(),
}) {}

export class AgentLoopFactory extends Context.Service<
  AgentLoopFactory,
  {
    readonly create: (options: AgentLoopOptions) => Effect.Effect<AgentLoop, AgentLoopError>;
  }
>()('agentdock-sdk/agents/loop/AgentLoopFactory') {}
