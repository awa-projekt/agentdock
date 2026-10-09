import type { FilePart, Message, Part, Task } from '@a2a-js/sdk';
import type {
  AgentRunArtifact,
  AgentRunFileContent,
  AgentRunMessage,
  AgentRunOrigin,
  AgentRunPart,
  AgentRunRecord,
} from '../schemas/agent-runs';
import { coerceJson, isJsonObject, type Json, type JsonObject, jsonString } from '../schemas/json';

/**
 * Boundary transforms between the SDK's protocol-independent `AgentRunRecord`
 * and the a2a `Task` shape. The a2a `TaskStore` is an adapter over
 * `AgentRunStore` built from these (Phase C); a2a `Part`/`Message` shapes are
 * near-identical to `AgentRunPart`/`AgentRunMessage` by construction.
 */

const toAgentRunFileContent = (file: FilePart['file']): AgentRunFileContent =>
  'bytes' in file
    ? { bytes: file.bytes, name: file.name, mimeType: file.mimeType }
    : { uri: file.uri, name: file.name, mimeType: file.mimeType };

const toA2aFileContent = (file: AgentRunFileContent): FilePart['file'] => {
  const content: FilePart['file'] = 'bytes' in file ? { bytes: file.bytes } : { uri: file.uri };
  if (file.name !== undefined) content.name = file.name;
  if (file.mimeType !== undefined) content.mimeType = file.mimeType;
  return content;
};

export const toAgentRunPart = (part: Part): AgentRunPart => {
  switch (part.kind) {
    case 'text':
      return { kind: 'text', text: part.text };
    case 'data':
      return { kind: 'data', data: toJsonObject(coerceJson(part.data)) };
    case 'file':
      return { kind: 'file', file: toAgentRunFileContent(part.file) };
  }
};

export const toA2aPart = (part: AgentRunPart): Part => {
  switch (part.kind) {
    case 'text':
      return { kind: 'text', text: part.text };
    case 'data':
      return { kind: 'data', data: part.data };
    case 'file':
      return { kind: 'file', file: toA2aFileContent(part.file) };
  }
};

const toAgentRunMessage = (message: Message): AgentRunMessage => ({
  role: message.role,
  messageId: message.messageId,
  parts: message.parts.map(toAgentRunPart),
  metadata: message.metadata === undefined ? undefined : toJsonObject(coerceJson(message.metadata)),
});

/** Narrows a coerced JSON value to the object shape message metadata requires. */
const toJsonObject = (value: Json): JsonObject => (isJsonObject(value) ? value : {});

const toA2aMessage = (message: AgentRunMessage, taskId: string, contextId: string): Message => {
  const a2aMessage: Message = {
    kind: 'message',
    role: message.role,
    messageId: message.messageId,
    taskId,
    contextId,
    parts: message.parts.map(toA2aPart),
  };
  if (message.metadata !== undefined) a2aMessage.metadata = message.metadata;
  return a2aMessage;
};

const toAgentRunArtifact = (artifact: NonNullable<Task['artifacts']>[number]): AgentRunArtifact => ({
  artifactId: artifact.artifactId,
  name: artifact.name,
  parts: artifact.parts.map(toAgentRunPart),
});

const toA2aArtifact = (artifact: AgentRunArtifact): NonNullable<Task['artifacts']>[number] => {
  const a2aArtifact: NonNullable<Task['artifacts']>[number] = {
    artifactId: artifact.artifactId,
    parts: artifact.parts.map(toA2aPart),
  };
  if (artifact.name !== undefined) a2aArtifact.name = artifact.name;
  return a2aArtifact;
};

export const agentRunRecordToTask = (record: AgentRunRecord): Task => {
  const status: Task['status'] = { state: record.status.state, timestamp: record.status.timestamp };
  if (record.status.message !== undefined) {
    status.message = toA2aMessage(record.status.message, record.id, record.contextId);
  }
  const task: Task = {
    kind: 'task',
    id: record.id,
    contextId: record.contextId,
    status,
    history: record.history.map((message) => toA2aMessage(message, record.id, record.contextId)),
    artifacts: record.artifacts.map(toA2aArtifact),
  };
  if (record.metadata !== undefined) task.metadata = record.metadata;
  return task;
};

/**
 * Detects the `workflow-agent-invocation` data part a workflow node's
 * external-binding a2a client attaches to the initiating message (see
 * `workflows/nodes/agent.ts` `withWorkflowInvocationPart`) and, from it, the
 * `AgentRunOrigin` the record for that call should carry — so an externally
 * a2a-hosted agent's runs stay linked back to the workflow run that invoked
 * them, the same way an internally-bound agent's runs already are via
 * `runAgent`'s `origin` option. The attempt number rides along in the
 * message id (`${taskId}:${stepId}:${attempt}`, see `createMessageSendParams`
 * call sites), since the data part itself predates this scheme and doesn't
 * carry it.
 */
export const workflowOriginFromTask = (task: Task): AgentRunOrigin | undefined => {
  for (const message of task.history ?? []) {
    for (const part of message.parts) {
      if (part.kind !== 'data') continue;
      const data = coerceJson(part.data);
      if (!isJsonObject(data) || data.type !== 'workflow-agent-invocation') continue;
      const workflowId = jsonString(data, 'workflowId');
      const workflowRunId = jsonString(data, 'runId');
      const stepId = jsonString(data, 'stepId');
      if (!workflowId || !workflowRunId || !stepId) continue;
      const attemptMatch = /:(\d+)$/.exec(message.messageId);
      const attempt = attemptMatch?.[1] ? Number(attemptMatch[1]) : 1;
      return { surface: 'workflow', workflowId, workflowRunId, stepId, attempt };
    }
  }
  return undefined;
};

/**
 * `now` is supplied by the caller rather than read here: this is a pure mapper,
 * and its callers are already inside an Effect with the `Clock` available.
 */
export const taskToAgentRunRecord = (
  task: Task,
  options: { readonly agentId: string; readonly origin: AgentRunOrigin; readonly now: string },
): AgentRunRecord => {
  const now = options.now;
  return {
    id: task.id,
    contextId: task.contextId,
    agentId: options.agentId,
    status: {
      // SAFETY: a2a's TaskState has two members ('auth-required', 'unknown')
      // outside AgentRunStatusState; tasks reaching this mapper come from this
      // SDK's own executors, which only ever publish the shared states.
      state: task.status.state as AgentRunRecord['status']['state'],
      timestamp: task.status.timestamp ?? now,
      message: task.status.message === undefined ? undefined : toAgentRunMessage(task.status.message),
    },
    history: (task.history ?? []).map(toAgentRunMessage),
    artifacts: (task.artifacts ?? []).map(toAgentRunArtifact),
    origin: options.origin,
    metadata: task.metadata === undefined ? undefined : toJsonObject(coerceJson(task.metadata)),
    createdAt: now,
    updatedAt: now,
  };
};
