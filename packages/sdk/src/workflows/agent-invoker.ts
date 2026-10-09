import type { Message, MessageSendParams, Part, Task, TaskArtifactUpdateEvent } from '@a2a-js/sdk';
import * as Effect from 'effect/Effect';
import type * as HttpClient from 'effect/http/HttpClient';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { tracedA2aClientFactory } from '../a2a/client';
import type { AgentLoopFactory } from '../agents/loop';
import type { ModelProvider } from '../agents/model-provider';
import type { AgentRunStore } from '../agents/run-store';
import type { AgentToolResolver } from '../agents/tool-resolver';
import { randomUUIDv4 } from '../random';
import { normalizeBaseUrl } from '../routes';
import type { InputContract, Json, JsonObject, JsonObjectDraft } from '../schemas';
import {
  AgentCallProgressState,
  coerceJson,
  decodeJsonObjectOption,
  workflowA2AAgentInvocationEnvelope,
} from '../schemas';
import type { WorkflowAgentBinding } from './bindings';
import { consumeCancellation, publishStepProgress, type StepRef, type WorkflowRunContext } from './events';
import type { WorkflowRunStore, WorkflowRunStoreError } from './run-store';
import { workflowInputMode } from './task-input';
import type { WorkflowToolInvoker } from './tool-invoker';

/** An agent binding that is called with a message, as opposed to a child workflow. */
export type CallableAgentBinding = Extract<WorkflowAgentBinding, { kind: 'internal' | 'external' }>;

export type AgentCallResult = {
  readonly text: string;
  /** Parsed output when the agent declares an output schema, else undefined. */
  readonly structured: Json | undefined;
  readonly contextId: string | undefined;
  readonly taskId: string | undefined;
};

export class WorkflowAgentCallError extends Schema.TaggedError<WorkflowAgentCallError>()('WorkflowAgentCallError', {
  message: Schema.String,
  error: Schema.Defect(),
}) {}

export type AgentInvokerServices =
  | HttpClient.HttpClient
  | WorkflowRunStore
  | AgentLoopFactory
  | ModelProvider
  | AgentToolResolver
  | AgentRunStore
  | WorkflowToolInvoker;

export const textFromMessage = (message: Message | undefined): string =>
  message?.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('') ?? '';

const textFromArtifact = (event: TaskArtifactUpdateEvent): string =>
  event.artifact.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('');

const dataFromParts = (parts: ReadonlyArray<Part>): Json | undefined => {
  const [data] = parts.flatMap((part) => (part.kind === 'data' ? [part.data] : []));
  return data === undefined ? undefined : Option.getOrUndefined(decodeJsonObjectOption(data));
};

export const dataFromMessage = (message: Message | undefined): Json | undefined =>
  message ? dataFromParts(message.parts) : undefined;

const dataFromArtifact = (event: TaskArtifactUpdateEvent): Json | undefined => dataFromParts(event.artifact.parts);

const textFromTask = (task: Task): string => textFromMessage(task.status.message);

const bindingId = (binding: CallableAgentBinding): string =>
  binding.kind === 'internal' ? binding.agent.id : binding.id;

const bindingName = (binding: CallableAgentBinding): string =>
  binding.kind === 'internal' ? binding.agent.name : binding.name;

const bindingInputContract = (binding: CallableAgentBinding): InputContract | undefined =>
  (binding.kind === 'internal' ? binding.agent.inputContract : binding.inputContract) ?? undefined;

const toCallError = (cause: unknown): WorkflowAgentCallError =>
  new WorkflowAgentCallError({
    message: cause instanceof Error ? cause.message : String(cause),
    error: cause,
  });

const jsonOutput = (value: Json | undefined): string | undefined => {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
};

/**
 * Turn the caller's `string | JsonObject` into a2a parts, honouring the target
 * agent's own input contract: a data-mode agent gets a data part, everything
 * else gets text.
 */
export const inputParts = (binding: CallableAgentBinding, input: string | JsonObject): ReadonlyArray<Part> => {
  const contract = bindingInputContract(binding);
  const mode = contract ? workflowInputMode(contract) : 'text';

  if (Predicate.isString(input)) {
    return mode === 'data' ? [{ kind: 'data', data: { input } }] : [{ kind: 'text', text: input }];
  }

  return mode === 'text' ? [{ kind: 'text', text: JSON.stringify(input) }] : [{ kind: 'data', data: { ...input } }];
};

const sendPayload = (binding: CallableAgentBinding, parts: ReadonlyArray<Part>): JsonObject => {
  const message = parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n');
  const dataPart = parts.find((part) => part.kind === 'data');
  const payload: JsonObjectDraft = {
    agentId: bindingId(binding),
    agentName: bindingName(binding),
  };
  if (message) payload.message = message;
  if (dataPart) payload.data = coerceJson(dataPart.data);
  return payload;
};

const createMessageSendParams = (
  parts: ReadonlyArray<Part>,
  messageId: string,
  contextId: string | undefined,
): MessageSendParams => {
  const message: MessageSendParams['message'] = {
    kind: 'message',
    messageId,
    parts: [...parts],
    role: 'user',
  };
  if (contextId) message.contextId = contextId;
  return { configuration: { blocking: false }, message };
};

