import type { Session } from 'agentdock-sdk/schemas';
import { describe, expect, it } from 'vitest';
import type { ChatSession } from './model';
import { persistedCoversLocal, toChatSession } from './persistence';

const session: Session = {
  id: 's1',
  title: 'Hello',
  messages: [
    { id: 'u1', role: 'user', text: 'Hello', createdAt: 10 },
    {
      id: 'a1',
      role: 'assistant',
      text: 'Hi there',
      status: 'Completed',
      statusHistory: [{ id: 'h1', label: 'Working', at: 11 }],
      events: [
        {
          id: 'e1',
          kind: 'status-update',
          summary: 'tool-call: x',
          rawEvent: {
            kind: 'status-update',
            status: { message: { parts: [{ kind: 'data', data: { type: 'tool-call', toolName: 'x' } }] } },
          },
          at: 12,
        },
      ],
      createdAt: 13,
    },
  ],
  conversationState: { contextId: 'ctx', taskId: 't1' },
  createdAt: 1,
  updatedAt: 20,
};

describe('toChatSession', () => {
  it('maps a persisted session onto the chat model', () => {
    const chat = toChatSession(session);
    expect(chat).toMatchObject({ contextId: 'ctx', serverId: 's1', taskId: 't1', taskState: 'completed' });
    expect(chat.messages[1]).toMatchObject({ role: 'assistant', state: 'completed', working: false });
    const assistant = chat.messages[1];
    if (assistant?.role !== 'assistant') throw new Error('expected assistant');
    expect(assistant.timeline[0]).toMatchObject({ kind: 'tool-call', toolName: 'x' });
  });

  it('turns failed turns into errors', () => {
    const failed = toChatSession({
      ...session,
      messages: [{ id: 'a1', role: 'assistant', text: 'Agent execution error', status: 'Failed' }],
    });
    expect(failed.messages[0]).toMatchObject({ role: 'assistant', error: 'Agent execution error', text: '' });
  });
});

describe('persistedCoversLocal', () => {
  const remote = toChatSession(session);
  const local: ChatSession = {
    ...remote,
    serverId: undefined,
    messages: [
      { id: 'u1', role: 'user', text: 'Hello', createdAt: 10 },
      {
        id: 'local-a',
        role: 'assistant',
        text: 'Hi there',
        state: 'completed',
        working: false,
        error: undefined,
        timeline: [],
        startedAt: 10,
        finishedAt: 15,
        taskId: 't1',
      },
    ],
  };

  it('is true once the server has the last user message and its answer', () => {
    expect(persistedCoversLocal(remote, local)).toBe(true);
  });

  it('is false while the local turn is still streaming', () => {
    const streaming: ChatSession = {
      ...local,
      messages: local.messages.map((message) =>
        message.role === 'assistant' ? { ...message, working: true, state: 'working' } : message,
      ),
    };
    expect(persistedCoversLocal(remote, streaming)).toBe(false);
  });

  it('is false when the server has not seen the last user message', () => {
    const newer: ChatSession = {
      ...local,
      messages: [...local.messages, { id: 'u2', role: 'user', text: 'More', createdAt: 30 }],
    };
    expect(persistedCoversLocal(remote, newer)).toBe(false);
  });
});
