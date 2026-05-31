import {
  type Message,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import { type RequestContext } from '@a2a-js/sdk/server';

const now = (): string => new Date().toISOString();

const agentMessage = (requestContext: RequestContext, text: string): Message => ({
  kind: 'message',
  role: 'agent',
  messageId: crypto.randomUUID(),
  taskId: requestContext.taskId,
  contextId: requestContext.contextId,
  parts: [{ kind: 'text', text }],
});

export const makeAgentDataMessage = (
  requestContext: RequestContext,
  data: Record<string, unknown>,
): Message => ({
  kind: 'message',
  role: 'agent',
  messageId: crypto.randomUUID(),
  taskId: requestContext.taskId,
  contextId: requestContext.contextId,
  parts: [{ kind: 'data', data }],
});

export const makeSubmittedTaskEvent = (requestContext: RequestContext): Task => ({
  kind: 'task',
  id: requestContext.taskId,
  contextId: requestContext.contextId,
  status: {
    state: 'submitted',
    timestamp: now(),
  },
  history: [requestContext.userMessage],
});

export const makeWorkingStatusEvent = (
  requestContext: RequestContext,
): TaskStatusUpdateEvent => ({
  kind: 'status-update',
  taskId: requestContext.taskId,
  contextId: requestContext.contextId,
  final: false,
  status: {
    state: 'working',
    timestamp: now(),
  },
});

export const makeResponseArtifactEvent = (
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

export const makeCompletedStatusEvent = (
  requestContext: RequestContext,
  text: string,
): TaskStatusUpdateEvent => ({
  kind: 'status-update',
  taskId: requestContext.taskId,
  contextId: requestContext.contextId,
  final: true,
  status: {
    state: 'completed',
    timestamp: now(),
    message: agentMessage(requestContext, text),
  },
});

export const makeCanceledStatusEvent = (
  taskId: string,
  contextId: string,
): TaskStatusUpdateEvent => ({
  kind: 'status-update',
  taskId,
  contextId,
  final: true,
  status: {
    state: 'canceled',
    timestamp: now(),
  },
});

export const makeFailedStatusEvent = (
  requestContext: RequestContext,
  text: string,
): TaskStatusUpdateEvent => ({
  kind: 'status-update',
  taskId: requestContext.taskId,
  contextId: requestContext.contextId,
  final: true,
  status: {
    state: 'failed',
    timestamp: now(),
    message: agentMessage(requestContext, text),
  },
});

export const makeMessageStatusEvent = (
  requestContext: RequestContext,
  message: Message,
): TaskStatusUpdateEvent => ({
  kind: 'status-update',
  taskId: requestContext.taskId,
  contextId: requestContext.contextId,
  final: false,
  status: {
    state: 'working',
    timestamp: now(),
    message,
  },
});
