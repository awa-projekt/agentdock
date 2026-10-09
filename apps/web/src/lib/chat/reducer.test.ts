import type { Message, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { describe, expect, it } from 'vitest';
import type { AssistantMessage } from './model';
import { applyStreamEvent } from './reducer';

const initial: AssistantMessage = {
  id: 'a1',
  role: 'assistant',
  text: '',
  state: 'submitted',
  working: true,
  error: undefined,
  timeline: [],
  startedAt: 0,
  finishedAt: undefined,
  taskId: undefined,
};

const agentMessage = (parts: Message['parts']): Message => ({
  kind: 'message',
  role: 'agent',
  messageId: 'm1',
  taskId: 't1',
  contextId: 'c1',
  parts,
});

const status = (state: TaskStatusUpdateEvent['status']['state'], message?: Message): TaskStatusUpdateEvent => ({
  kind: 'status-update',
  taskId: 't1',
  contextId: 'c1',
  final: false,
  status: { state, message },
});

const artifact = (text: string, append: boolean): TaskArtifactUpdateEvent => ({
  kind: 'artifact-update',
  taskId: 't1',
  contextId: 'c1',
  append,
  lastChunk: false,
  artifact: { artifactId: 'r', parts: [{ kind: 'text', text }] },
});

describe('applyStreamEvent', () => {
  it('appends streamed deltas and lets the first chunk replace', () => {
    const first = applyStreamEvent(initial, artifact('Hel', false), 1, 'e1');
    const second = applyStreamEvent(first.message, artifact('lo', true), 2, 'e2');
    expect(second.message.text).toBe('Hello');
    expect(second.done).toBe(false);
    expect(second.taskId).toBe('t1');
  });

  it('takes the completed status text as the final answer', () => {
    const streamed = applyStreamEvent(initial, artifact('partial', false), 1, 'e1');
    const done = applyStreamEvent(
      streamed.message,
      status('completed', agentMessage([{ kind: 'text', text: 'final answer' }])),
      5,
      'e2',
    );
    expect(done.done).toBe(true);
    expect(done.message).toMatchObject({ text: 'final answer', state: 'completed', working: false, finishedAt: 5 });
  });

  it('records failures as errors instead of answers', () => {
    const failed = applyStreamEvent(
      initial,
      status('failed', agentMessage([{ kind: 'text', text: 'kaput' }])),
      3,
      'e1',
    );
    expect(failed.message).toMatchObject({ error: 'kaput', text: '', working: false });
    expect(failed.done).toBe(true);
  });

  it('folds data parts into the timeline while working', () => {
    const update = applyStreamEvent(
      initial,
      status('working', agentMessage([{ kind: 'data', data: { type: 'tool-call', toolName: 'x', toolCallId: '1' } }])),
      2,
      'e1',
    );
    expect(update.message.timeline).toHaveLength(1);
    expect(update.message.working).toBe(true);
    expect(update.done).toBe(false);
  });

  it('pauses on input-required with the request attached', () => {
    const update = applyStreamEvent(
      initial,
      status('input-required', agentMessage([{ kind: 'data', data: { type: 'mcp-elicitation', message: 'ok?' } }])),
      2,
      'e1',
    );
    expect(update.message.working).toBe(false);
    expect(update.message.timeline[0]).toMatchObject({ kind: 'input-required', request: { message: 'ok?' } });
    expect(update.done).toBe(false);
  });

  it('treats a direct message reply as a completed turn', () => {
    const update = applyStreamEvent(initial, agentMessage([{ kind: 'text', text: 'hi' }]), 1, 'e1');
    expect(update.message).toMatchObject({ text: 'hi', state: 'completed', working: false });
    expect(update.done).toBe(true);
  });
});
