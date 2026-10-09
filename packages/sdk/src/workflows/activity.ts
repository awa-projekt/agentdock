import { BaseCallbackHandler, type NewTokenIndices } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import { type BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import * as Option from 'effect/Option';
import { type ModelCallReport, modelCallReport } from '../agents/usage';
import {
  AgentLoopProgressState,
  coerceJson,
  decodeJsonStringOption,
  type Json,
  type JsonObject,
  jsonString,
  ModelCallProgressState,
  ModelTokenProgressState,
} from '../schemas';
import type { StepRef } from './events';

/**
 * What runs inside a step, reported as the step's progress while it happens:
 * every model call with its usage, the text a bound model streams, and each
 * tool call a bound agent's own loop makes. A run's cost and tool calls are
 * these events summed up; the run view shows them under the step.
 */

/** Publishes one progress event on the step that is calling; awaited, so none is lost when the step ends. */
export type PublishActivity = (state: string, data: JsonObject) => Promise<void>;

/** Who made a model call: a bound agent, or a bound model under its manifest name. */
export type ModelCaller = { readonly agentId: string } | { readonly modelName: string };

/** A model call as the `model-call` progress event carries it. */
const modelCallData = (caller: ModelCaller, model: string, report: ModelCallReport): JsonObject => ({
  ...caller,
  model,
  usage: report.usage === undefined ? null : coerceJson(report.usage),
  toolCalls: report.toolCalls,
  reasoningEstimated: report.reasoningEstimated,
});

/** Publishes one progress event on a given step. */
export type PublishStepActivity = (step: StepRef, state: string, data: JsonObject) => Promise<void>;

/**
 * Reports every call of a model with its usage, and the text a bound model
 * streams, on the step that made the call. Callbacks run outside the calling code's
 * context, so the step is read from the call's own metadata when it starts
 * (`checkpoint_ns`, the namespace of the task that called).
 */
export class ModelActivityRecorder extends BaseCallbackHandler {
  name = 'agentdock-model-activity';
  private readonly steps = new Map<string, StepRef>();

  constructor(
    private readonly caller: ModelCaller,
    private readonly model: string,
    private readonly stepOf: (checkpointNamespace: string | undefined) => StepRef,
    private readonly publish: PublishStepActivity,
  ) {
    super({ _awaitHandler: true });
  }

  private step(runId: string): StepRef {
    return this.steps.get(runId) ?? this.stepOf(undefined);
  }

  override async handleChatModelStart(
    _llm: Serialized,
    _messages: ReadonlyArray<ReadonlyArray<BaseMessage>>,
    runId: string,
    _parentRunId?: string,
    _extraParams?: JsonObject,
    _tags?: ReadonlyArray<string>,
    metadata?: JsonObject,
  ): Promise<void> {
    this.steps.set(runId, this.stepOf(jsonString(metadata, 'checkpoint_ns')));
  }

  override async handleLLMNewToken(token: string, _idx: NewTokenIndices, runId: string): Promise<void> {
    // A bound agent's text already streams as `a2a-artifact`, the way an external agent's arrives.
    if (token.length > 0 && 'modelName' in this.caller)
      await this.publish(this.step(runId), ModelTokenProgressState, { ...this.caller, text: token });
  }

  override async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    const step = this.step(runId);
    this.steps.delete(runId);
    await this.publish(step, ModelCallProgressState, modelCallData(this.caller, this.model, modelCallReport(output)));
  }
}

const toolInput = (input: string): Json => Option.getOrElse(decodeJsonStringOption(input), (): Json => input);

/** A tool's answer as it reached the model: the content of its tool message. */
const toolOutput = (output: ToolMessage | Json): Json =>
  ToolMessage.isInstance(output) ? coerceJson(output.content) : coerceJson(output);

/**
 * Reports each tool call a bound agent's loop makes, and its outcome, as
 * progress of the calling step, and keeps them as the agent run's record:
 * `tool-call`, `tool-result` and `tool-error` data, as any agent run records.
 */
export class AgentToolRecorder extends BaseCallbackHandler {
  name = 'agentdock-agent-tools';
  readonly recorded: Array<JsonObject> = [];
  private readonly names = new Map<string, string>();

  constructor(
    private readonly agentId: string,
    private readonly publish: PublishActivity,
  ) {
    super({ _awaitHandler: true });
  }

  private async report(state: string, data: JsonObject): Promise<void> {
    this.recorded.push(data);
    await this.publish(state, { agentId: this.agentId, ...data });
  }

  override async handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    _parentRunId?: string,
    _tags?: ReadonlyArray<string>,
    _metadata?: JsonObject,
    runName?: string,
  ): Promise<void> {
    const toolName = runName ?? tool.id.at(-1) ?? 'tool';
    this.names.set(runId, toolName);
    await this.report(AgentLoopProgressState.ToolCall, {
      type: 'tool-call',
      toolName,
      toolCallId: runId,
      input: toolInput(input),
    });
  }

  override async handleToolEnd(output: ToolMessage | Json, runId: string): Promise<void> {
    await this.report(AgentLoopProgressState.ToolResult, {
      type: 'tool-result',
      toolName: this.names.get(runId) ?? 'tool',
      toolCallId: runId,
      output: toolOutput(output),
    });
  }

  override async handleToolError(cause: unknown, runId: string): Promise<void> {
    await this.report(AgentLoopProgressState.ToolError, {
      type: 'tool-error',
      toolName: this.names.get(runId) ?? 'tool',
      toolCallId: runId,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
