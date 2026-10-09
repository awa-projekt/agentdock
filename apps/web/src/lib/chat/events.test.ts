import type { JsonObject } from 'agentdock-sdk/schemas';
import { describe, expect, it } from 'vitest';
import {
  activeSubagentChain,
  appendTimelineData,
  countSubagents,
  countTimelineSteps,
  dataFromPersistedEvent,
  describeTimelineItem,
  subagentDepth,
  subagentLabel,
} from './events';
import type { TimelineItem } from './model';

const fold = (...datas: ReadonlyArray<JsonObject>): ReadonlyArray<TimelineItem> =>
  datas.reduce<ReadonlyArray<TimelineItem>>(
    (items, data, index) => appendTimelineData(items, { data, at: index, id: `evt-${index}` }),
    [],
  );

describe('appendTimelineData', () => {
  it('merges consecutive reasoning chunks into one step', () => {
    const items = fold({ type: 'reasoning', text: 'First' }, { type: 'reasoning', text: 'second' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'reasoning', text: 'First\nsecond' });
  });

  it('keeps the legacy "thinking" alias', () => {
    const items = fold({ type: 'thinking', text: 'hmm' });
    expect(items[0]).toMatchObject({ kind: 'reasoning', text: 'hmm' });
  });

  it('records tool calls and results, marking errors', () => {
    const items = fold(
      { type: 'tool-call', toolName: 'executeTs', toolCallId: 'c1', input: { code: '1+1' } },
      { type: 'tool-error', toolName: 'executeTs', toolCallId: 'c1', error: 'boom' },
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'tool-call', toolName: 'executeTs', input: { code: '1+1' } });
    expect(items[1]).toMatchObject({ kind: 'tool-result', error: 'boom', toolCallId: 'c1' });
  });

  it('folds a send_task call, its progress and its result into one subagent step', () => {
    const nestedCall = { type: 'tool-call', toolName: 'search', toolCallId: 'n1' };
    const items = fold(
      {
        type: 'tool-call',
        toolName: 'send_task',
        toolCallId: 'c1',
        input: { agentId: 'joker', message: 'tell a joke' },
      },
      {
        type: 'send-task-progress',
        toolName: 'send_task',
        taskId: 't1',
        state: 'submitted',
        agentId: 'joker',
        agentName: 'Joker',
        url: 'http://sub',
      },
      {
        type: 'send-task-progress',
        toolName: 'send_task',
        taskId: 't1',
        state: 'working',
        agentId: 'joker',
        event: nestedCall,
      },
      {
        type: 'send-task-progress',
        toolName: 'send_task',
        taskId: 't1',
        state: 'completed',
        agentId: 'joker',
        text: 'done!',
      },
      {
        type: 'tool-result',
        toolName: 'send_task',
        toolCallId: 'c1',
        output: { taskId: 't1', state: 'completed', text: 'done!' },
      },
    );
    expect(items).toHaveLength(1);
    const subagent = items[0];
    expect(subagent).toMatchObject({
      kind: 'subagent',
      toolCallId: 'c1',
      agentId: 'joker',
      agentName: 'Joker',
      prompt: 'tell a joke',
      taskId: 't1',
      state: 'completed',
      text: 'done!',
      url: 'http://sub',
    });
    if (subagent?.kind !== 'subagent') throw new Error('expected a subagent item');
    expect(subagent.items).toHaveLength(1);
    expect(subagent.items[0]).toMatchObject({ kind: 'tool-call', toolName: 'search' });
    expect(countTimelineSteps(items)).toBe(2);
    expect(countSubagents(items)).toBe(1);
  });

  it('lets a late send_task call claim the step its early progress opened', () => {
    const items = fold(
      { type: 'send-task-progress', toolName: 'send_task', taskId: 't1', state: 'submitted', agentId: 'joker' },
      { type: 'tool-call', toolName: 'send_task', toolCallId: 'c1', input: { agentId: 'joker', message: 'hi' } },
      {
        type: 'tool-result',
        toolName: 'send_task',
        toolCallId: 'c1',
        output: { taskId: 't1', state: 'completed', text: 'yo' },
      },
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'subagent',
      taskId: 't1',
      toolCallId: 'c1',
      prompt: 'hi',
      text: 'yo',
      state: 'completed',
    });
  });

  it('marks a failed send_task on its subagent step', () => {
    const items = fold(
      { type: 'tool-call', toolName: 'send_task', toolCallId: 'c1', input: { agentId: 'joker', message: 'x' } },
      { type: 'tool-error', toolName: 'send_task', toolCallId: 'c1', error: 'unreachable' },
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'subagent', state: 'failed', error: 'unreachable' });
  });

  it('attaches progress to the pending call for the same agent when two delegations overlap', () => {
    const items = fold(
      { type: 'tool-call', toolName: 'send_task', toolCallId: 'c1', input: { agentId: 'a', message: 'one' } },
      { type: 'tool-call', toolName: 'send_task', toolCallId: 'c2', input: { agentId: 'b', message: 'two' } },
      { type: 'send-task-progress', toolName: 'send_task', taskId: 't2', state: 'working', agentId: 'b' },
      { type: 'send-task-progress', toolName: 'send_task', taskId: 't1', state: 'working', agentId: 'a' },
    );
    expect(items.map((item) => (item.kind === 'subagent' ? item.taskId : undefined))).toEqual(['t1', 't2']);
  });

  it('nests deeper delegations and reports the depth', () => {
    const grandchildProgress = {
      type: 'send-task-progress',
      toolName: 'send_task',
      taskId: 't2',
      state: 'working',
      agentId: 'c',
      agentName: 'Child',
    };
    const items = fold(
      { type: 'tool-call', toolName: 'send_task', toolCallId: 'c1', input: { agentId: 'b', message: 'go' } },
      {
        type: 'send-task-progress',
        toolName: 'send_task',
        taskId: 't1',
        state: 'working',
        agentId: 'b',
        agentName: 'Parent',
        event: grandchildProgress,
      },
    );
    expect(subagentDepth(items)).toBe(2);
    const { chain, current } = activeSubagentChain(items);
    expect(chain.map(subagentLabel)).toEqual(['Parent', 'Child']);
    expect(current).toBeUndefined();
  });

  it('ignores unrelated data parts such as finish events', () => {
    expect(fold({ type: 'finish', finishReason: 'stop' })).toHaveLength(0);
  });
});

describe('dataFromPersistedEvent', () => {
  it('unwraps the synthetic status-update the server persists', () => {
    const data = dataFromPersistedEvent({
      kind: 'status-update',
      status: { message: { parts: [{ kind: 'data', data: { type: 'tool-call', toolName: 'x' } }] } },
    });
    expect(data).toEqual({ type: 'tool-call', toolName: 'x' });
  });
});

describe('describeTimelineItem', () => {
  it('names the step for the activity header', () => {
    const [item] = fold({ type: 'tool-call', toolName: 'executeTs', toolCallId: 'c1' });
    if (!item) throw new Error('expected an item');
    expect(describeTimelineItem(item)).toBe('Calling executeTs');
  });
});
