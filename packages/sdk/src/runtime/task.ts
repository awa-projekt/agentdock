import type { Task } from '@a2a-js/sdk';
import type { AgentExecutionEvent } from '@a2a-js/sdk/server';
import type { GraphExecution } from './types';

export const applyGraphEvent = (execution: GraphExecution, event: AgentExecutionEvent): Task => {
  const task: Task = execution.task ?? {
    kind: 'task',
    id: execution.id,
    contextId: execution.contextId,
    status: { state: 'submitted' },
    history: [execution.message],
    artifacts: [],
  };
  if (event.kind === 'task') return { ...task, ...event, history: event.history ?? task.history ?? [] };
  if (event.kind === 'artifact-update') {
    const prior = task.artifacts?.find((artifact) => artifact.artifactId === event.artifact.artifactId);
    const artifact =
      event.append && prior ? { ...prior, parts: [...prior.parts, ...event.artifact.parts] } : event.artifact;
    return {
      ...task,
      artifacts: [...(task.artifacts ?? []).filter((item) => item.artifactId !== artifact.artifactId), artifact],
    };
  }
  const message = event.kind === 'message' ? event : event.status.message;
  const history = message
    ? [...(task.history ?? []).filter((item) => item.messageId !== message.messageId), message]
    : task.history;
  const next: Task = event.kind === 'status-update' ? { ...task, status: event.status } : { ...task };
  if (history) next.history = [...history];
  return next;
};
