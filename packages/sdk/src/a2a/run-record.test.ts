import type { Task } from '@a2a-js/sdk';
import { describe, expect, it } from '@effect/vitest';
import type { AgentRunRecord } from '../schemas/agent-runs';
import type { JsonObject } from '../schemas/json';
import { agentRunRecordToTask, taskToAgentRunRecord, workflowOriginFromTask } from './run-record';

/** `taskToAgentRunRecord` re-stamps createdAt/updatedAt from the caller's clock. */
const NOW = '2026-07-03T00:00:00.000Z';

const baseRecord = (overrides: Partial<AgentRunRecord> = {}): AgentRunRecord => ({
  id: 'task-1',
  contextId: 'context-1',
  agentId: 'agent-1',
  status: { state: 'completed', timestamp: '2026-07-03T00:00:00.000Z' },
  history: [
    {
      role: 'user',
      messageId: 'msg-1',
      parts: [{ kind: 'text', text: 'hello' }],
    },
    {
      role: 'agent',
      messageId: 'msg-2',
      parts: [
        { kind: 'text', text: 'hi there' },
        { kind: 'data', data: { type: 'tool-call', toolName: 'search', toolCallId: 'call-1', input: { q: 'x' } } },
      ],
      metadata: { source: 'loop' },
    },
  ],
  artifacts: [{ artifactId: 'artifact-1', name: 'response', parts: [{ kind: 'text', text: 'hi there' }] }],
  origin: { surface: 'a2a' },
  createdAt: '2026-07-03T00:00:00.000Z',
  updatedAt: '2026-07-03T00:00:01.000Z',
  ...overrides,
});

describe('agentRunRecordToTask / taskToAgentRunRecord', () => {
  it('round-trips a record through the a2a Task shape', () => {
    const record = baseRecord();
    const task = agentRunRecordToTask(record);

    expect(task.kind).toBe('task');
    expect(task.id).toBe(record.id);
    expect(task.contextId).toBe(record.contextId);
    expect(task.status.state).toBe('completed');
    expect(task.history?.[0]?.parts).toEqual([{ kind: 'text', text: 'hello' }]);
    expect(task.history?.[1]?.metadata).toEqual({ source: 'loop' });
    expect(task.artifacts?.[0]?.artifactId).toBe('artifact-1');

    const roundTripped = taskToAgentRunRecord(task, { agentId: record.agentId, origin: record.origin, now: NOW });
    // `taskToAgentRunRecord` re-stamps createdAt/updatedAt (it doesn't know the
    // original record's timestamps — the `TaskStore` adapter preserves
    // `createdAt` itself by reading the existing record first), so compare
    // everything else.
    expect(roundTripped.id).toBe(record.id);
    expect(roundTripped.contextId).toBe(record.contextId);
    expect(roundTripped.agentId).toBe(record.agentId);
    expect(roundTripped.status.state).toBe(record.status.state);
    expect(roundTripped.history).toEqual(record.history);
    expect(roundTripped.artifacts).toEqual(record.artifacts);
    expect(roundTripped.origin).toEqual(record.origin);
  });

  it('carries the status message and file parts through the round trip', () => {
    const record = baseRecord({
      status: {
        state: 'input-required',
        timestamp: '2026-07-03T00:00:02.000Z',
        message: {
          role: 'agent',
          messageId: 'msg-3',
          parts: [
            { kind: 'file', file: { name: 'report.pdf', mimeType: 'application/pdf', bytes: 'AAAA' } },
            { kind: 'file', file: { name: 'source.txt', uri: 'file:///tmp/source.txt' } },
          ],
        },
      },
    });
    const task = agentRunRecordToTask(record);
    expect(task.status.message?.parts).toEqual(record.status.message?.parts);

    const roundTripped = taskToAgentRunRecord(task, { agentId: record.agentId, origin: record.origin, now: NOW });
    expect(roundTripped.status.message).toEqual(record.status.message);
    expect(roundTripped.status.state).toBe('input-required');
  });
});

describe('workflowOriginFromTask', () => {
  const taskWithInvocationPart = (data: JsonObject, messageId: string): Task => ({
    kind: 'task',
    id: 'task-2',
    contextId: 'context-2',
    status: { state: 'submitted', timestamp: '2026-07-03T00:00:00.000Z' },
    history: [
      {
        kind: 'message',
        role: 'user',
        messageId,
        taskId: 'task-2',
        contextId: 'context-2',
        parts: [
          { kind: 'text', text: 'do the thing' },
          { kind: 'data', data },
        ],
      },
    ],
  });

  it('extracts workflow origin (with attempt) from a workflow-agent-invocation data part', () => {
    const task = taskWithInvocationPart(
      { type: 'workflow-agent-invocation', workflowId: 'wf-1', runId: 'wfr-1', stepId: 'node-1' },
      'task-2:node-1:3',
    );
    expect(workflowOriginFromTask(task)).toEqual({
      surface: 'workflow',
      workflowId: 'wf-1',
      workflowRunId: 'wfr-1',
      stepId: 'node-1',
      attempt: 3,
    });
  });

  it('defaults attempt to 1 when the message id has no trailing attempt number', () => {
    const task = taskWithInvocationPart(
      { type: 'workflow-agent-invocation', workflowId: 'wf-1', runId: 'wfr-1', stepId: 'node-1' },
      'some-message-id',
    );
    const origin = workflowOriginFromTask(task);
    expect(origin?.surface === 'workflow' && origin.attempt).toBe(1);
  });

  it('returns undefined for a task with no workflow-agent-invocation data part', () => {
    const task = taskWithInvocationPart({ type: 'something-else' }, 'task-2:node-1:1');
    expect(workflowOriginFromTask(task)).toBeUndefined();
  });

  it('returns undefined when there is no history at all', () => {
    const task: Task = {
      kind: 'task',
      id: 'task-3',
      contextId: 'context-3',
      status: { state: 'submitted', timestamp: '2026-07-03T00:00:00.000Z' },
    };
    expect(workflowOriginFromTask(task)).toBeUndefined();
  });
});
