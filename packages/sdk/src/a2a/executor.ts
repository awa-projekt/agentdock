import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { openai } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { stepCountIs, streamText } from 'ai';
import { Effect } from 'effect';
import {
  addToContextHistory,
  buildGenerationMessages,
  type ContextHistoryStore,
} from './history';
import {
  makeAgentDataMessage,
  makeCanceledStatusEvent,
  makeCompletedStatusEvent,
  makeFailedStatusEvent,
  makeMessageStatusEvent,
  makeResponseArtifactEvent,
  makeSubmittedTaskEvent,
  makeWorkingStatusEvent,
} from './events';
import { createDefaultTools } from '../tools';
import type { ToolSet } from 'ai';

const safeJsonValue = (value: unknown): unknown => {
  if (value === undefined) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const resolveModel = (model: string): LanguageModel => {
  const separatorIndex = model.indexOf(':');
  if (separatorIndex === -1) {
    throw new Error(`Invalid model '${model}'. Expected provider:model.`);
  }

  const provider = model.slice(0, separatorIndex).trim();
  const providerModel = model.slice(separatorIndex + 1).trim();

  if (provider.length === 0 || providerModel.length === 0) {
    throw new Error(`Invalid model '${model}'. Expected provider:model.`);
  }

  switch (provider) {
    case 'openai':
      return openai(providerModel);
    default:
      throw new Error(`Model provider '${provider}' is not implemented.`);
  }
};

const logExecutor = (message: string, data: Record<string, unknown> = {}): void => {
  Effect.runSync(Effect.logInfo(`[a2a-executor] ${message}`).pipe(Effect.annotateLogs(data)));
};

const sourceData = (source: {
  readonly sourceType: string;
  readonly title?: string;
  readonly url?: string;
  readonly mediaType?: string;
  readonly filename?: string;
}): Record<string, unknown> => ({
  type: 'source',
  sourceType: source.sourceType,
  title: source.title,
  url: source.url,
  mediaType: source.mediaType,
  filename: source.filename,
});

export class AgentTaskExecutor implements AgentExecutor {
  private readonly contextHistoryStore: ContextHistoryStore;
  private readonly canceledTaskIds = new Set<string>();

  constructor(
    private readonly agentId: string,
    private readonly agentName: string,
    private readonly instructions: string,
    private readonly model: string,
    private readonly createExtraTools: (agentId: string) => Promise<ToolSet>,
    contextHistoryStore: ContextHistoryStore,
  ) {
    this.contextHistoryStore = contextHistoryStore;
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    let complete = false;

    logExecutor('execute:start', {
      agentName: this.agentName,
      model: this.model,
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
      hasExistingTask: Boolean(requestContext.task),
      userMessageId: requestContext.userMessage.messageId,
    });

    try {
      if (!requestContext.task) {
        logExecutor('emit:submitted', { taskId: requestContext.taskId, contextId: requestContext.contextId });
        eventBus.publish(makeSubmittedTaskEvent(requestContext));
      }

      logExecutor('emit:working', { taskId: requestContext.taskId, contextId: requestContext.contextId });
      eventBus.publish(makeWorkingStatusEvent(requestContext));

      const generationMessages = buildGenerationMessages(
        this.contextHistoryStore,
        requestContext.contextId,
        requestContext.task?.history ?? [],
        requestContext.userMessage,
      );
      addToContextHistory(this.contextHistoryStore, requestContext.contextId, requestContext.userMessage);

      let finalText = '';
      let responseStarted = false;
      const publishDataMessage = (data: Record<string, unknown>): void => {
        const message = makeAgentDataMessage(requestContext, data);
        logExecutor('emit:data-message', {
          taskId: requestContext.taskId,
          contextId: requestContext.contextId,
          messageId: message.messageId,
          type: data.type,
        });
        eventBus.publish(makeMessageStatusEvent(requestContext, message));
        addToContextHistory(this.contextHistoryStore, requestContext.contextId, message);
      };

      logExecutor('stream:start', {
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        messageCount: generationMessages.length,
      });

      const resolvedModel = resolveModel(this.model);
      const extraTools = await this.createExtraTools(this.agentId);

      const { fullStream } = streamText({
        model: resolvedModel,
        system: this.instructions,
        messages: [...generationMessages],
        tools: { ...createDefaultTools(this.agentId), ...extraTools },
        stopWhen: stepCountIs(100),
        experimental_telemetry: {
          isEnabled: true,
          recordInputs: true,
          recordOutputs: true,
          functionId: 'a2a-executor.streamText',
          metadata: {
            agentName: this.agentName,
            model: this.model,
            taskId: requestContext.taskId,
            contextId: requestContext.contextId,
            userMessageId: requestContext.userMessage.messageId,
          },
        },
      });

      for await (const event of fullStream) {
        logExecutor('stream:event', {
          taskId: requestContext.taskId,
          contextId: requestContext.contextId,
          type: event.type,
        });

        if (this.canceledTaskIds.has(requestContext.taskId)) {
          this.canceledTaskIds.delete(requestContext.taskId);
          logExecutor('emit:canceled', { taskId: requestContext.taskId, contextId: requestContext.contextId });
          eventBus.publish(makeCanceledStatusEvent(requestContext.taskId, requestContext.contextId));
          complete = true;
          return;
        }

        switch (event.type) {
          case 'text-delta': {
            if (event.text.length === 0) {
              break;
            }

            finalText += event.text;
            logExecutor('emit:artifact-delta', {
              taskId: requestContext.taskId,
              contextId: requestContext.contextId,
              length: event.text.length,
              append: responseStarted,
            });
            eventBus.publish(
              makeResponseArtifactEvent(requestContext, this.agentName, event.text, responseStarted),
            );
            responseStarted = true;
            break;
          }
          case 'reasoning-delta': {
            if (event.text.length > 0) {
              publishDataMessage({ type: 'reasoning', text: event.text });
            }
            break;
          }
          case 'tool-call': {
            publishDataMessage({
              type: 'tool-call',
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              input: safeJsonValue(event.input),
            });
            break;
          }
          case 'tool-result': {
            publishDataMessage({
              type: 'tool-result',
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              output: safeJsonValue(event.output),
            });
            break;
          }
          case 'tool-error': {
            publishDataMessage({
              type: 'tool-error',
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              error: errorMessage(event.error),
            });
            break;
          }
          case 'source': {
            publishDataMessage(sourceData(event));
            break;
          }
          case 'file': {
            publishDataMessage({
              type: 'file',
              mediaType: event.file.mediaType,
              byteLength: event.file.uint8Array.byteLength,
            });
            break;
          }
          case 'finish-step': {
            publishDataMessage({
              type: 'finish-step',
              finishReason: event.finishReason,
              usage: safeJsonValue(event.usage),
            });
            break;
          }
          case 'finish': {
            if (event.finishReason === 'error') {
              logExecutor('emit:failed', {
                taskId: requestContext.taskId,
                contextId: requestContext.contextId,
                finishReason: event.finishReason,
              });
              eventBus.publish(makeFailedStatusEvent(requestContext, 'Agent execution failed.'));
              complete = true;
              return;
            }

            publishDataMessage({
              type: 'finish',
              finishReason: event.finishReason,
              usage: safeJsonValue(event.totalUsage),
            });
            break;
          }
          case 'error': {
            logExecutor('emit:failed', {
              taskId: requestContext.taskId,
              contextId: requestContext.contextId,
              error: errorMessage(event.error),
            });
            eventBus.publish(makeFailedStatusEvent(requestContext, `Agent execution error: ${errorMessage(event.error)}`));
            complete = true;
            return;
          }
          case 'abort': {
            this.canceledTaskIds.delete(requestContext.taskId);
            logExecutor('emit:canceled', { taskId: requestContext.taskId, contextId: requestContext.contextId });
            eventBus.publish(makeCanceledStatusEvent(requestContext.taskId, requestContext.contextId));
            complete = true;
            return;
          }
          case 'start':
          case 'start-step':
          case 'text-start':
          case 'text-end':
          case 'reasoning-start':
          case 'reasoning-end':
          case 'tool-input-start':
          case 'tool-input-delta':
          case 'tool-input-end':
          case 'tool-output-denied':
          case 'tool-approval-request':
          case 'raw': {
            break;
          }
        }
      }

      if (this.canceledTaskIds.has(requestContext.taskId)) {
        this.canceledTaskIds.delete(requestContext.taskId);
        logExecutor('emit:canceled', { taskId: requestContext.taskId, contextId: requestContext.contextId });
        eventBus.publish(makeCanceledStatusEvent(requestContext.taskId, requestContext.contextId));
        complete = true;
        return;
      }

      logExecutor('emit:completed', {
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        finalTextLength: finalText.length,
      });
      const completedEvent = makeCompletedStatusEvent(requestContext, finalText);
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
      eventBus.publish(makeFailedStatusEvent(requestContext, `Agent execution error: ${errorMessage(error)}`));
      complete = true;
    } finally {
      if (complete) {
        logExecutor('eventBus:finished', { taskId: requestContext.taskId, contextId: requestContext.contextId });
        eventBus.finished();
      } else {
        logExecutor('eventBus:not-finished', { taskId: requestContext.taskId, contextId: requestContext.contextId });
      }
    }
  }

  async cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    logExecutor('cancel:requested', { taskId });
    return Effect.runPromise(
      Effect.sync(() => {
        this.canceledTaskIds.add(taskId);
      }).pipe(
        Effect.tap(() => Effect.annotateCurrentSpan({ 'a2a.task.id': taskId, 'agent.id': this.agentId })),
        Effect.withSpan('agentdock.a2a.executor.cancel_task'),
      ),
    );
  }
}
