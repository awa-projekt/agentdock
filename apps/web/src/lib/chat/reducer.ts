import type { Part, Task, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { coerceJson, isJsonString, jsonString } from 'agentdock-sdk/schemas';
import { appendTimelineData, dataFromMessage, inputRequiredItem, type StreamEvent, textFromParts } from './events';
import { type AssistantMessage, type ChatSession, isErrorState, isTerminalState } from './model';

export type TurnUpdate = {
  readonly message: AssistantMessage;
  /** The task id the stream attached this turn to, once known. */
  readonly taskId: string | undefined;
  /** True once the turn cannot receive further events. */
  readonly done: boolean;
};

const withState = (message: AssistantMessage, state: string, at: number): AssistantMessage => {
  const terminal = isTerminalState(state);
  return {
    ...message,
    state,
    working: !terminal && state !== 'input-required',
    finishedAt: terminal ? (message.finishedAt ?? at) : message.finishedAt,
  };
};

const applyTask = (message: AssistantMessage, task: Task, at: number): TurnUpdate => {
  const next = withState({ ...message, taskId: task.id }, task.status.state, at);
  const text = textFromParts(task.status.message?.parts);
  const done = isTerminalState(task.status.state);
  return {
    message: done && text.length > 0 ? { ...next, text } : next,
    taskId: task.id,
    done,
  };
};

const applyStatusUpdate = (
  message: AssistantMessage,
  event: TaskStatusUpdateEvent,
  at: number,
  eventId: string,
): TurnUpdate => {
  const state = event.status.state;
  const data = dataFromMessage(event.status.message);
  const text = textFromParts(event.status.message?.parts);
  let next = withState({ ...message, taskId: event.taskId }, state, at);

  if (state === 'input-required' && data) {
    next = { ...next, timeline: [...next.timeline, inputRequiredItem({ data, at, id: eventId })] };
  } else if (data) {
    // Text streamed before a tool call is an intermediate note, not the answer: move it into the trail.
    const interim =
      jsonString(data, 'type') === 'tool-call' && next.text.trim().length > 0
        ? [...next.timeline, { kind: 'text' as const, id: `${eventId}:text`, at, text: next.text }]
        : next.timeline;
    next = {
      ...next,
      text: interim === next.timeline ? next.text : '',
      timeline: appendTimelineData(interim, { data, at, id: eventId }),
    };
  }

  if (isTerminalState(state)) {
    if (isErrorState(state)) {
      const error = text.length > 0 ? text : `Agent run ${state}`;
      next = { ...next, error };
    } else if (text.length > 0) {
      // The completed status carries the agent's final answer; it supersedes streamed deltas.
      next = { ...next, text };
    }
  }

  return { message: next, taskId: event.taskId, done: isTerminalState(state) };
};

const stringifyStructured = (parts: ReadonlyArray<Part>): string =>
  parts
    .flatMap((part) => {
      if (part.kind !== 'data') return [];
      const data = coerceJson(part.data);
      return [isJsonString(data) ? data : JSON.stringify(data, null, 2)];
    })
    .join('\n');

/**
 * Fold one A2A stream event into an in-flight assistant turn. Pure so the
 * streaming path is unit-testable without a client or React.
 */
export const applyStreamEvent = (
  message: AssistantMessage,
  event: StreamEvent,
  at: number,
  eventId: string,
): TurnUpdate => {
  switch (event.kind) {
    case 'task':
      return applyTask(message, event, at);
    case 'status-update':
      return applyStatusUpdate(message, event, at, eventId);
    case 'artifact-update': {
      const chunk = textFromParts(event.artifact.parts);
      if (chunk.length > 0) {
        const text = event.append === false ? chunk : `${message.text}${chunk}`;
        return { message: { ...message, text, taskId: event.taskId }, taskId: event.taskId, done: false };
      }
      const structured = stringifyStructured(event.artifact.parts);
      if (structured.length > 0) {
        return {
          message: { ...message, text: `\`\`\`json\n${structured}\n\`\`\``, taskId: event.taskId },
          taskId: event.taskId,
          done: false,
        };
      }
      return { message, taskId: event.taskId, done: false };
    }
    case 'message': {
      // A direct reply without a task: the whole answer arrives at once.
      const text = textFromParts(event.parts);
      return {
        message: {
          ...message,
          text: text.length > 0 ? text : message.text,
          state: 'completed',
          working: false,
          finishedAt: at,
        },
        taskId: message.taskId,
        done: true,
      };
    }
  }
};

/** Mark a turn as interrupted locally (stream aborted or failed before a terminal state). */
export const finishTurn = (message: AssistantMessage, state: string, error: string | undefined, at: number) => ({
  ...withState(message, state, at),
  error: error ?? message.error,
  finishedAt: at,
});

export const replaceAssistantMessage = (session: ChatSession, message: AssistantMessage): ChatSession => ({
  ...session,
  messages: session.messages.map((existing) => (existing.id === message.id ? message : existing)),
});
