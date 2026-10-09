import type { Message, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { RequestContext } from '@a2a-js/sdk/server';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import { randomUUIDv4 } from '../random';
import type { JsonSerializableObject } from '../schemas/json';

/**
 * Event timestamps come from the Effect `Clock` and message ids from the Effect
 * `Random`, so a test driving these builders under `TestClock` or a seeded
 * `Random` sees the values it set rather than ambient ones. That is the only
 * reason the builders are effectful — they are otherwise plain data constructors.
 */
const timestamp: Effect.Effect<string> = Effect.map(DateTime.now, DateTime.formatIso);

const agentMessage = (requestContext: RequestContext, text: string): Effect.Effect<Message> =>
  Effect.map(randomUUIDv4, (messageId) => ({
    kind: 'message',
    role: 'agent',
    messageId,
    taskId: requestContext.taskId,
    contextId: requestContext.contextId,
    parts: [{ kind: 'text', text }],
  }));

export const agentDataMessage = (
  requestContext: RequestContext,
  data: JsonSerializableObject,
): Effect.Effect<Message> =>
  Effect.map(randomUUIDv4, (messageId) => ({
    kind: 'message',
    role: 'agent',
    messageId,
    taskId: requestContext.taskId,
    contextId: requestContext.contextId,
    parts: [{ kind: 'data', data }],
  }));

export const submittedTaskEvent = (requestContext: RequestContext): Effect.Effect<Task> =>
  Effect.map(timestamp, (time) => ({
    kind: 'task',
    id: requestContext.taskId,
    contextId: requestContext.contextId,
    status: { state: 'submitted', timestamp: time },
    history: [requestContext.userMessage],
  }));

export const workingStatusEvent = (requestContext: RequestContext): Effect.Effect<TaskStatusUpdateEvent> =>
  Effect.map(timestamp, (time) => ({
    kind: 'status-update',
    taskId: requestContext.taskId,
    contextId: requestContext.contextId,
    final: false,
    status: { state: 'working', timestamp: time },
  }));

export const responseArtifactEvent = (
  requestContext: RequestContext,
  agentName: string,
  text: string,
  append = true,
  lastChunk = false,
): TaskArtifactUpdateEvent => ({
  kind: 'artifact-update',
  taskId: requestContext.taskId,
  contextId: requestContext.contextId,
  append,
  lastChunk,
  artifact: {
    artifactId: `${requestContext.taskId}-response`,
    name: agentName,
    parts: [{ kind: 'text', text }],
  },
});

export const completedStatusEvent = (
  requestContext: RequestContext,
  text: string,
): Effect.Effect<TaskStatusUpdateEvent> =>
  Effect.gen(function* () {
    const time = yield* timestamp;
    const message = yield* agentMessage(requestContext, text);
    return {
      kind: 'status-update',
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
      final: true,
      status: { state: 'completed', timestamp: time, message },
    };
  });

/**
 * Emits the agent's structured output as a single `data` artifact. Used in
 * place of the streamed text artifact when the agent runs under an output
 * contract, so callers receive the guaranteed JSON shape as a `DataPart`.
 */
export const responseDataArtifactEvent = (
  requestContext: RequestContext,
  agentName: string,
  data: JsonSerializableObject,
): TaskArtifactUpdateEvent => ({
  kind: 'artifact-update',
  taskId: requestContext.taskId,
  contextId: requestContext.contextId,
  append: false,
  lastChunk: true,
  artifact: {
    artifactId: `${requestContext.taskId}-response`,
    name: agentName,
    parts: [{ kind: 'data', data }],
  },
});

export const completedDataStatusEvent = (
  requestContext: RequestContext,
  data: JsonSerializableObject,
): Effect.Effect<TaskStatusUpdateEvent> =>
  Effect.gen(function* () {
    const time = yield* timestamp;
    const message = yield* agentDataMessage(requestContext, data);
    return {
      kind: 'status-update',
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
      final: true,
      status: { state: 'completed', timestamp: time, message },
    };
  });

export const canceledStatusEvent = (taskId: string, contextId: string): Effect.Effect<TaskStatusUpdateEvent> =>
  Effect.map(timestamp, (time) => ({
    kind: 'status-update',
    taskId,
    contextId,
    final: true,
    status: { state: 'canceled', timestamp: time },
  }));

export const rejectedStatusEvent = (
  requestContext: RequestContext,
  text: string,
): Effect.Effect<TaskStatusUpdateEvent> =>
  Effect.gen(function* () {
    const time = yield* timestamp;
    const message = yield* agentMessage(requestContext, text);
    return {
      kind: 'status-update',
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
      final: true,
      status: { state: 'rejected', timestamp: time, message },
    };
  });

export const failedStatusEvent = (requestContext: RequestContext, text: string): Effect.Effect<TaskStatusUpdateEvent> =>
  Effect.gen(function* () {
    const time = yield* timestamp;
    const message = yield* agentMessage(requestContext, text);
    return {
      kind: 'status-update',
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
      final: true,
      status: { state: 'failed', timestamp: time, message },
    };
  });

export const messageStatusEvent = (
  requestContext: RequestContext,
  message: Message,
): Effect.Effect<TaskStatusUpdateEvent> =>
  Effect.map(timestamp, (time) => ({
    kind: 'status-update',
    taskId: requestContext.taskId,
    contextId: requestContext.contextId,
    final: false,
    status: { state: 'working', timestamp: time, message },
  }));

export const inputRequiredStatusEvent = (
  requestContext: RequestContext,
  message: Message,
): Effect.Effect<TaskStatusUpdateEvent> =>
  Effect.map(timestamp, (time) => ({
    kind: 'status-update',
    taskId: requestContext.taskId,
    contextId: requestContext.contextId,
    final: false,
    status: { state: 'input-required', timestamp: time, message },
  }));
