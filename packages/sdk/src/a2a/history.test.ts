import type { Message } from '@a2a-js/sdk';
import { describe, expect, it } from 'vitest';
import { addToContextHistory, buildGenerationMessages, type ContextHistoryStore } from './history';

const userMessage = (text: string, messageId = 'msg-user'): Message => ({
  kind: 'message',
  messageId,
  role: 'user',
  parts: [{ kind: 'text', text }],
});

const agentMessage = (text: string, messageId = 'msg-agent'): Message => ({
  kind: 'message',
  messageId,
  role: 'agent',
  parts: [{ kind: 'text', text }],
});

describe('buildGenerationMessages', () => {
  it('maps the agent role to assistant and the user role to user', () => {
    const store: ContextHistoryStore = new Map();
    const messages = buildGenerationMessages(store, 'ctx-1', [agentMessage('hi there')], userMessage('hello'));

    expect(messages).toEqual([
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('concatenates stored context history, task history, then the new user message', () => {
    const store: ContextHistoryStore = new Map();
    addToContextHistory(store, 'ctx-1', userMessage('turn one', 'm1'));
    addToContextHistory(store, 'ctx-1', agentMessage('reply one', 'm2'));

    const messages = buildGenerationMessages(
      store,
      'ctx-1',
      [userMessage('turn two from task', 'm3')],
      userMessage('turn three', 'm4'),
    );

    expect(messages.map((m) => m.content)).toEqual(['turn one', 'reply one', 'turn two from task', 'turn three']);
  });

  it('joins multiple text parts of a single message with newlines', () => {
    const store: ContextHistoryStore = new Map();
    const multiPart: Message = {
      kind: 'message',
      messageId: 'm-multi',
      role: 'user',
      parts: [
        { kind: 'text', text: 'line one' },
        { kind: 'text', text: 'line two' },
      ],
    };

    const messages = buildGenerationMessages(store, 'ctx-1', [], multiPart);
    expect(messages).toEqual([{ role: 'user', content: 'line one\nline two' }]);
  });

  it('drops messages that contribute no text (e.g. data/file-only parts)', () => {
    const store: ContextHistoryStore = new Map();
    const dataOnly: Message = {
      kind: 'message',
      messageId: 'm-data',
      role: 'user',
      parts: [{ kind: 'data', data: { foo: 'bar' } }],
    };

    expect(buildGenerationMessages(store, 'ctx-1', [dataOnly], userMessage('real text'))).toEqual([
      { role: 'user', content: 'real text' },
    ]);
  });
});
