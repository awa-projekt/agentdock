import type { AgentExecutionEvent, AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import type { AgentDefinition } from '../agents/definition';
import type { AgentLoopEvent, AgentLoopInput } from '../agents/loop';
import type { AgentRunResult, RunAgentOptions } from '../agents/run';
import type { AgentToolContext, WorkflowToolInvocation } from '../agents/tool-resolver';
import {
  coerceJson,
  decodeJsonStringOption,
  decodeWorkflowA2AEnvelopeOption,
  isJsonObject,
  type Json,
  type JsonObject,
  type JsonSerializableObject,
  jsonProperty,
  jsonString,
} from '../schemas';
import type { AgentToolSet } from '../tools';
import {
  agentDataMessage,
  canceledStatusEvent,
  completedDataStatusEvent,
  completedStatusEvent,
  failedStatusEvent,
  inputRequiredStatusEvent,
  messageStatusEvent,
  responseArtifactEvent,
  responseDataArtifactEvent,
  submittedTaskEvent,
  workingStatusEvent,
} from './events';
import { addToContextHistory, type ContextHistoryStore } from './history';
import { agentInputParts, integrationOverridesOf } from './message-parts';

export type { AgentToolContext } from '../agents/tool-resolver';

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const textFromMessage = (message: RequestContext['userMessage']): string =>
  message.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n');

const dataResponseFromMessage = (message: RequestContext['userMessage']): Json | undefined => {
  for (const part of message.parts) {
    if (part.kind !== 'data') continue;
    const data = coerceJson(part.data);
    if (jsonString(data, 'type') === 'input-required-response') return jsonProperty(data, 'response');
  }
  return undefined;
};

const responseFromText = (text: string): JsonObject => {
  const normalized = text.trim().toLowerCase();
  if (['yes', 'y', 'approve', 'accept'].includes(normalized)) return { action: 'accept' };
  if (['no', 'n', 'decline', 'deny'].includes(normalized)) return { action: 'decline' };
  if (normalized === 'cancel') return { action: 'cancel' };
  const parsed = Option.getOrUndefined(decodeJsonStringOption(text));
  if (parsed === undefined) return { action: 'accept', content: { value: text } };
  return isJsonObject(parsed) && 'action' in parsed ? parsed : { action: 'accept', content: parsed };
};

const logExecutor = (message: string, data: JsonSerializableObject = {}): void => {
  Effect.runSync(Effect.logInfo(`[a2a-executor] ${message}`).pipe(Effect.annotateLogs(data)));
};

const workflowInvocation = (requestContext: RequestContext): WorkflowToolInvocation | undefined => {
  for (const part of requestContext.userMessage.parts) {
    if (part.kind !== 'data') continue;
    const envelope = decodeWorkflowA2AEnvelopeOption(part.data);
    if (Option.isNone(envelope) || envelope.value.type !== 'workflow-agent-invocation') {
      continue;
    }
    const invocation = envelope.value;
    return {
      workflowId: invocation.workflowId,
      runId: invocation.runId,
      taskId: invocation.taskId,
      contextId: invocation.contextId,
      stepId: invocation.stepId,
    };
  }
  return undefined;
};

/**
 * Adapts the shared agent runner to the a2a protocol. Model/tool resolution,
 * loop execution, persistence, interruption, and cancellation remain owned by
 * the same runner used by workflow agent nodes and direct SDK calls.
 */
export class AgentTaskExecutor implements AgentExecutor {
  private readonly contextHistoryStore: ContextHistoryStore;
  private readonly canceledTaskIds = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly agent: AgentDefinition,
    private readonly run: (input: AgentLoopInput, options: RunAgentOptions) => Promise<AgentRunResult>,
    contextHistoryStore: ContextHistoryStore,
    private readonly additionalTools?: (context: AgentToolContext) => AgentToolSet,
  ) {
    this.contextHistoryStore = contextHistoryStore;
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    let complete = false;

    // a2a's `AgentExecutor` is a Promise/callback interface — `onEvent` and the
    // tool-facing `emit` must publish synchronously — so this method is the
    // runtime boundary for a turn. The event builders are effectful only
    // because they read the `Clock` and `Random`, so discharging one is a
    // synchronous evaluation rather than a nested runtime.
    const build = <A>(event: Effect.Effect<A>): A => Effect.runSync(event);
    const publish = (event: Effect.Effect<AgentExecutionEvent>): void => eventBus.publish(build(event));

    logExecutor('execute:start', {
      agentName: this.agent.name,
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
      hasExistingTask: Boolean(requestContext.task),
      userMessageId: requestContext.userMessage.messageId,
    });

    try {
      if (!requestContext.task) {
        logExecutor('emit:submitted', { taskId: requestContext.taskId, contextId: requestContext.contextId });
        publish(submittedTaskEvent(requestContext));
      }

      logExecutor('emit:working', { taskId: requestContext.taskId, contextId: requestContext.contextId });
      publish(workingStatusEvent(requestContext));

      const userText = textFromMessage(requestContext.userMessage);
      const explicitResponse = dataResponseFromMessage(requestContext.userMessage);
      const isResume = explicitResponse !== undefined || requestContext.task?.status.state === 'input-required';
      addToContextHistory(this.contextHistoryStore, requestContext.contextId, requestContext.userMessage);

      let responseStarted = false;
      const publishDataMessage = (data: JsonSerializableObject): void => {
        const message = build(agentDataMessage(requestContext, data));
        logExecutor('emit:data-message', {
          taskId: requestContext.taskId,
          contextId: requestContext.contextId,
          messageId: message.messageId,
          type: data.type,
        });
        publish(messageStatusEvent(requestContext, message));
        addToContextHistory(this.contextHistoryStore, requestContext.contextId, message);
      };

      logExecutor('stream:start', {
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        threadId: `agent:${this.agent.id}:context:${requestContext.contextId}`,
      });

      const workflow = workflowInvocation(requestContext);
      const integrations = integrationOverridesOf(requestContext);
      const toolContext: AgentToolContext = {
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        userMessageId: requestContext.userMessage.messageId,
        emit: publishDataMessage,
        workflow,
        integrations,
      };

      const abortController = new AbortController();
      this.controllers.set(requestContext.taskId, abortController);

      const checkCanceled = (): boolean => {
        if (this.canceledTaskIds.has(requestContext.taskId)) {
          this.canceledTaskIds.delete(requestContext.taskId);
          abortController.abort();
          logExecutor('emit:canceled', { taskId: requestContext.taskId, contextId: requestContext.contextId });
          publish(canceledStatusEvent(requestContext.taskId, requestContext.contextId));
          complete = true;
          return true;
        }
        return complete;
      };

      const onEvent = (event: AgentLoopEvent): void => {
        if (checkCanceled()) return;

        switch (event.type) {
          case 'text-delta': {
            if (this.agent.outputSchema) return;
            logExecutor('emit:artifact-delta', {
              taskId: requestContext.taskId,
              contextId: requestContext.contextId,
              length: event.text.length,
              append: responseStarted,
            });
            eventBus.publish(responseArtifactEvent(requestContext, this.agent.name, event.text, responseStarted));
            responseStarted = true;
            return;
          }
          case 'reasoning':
            publishDataMessage({ type: 'reasoning', text: event.text });
            return;
          case 'tool-call':
            publishDataMessage({
              type: 'tool-call',
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              input: event.input,
            });
            return;
          case 'tool-result':
            publishDataMessage({
              type: 'tool-result',
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              output: event.output,
            });
            return;
          case 'tool-error':
            publishDataMessage({
              type: 'tool-error',
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              error: event.error,
            });
            return;
          case 'finish':
            publishDataMessage({ type: 'finish', finishReason: event.finishReason, usage: event.usage });
            return;
          case 'model-call':
            // Per-call accounting is for in-process consumers such as evals; the chat has no use for it.
            return;
        }
      };

      const result = await this.run(
        isResume
          ? { resume: explicitResponse ?? responseFromText(userText) }
          : { parts: agentInputParts(requestContext.userMessage) },
        {
          taskId: requestContext.taskId,
          contextId: requestContext.contextId,
          userMessageId: requestContext.userMessage.messageId,
          origin: { surface: 'a2a' },
          persist: false,
          signal: abortController.signal,
          onEvent,
          emit: publishDataMessage,
          workflow,
          integrations,
          tools: this.additionalTools?.(toolContext),
        },
      );

      if (complete) return;

      if (result.status === 'input-required') {
        const message = build(agentDataMessage(requestContext, result.inputRequired ?? {}));
        publish(inputRequiredStatusEvent(requestContext, message));
        addToContextHistory(this.contextHistoryStore, requestContext.contextId, message);
        complete = true;
        return;
      }

      if (result.status === 'canceled' || this.canceledTaskIds.has(requestContext.taskId)) {
        this.canceledTaskIds.delete(requestContext.taskId);
        logExecutor('emit:canceled', { taskId: requestContext.taskId, contextId: requestContext.contextId });
        publish(canceledStatusEvent(requestContext.taskId, requestContext.contextId));
        complete = true;
        return;
      }

      if (result.status === 'failed') {
        const failure = result.record.status.message?.parts
          .flatMap((part) => (part.kind === 'text' ? [part.text] : []))
          .join('');
        publish(failedStatusEvent(requestContext, `Agent execution error: ${failure || 'Unknown error'}`));
        complete = true;
        return;
      }

      if (result.structured !== undefined) {
        const data = result.structured;
        logExecutor('emit:completed', {
          taskId: requestContext.taskId,
          contextId: requestContext.contextId,
          structured: true,
        });
        eventBus.publish(responseDataArtifactEvent(requestContext, this.agent.name, data));
        const completedEvent = build(completedDataStatusEvent(requestContext, data));
        eventBus.publish(completedEvent);
        if (completedEvent.status.message) {
          addToContextHistory(this.contextHistoryStore, requestContext.contextId, completedEvent.status.message);
        }
        complete = true;
        return;
      }

      logExecutor('emit:completed', {
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        finalTextLength: result.text.length,
      });
      const completedEvent = build(completedStatusEvent(requestContext, result.text));
      eventBus.publish(completedEvent);

      if (completedEvent.status.message) {
        addToContextHistory(this.contextHistoryStore, requestContext.contextId, completedEvent.status.message);
      }

      complete = true;
    } catch (error) {
      logExecutor('execute:error', {
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        error: errorMessage(error),
      });
      publish(failedStatusEvent(requestContext, `Agent execution error: ${errorMessage(error)}`));
      complete = true;
    } finally {
      this.controllers.delete(requestContext.taskId);
      if (complete) {
        logExecutor('eventBus:finished', { taskId: requestContext.taskId, contextId: requestContext.contextId });
        eventBus.finished();
      } else {
        logExecutor('eventBus:not-finished', { taskId: requestContext.taskId, contextId: requestContext.contextId });
      }
    }
  }

  async cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    this.controllers.get(taskId)?.abort();
    logExecutor('cancel:requested', { taskId });
    return Effect.runPromise(
      Effect.sync(() => {
        this.canceledTaskIds.add(taskId);
      }).pipe(
        Effect.tap(() => Effect.annotateCurrentSpan({ 'a2a.task.id': taskId, 'agent.id': this.agent.id })),
        Effect.withSpan('agentdock.a2a.executor.cancel_task'),
      ),
    );
  }
}
