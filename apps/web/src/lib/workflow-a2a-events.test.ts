import type { JsonObject } from 'agentdock-sdk/schemas';
import { WorkflowId, WorkflowRunEventId, WorkflowRunId } from 'agentdock-sdk/schemas';
import { describe, expect, it } from 'vitest';
import { buildStepActivityModel, isStepActivityEvent, type StepActivityEvent } from './workflow-a2a-events';

const progress = (id: string, state: string, data: JsonObject): StepActivityEvent => ({
  id: WorkflowRunEventId.make(id),
  runId: WorkflowRunId.make('wfr_1'),
  workflowId: WorkflowId.make('wf_1'),
  taskId: 'task-1',
  timestamp: '2026-01-01T00:00:00.000Z',
  type: 'step-progress',
  stepId: 'research',
  label: 'research',
  state,
  data,
});

const usage = { input: 120, cacheRead: 0, cacheWrite: 0, output: 30, reasoning: 0, total: 150 };

describe('buildStepActivityModel', () => {
  it('shows what a bound agent did inside its step', () => {
    const events = [
      progress('e1', 'model-call', { agentId: 'researcher', model: 'openai:gpt-6-luna', usage, toolCalls: 2 }),
      progress('e2', 'agent-tool-call', {
        agentId: 'researcher',
        type: 'tool-call',
        toolName: 'search',
        toolCallId: 'c1',
        input: { q: 'refunds' },
      }),
      progress('e3', 'agent-delegation', {
        agentId: 'researcher',
        event: { type: 'send-task-progress', agentName: 'Citations', taskId: 'sub-1', state: 'submitted' },
      }),
      progress('e4', 'agent-delegation', {
        agentId: 'researcher',
        event: {
          type: 'send-task-progress',
          agentName: 'Citations',
          taskId: 'sub-1',
          state: 'working',
          event: { type: 'tool-call', toolName: 'lookup', toolCallId: 'x', input: {} },
        },
      }),
      progress('e5', 'agent-tool-result', {
        agentId: 'researcher',
        type: 'tool-result',
        toolName: 'search',
        toolCallId: 'c1',
        output: ['ref-1'],
      }),
      progress('e6', 'agent-delegation', {
        agentId: 'researcher',
        event: {
          type: 'send-task-progress',
          agentName: 'Citations',
          taskId: 'sub-1',
          state: 'completed',
          text: '2 refs',
        },
      }),
      progress('e7', 'a2a-artifact', { agentId: 'researcher', text: 'Found it.' }),
    ];
    expect(events.every(isStepActivityEvent)).toBe(true);

    const model = buildStepActivityModel(events);

    expect(model.agentId).toBe('researcher');
    expect(model.state).toBeNull();
    expect(model.streamedText).toBe('Found it.');
    expect(model.items.map((item) => item.kind)).toEqual(['model-call', 'tool', 'subagent', 'tool']);
    expect(model.items[0]).toMatchObject({ caller: 'researcher', inputTokens: 120, outputTokens: 30, toolCalls: 2 });
    expect(model.items[2]).toMatchObject({
      id: 'e3',
      agent: 'Citations',
      state: 'completed',
      text: '2 refs',
      toolCalls: 1,
    });
  });

  it('pairs the calls of a bound tool and keeps what a bound model streamed', () => {
    const model = buildStepActivityModel([
      progress('e1', 'tool-call', { tool: 'tools.crm', name: 'lookup', input: { id: 7 } }),
      progress('e2', 'tool-result', { tool: 'tools.crm', name: 'lookup', output: { plan: 'pro' } }),
      progress('e3', 'model-token', { modelName: 'writer', text: 'Hello ' }),
      progress('e4', 'model-token', { modelName: 'writer', text: 'there' }),
      progress('e5', 'model-call', { modelName: 'writer', model: 'openai:gpt-6-luna', usage: null, toolCalls: 0 }),
    ]);

    expect(model.state).toBeNull();
    expect(model.streamedText).toBe('Hello there');
    expect(model.items).toMatchObject([
      { kind: 'tool', detail: { kind: 'tool-call', toolName: 'lookup', toolCallId: 'e1' } },
      { kind: 'tool', detail: { kind: 'tool-result', toolName: 'lookup', toolCallId: 'e1', output: { plan: 'pro' } } },
      { kind: 'model-call', caller: 'writer', inputTokens: undefined, outputTokens: undefined },
    ]);
  });
});
