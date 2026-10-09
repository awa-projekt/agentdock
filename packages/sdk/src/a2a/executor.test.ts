import type { AgentExecutionEvent } from '@a2a-js/sdk/server';
import { DefaultExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import * as DateTime from 'effect/DateTime';
import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from '../agents/definition';
import type { AgentLoopInput } from '../agents/loop';
import type { AgentRunResult, RunAgentOptions } from '../agents/run';
import {
  INTEGRATION_OVERRIDES_METADATA_KEY,
  WorkflowId,
  WorkflowRunId,
  workflowA2AAgentInvocationEnvelope,
} from '../schemas';
import { AgentTaskExecutor } from './executor';

/** Collects everything the executor publishes, using the real a2a event bus. */
const recordingEventBus = () => {
  const events: Array<AgentExecutionEvent> = [];
  const bus = new DefaultExecutionEventBus();
  let finished = false;
  bus.on('event', (event) => {
    events.push(event);
  });
  bus.on('finished', () => {
    finished = true;
  });
  return { bus, events, isFinished: () => finished };
};

const agent: AgentDefinition = {
  id: 'writer',
  name: 'Writer',
  instructions: 'Write clearly.',
  model: 'test:model',
};

const requestContext = new RequestContext(
  { kind: 'message', messageId: 'message-1', role: 'user', parts: [{ kind: 'text', text: 'Draft this.' }] },
  'task-1',
  'context-1',
);

const timestamp = DateTime.formatIso(DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'));

const completedResult = (): AgentRunResult => {
  return {
    taskId: 'task-1',
    contextId: 'context-1',
    status: 'completed',
    text: 'Final draft',
    record: {
      id: 'task-1',
      contextId: 'context-1',
      agentId: agent.id,
      status: { state: 'completed', timestamp },
      history: [],
      artifacts: [],
      origin: { surface: 'a2a' },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
};

describe('AgentTaskExecutor', () => {
  it('adapts A2A requests to the shared agent runner', async () => {
    const { bus: eventBus, events, isFinished } = recordingEventBus();
    let receivedInput: AgentLoopInput | undefined;
    let receivedOptions: RunAgentOptions | undefined;
    let resolvedAdditionalTools = false;

    const executor = new AgentTaskExecutor(
      agent,
      async (input, options) => {
        receivedInput = input;
        receivedOptions = options;
        options.onEvent?.({ type: 'text-delta', text: 'Final draft' });
        return completedResult();
      },
      new Map(),
      () => {
        resolvedAdditionalTools = true;
        return [];
      },
    );
    await executor.execute(requestContext, eventBus);

    expect(receivedInput).toEqual({ parts: [{ kind: 'text', text: 'Draft this.' }] });
    expect(receivedOptions?.integrations).toBeUndefined();
    expect(receivedOptions?.taskId).toBe('task-1');
    expect(receivedOptions?.contextId).toBe('context-1');
    expect(receivedOptions?.origin).toEqual({ surface: 'a2a' });
    expect(receivedOptions?.persist).toBe(false);
    expect(resolvedAdditionalTools).toBe(true);
    expect(receivedOptions?.tools).toEqual([]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'task' }),
        expect.objectContaining({ kind: 'artifact-update' }),
        expect.objectContaining({ kind: 'status-update', final: true }),
      ]),
    );
    expect(isFinished()).toBe(true);
  });

  it('hands the agent files and data, but not the parts that steer the run', async () => {
    let receivedInput: AgentLoopInput | undefined;
    const executor = new AgentTaskExecutor(
      agent,
      async (input) => {
        receivedInput = input;
        return completedResult();
      },
      new Map(),
    );
    const invocation = workflowA2AAgentInvocationEnvelope({
      workflowId: WorkflowId.make('workflow-1'),
      runId: WorkflowRunId.make('run-1'),
      taskId: 'workflow-task',
      contextId: 'workflow-context',
      stepId: 'draft',
    });
    const context = new RequestContext(
      {
        kind: 'message',
        messageId: 'message-1',
        role: 'user',
        parts: [
          { kind: 'text', text: 'Describe the photo.' },
          { kind: 'file', file: { bytes: 'iVBORw0KGgo=', mimeType: 'image/png', name: 'photo.png' } },
          { kind: 'data', data: { product: '42' } },
          { kind: 'data', data: { ...invocation } },
        ],
      },
      'task-1',
      'context-1',
    );

    await executor.execute(context, recordingEventBus().bus);

    expect(receivedInput).toEqual({
      parts: [
        { kind: 'text', text: 'Describe the photo.' },
        { kind: 'file', file: { bytes: 'iVBORw0KGgo=', mimeType: 'image/png', name: 'photo.png' } },
        { kind: 'data', data: { product: '42' } },
      ],
    });
  });

  it('runs with the integration overrides of the message that started the task', async () => {
    let receivedOptions: RunAgentOptions | undefined;
    const executor = new AgentTaskExecutor(
      agent,
      async (_input, options) => {
        receivedOptions = options;
        return completedResult();
      },
      new Map(),
    );
    const first = {
      kind: 'message' as const,
      messageId: 'message-1',
      role: 'user' as const,
      parts: [{ kind: 'text' as const, text: 'Research product 42.' }],
      metadata: { [INTEGRATION_OVERRIDES_METADATA_KEY]: { catalog: { endpoint: 'http://127.0.0.1:41001/mcp' } } },
    };
    const later = new RequestContext(
      {
        ...first,
        messageId: 'message-2',
        parts: [{ kind: 'text', text: 'Go on.' }],
        metadata: { [INTEGRATION_OVERRIDES_METADATA_KEY]: { catalog: { endpoint: 'http://elsewhere.test/mcp' } } },
      },
      'task-1',
      'context-1',
      { kind: 'task', id: 'task-1', contextId: 'context-1', status: { state: 'working' }, history: [first] },
    );

    await executor.execute(later, recordingEventBus().bus);

    expect(receivedOptions?.integrations).toEqual({ catalog: { endpoint: 'http://127.0.0.1:41001/mcp' } });
  });

  it('resumes the same waiting task from a text response', async () => {
    const history = new Map([
      [
        'context-1',
        [
          {
            kind: 'message' as const,
            messageId: 'request-1',
            role: 'agent' as const,
            parts: [{ kind: 'data' as const, data: { type: 'mcp-elicitation', message: 'Approve?' } }],
          },
        ],
      ],
    ]);
    let receivedInput: AgentLoopInput | undefined;
    const executor = new AgentTaskExecutor(
      agent,
      async (input) => {
        receivedInput = input;
        return completedResult();
      },
      history,
    );
    const { bus: eventBus } = recordingEventBus();
    const approvalContext = new RequestContext(
      {
        ...requestContext.userMessage,
        messageId: 'message-2',
        parts: [{ kind: 'text', text: '{"action":"accept","content":{"name":"Ada"}}' }],
      },
      'task-1',
      'context-1',
      { kind: 'task', id: 'task-1', contextId: 'context-1', status: { state: 'input-required' } },
    );

    await executor.execute(approvalContext, eventBus);

    expect(receivedInput).toEqual({ resume: { action: 'accept', content: { name: 'Ada' } } });
  });
});