type ExternalStreamState = {
  readonly output: string;
  readonly structured: Json | undefined;
  readonly canceled: boolean;
  readonly taskId: string | undefined;
  readonly contextId: string | undefined;
};

/** External binding: a2a client streaming against the binding's own URL. */
export const callExternalAgent = (
  context: WorkflowRunContext,
  binding: Extract<WorkflowAgentBinding, { kind: 'external' }>,
  step: StepRef,
  parts: ReadonlyArray<Part>,
  contextId: string | undefined,
): Effect.Effect<AgentCallResult, WorkflowAgentCallError | WorkflowRunStoreError, AgentInvokerServices> =>
  Effect.gen(function* () {
    const agentId = binding.id;
    const stepId = step.stepId;
    yield* publishStepProgress(context, step, AgentCallProgressState.Send, sendPayload(binding, parts));
    const clientFactory = yield* tracedA2aClientFactory;
    const client = yield* Effect.tryPromise({
      try: () => clientFactory.createFromUrl(`${normalizeBaseUrl(binding.url)}/`),
      catch: toCallError,
    });

    const params = createMessageSendParams(
      [
        ...parts,
        {
          kind: 'data',
          data: workflowA2AAgentInvocationEnvelope({
            workflowId: context.workflow.id,
            runId: context.runId,
            taskId: context.taskId,
            contextId: context.contextId,
            stepId,
          }),
        },
      ],
      `${context.taskId}:${stepId}:${yield* randomUUIDv4}`,
      contextId,
    );

    const result = yield* Stream.fromAsyncIterable(client.sendMessageStream(params), toCallError).pipe(
      Stream.runFoldEffect(
        (): ExternalStreamState => ({
          output: '',
          structured: undefined,
          canceled: false,
          taskId: undefined,
          contextId,
        }),
        (state, event) =>
          state.canceled
            ? Effect.succeed(state)
            : Effect.gen(function* () {
                if (yield* consumeCancellation(context)) {
                  return { ...state, canceled: true };
                }

                if (event.kind === 'artifact-update') {
                  const text = textFromArtifact(event);
                  const data = dataFromArtifact(event);
                  yield* publishStepProgress(
                    context,
                    step,
                    AgentCallProgressState.Artifact,
                    data === undefined ? { agentId, text } : { agentId, data },
                  );
                  return data === undefined
                    ? { ...state, output: state.output + text }
                    : { ...state, structured: data, output: jsonOutput(data) ?? state.output };
                }

                if (event.kind === 'status-update') {
                  const statusText = textFromMessage(event.status.message);
                  const statusData = dataFromMessage(event.status.message);
                  const statusProgress: JsonObjectDraft = {
                    agentId,
                    taskState: event.status.state,
                    final: event.final,
                  };
                  if (statusText) statusProgress.message = statusText;
                  if (statusData !== undefined) statusProgress.data = statusData;
                  yield* publishStepProgress(context, step, AgentCallProgressState.Status, statusProgress);
                  if (event.status.state === 'failed') {
                    return yield* new WorkflowAgentCallError({
                      message: `Agent '${binding.name}' run failed${statusText ? `: ${statusText}` : '.'}`,
                      error: { agentId, stepId },
                    });
                  }
                  if (event.status.state === 'input-required') {
                    return yield* new WorkflowAgentCallError({
                      message:
                        `Agent '${binding.name}' paused for input, which ctx.agents.call cannot answer. ` +
                        `Model the gate with interrupt() in the workflow instead.`,
                      error: { agentId, stepId },
                    });
                  }
                  const finalOutput = event.final ? (jsonOutput(statusData) ?? statusText) : undefined;
                  return {
                    ...state,
                    taskId: event.taskId,
                    contextId: event.contextId,
                    structured: statusData === undefined ? state.structured : statusData,
                    output: finalOutput ? finalOutput : state.output,
                  };
                }

                if (event.kind === 'task') {
                  yield* publishStepProgress(context, step, AgentCallProgressState.Task, {
                    agentId,
                    taskId: event.id,
                    taskState: event.status.state,
                  });
                  return { ...state, taskId: event.id, contextId: event.contextId, output: textFromTask(event) };
                }

                if (event.kind === 'message') {
                  const messageText = textFromMessage(event);
                  const messageData = dataFromMessage(event);
                  const messageProgress: JsonObjectDraft = { agentId };
                  if (messageText) messageProgress.message = messageText;
                  if (messageData !== undefined) messageProgress.data = messageData;
                  yield* publishStepProgress(context, step, AgentCallProgressState.Message, messageProgress);
                  return {
                    ...state,
                    taskId: event.taskId ?? state.taskId,
                    contextId: event.contextId ?? state.contextId,
                    structured: messageData === undefined ? state.structured : messageData,
                    output: (jsonOutput(messageData) ?? messageText) || state.output,
                  };
                }

                return state;
              }),
      ),
    );

    if (result.canceled) {
      return yield* new WorkflowAgentCallError({
        message: `Agent '${binding.name}' was canceled.`,
        error: { agentId, stepId },
      });
    }

    return {
      text: result.output,
      structured: result.structured,
      contextId: result.contextId,
      taskId: result.taskId,
    };
  });
