import type { Task } from '@a2a-js/sdk';
import { describe, expect, it } from '@effect/vitest';
import { AgentRunStore } from 'agentdock-sdk';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { AgentRunStoreLive } from '../agents/run-store';
import { TestDatabaseLive } from '../workflows/test-db';
import { SessionsService, SessionsServiceLive } from './service';

// `AgentRunStoreLive` is merged in alongside `SessionsServiceLive` (not just
// depended on internally by it) so the test can also assert against the
// store directly — same instance either way, since Effect memoizes a layer
// by reference within one build.
const testLayer = Layer.mergeAll(SessionsServiceLive, AgentRunStoreLive).pipe(Layer.provide(TestDatabaseLive));

const submittedTask = (overrides: Partial<Task> = {}): Task => ({
  kind: 'task',
  id: 'task-1',
  contextId: 'context-1',
  status: { state: 'submitted', timestamp: '2026-07-03T00:00:00.000Z' },
  history: [
    {
      kind: 'message',
      role: 'user',
      messageId: 'msg-1',
      taskId: 'task-1',
      contextId: 'context-1',
      parts: [{ kind: 'text', text: 'hello' }],
    },
  ],
  ...overrides,
});

describe('SessionsServiceLive — a2a TaskStore adapter over AgentRunStore', () => {
  it.effect('round-trips a Task through save/load, scoped to the target it was saved under', () =>
    Effect.gen(function* () {
      const sessions = yield* SessionsService;
      const taskStore = yield* sessions.getTaskStore('agent-1');

      yield* Effect.promise(() => taskStore.save(submittedTask()));

      const loaded = yield* Effect.promise(() => taskStore.load('task-1'));
      expect(loaded?.id).toBe('task-1');
      expect(loaded?.status.state).toBe('submitted');
      expect(loaded?.history?.[0]?.parts).toEqual([{ kind: 'text', text: 'hello' }]);

      // A different target never sees this target's task, even with the same id.
      const otherTaskStore = yield* sessions.getTaskStore('agent-2');
      const notFound = yield* Effect.promise(() => otherTaskStore.load('task-1'));
      expect(notFound).toBeUndefined();

      // The record backing the task is independently readable through
      // `AgentRunStore`, with an `a2a` origin (no workflow-invocation part).
      const store = yield* AgentRunStore;
      const record = yield* store.get('task-1');
      expect(record?.agentId).toBe('agent-1');
      expect(record?.origin).toEqual({ surface: 'a2a' });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('updates the same record (not a new one) as a task moves through statuses, and preserves createdAt', () =>
    Effect.gen(function* () {
      const sessions = yield* SessionsService;
      const taskStore = yield* sessions.getTaskStore('agent-1');
      const store = yield* AgentRunStore;

      yield* Effect.promise(() => taskStore.save(submittedTask()));
      const firstRecord = yield* store.get('task-1');

      yield* Effect.promise(() =>
        taskStore.save(
          submittedTask({
            status: { state: 'completed', timestamp: '2026-07-03T00:01:00.000Z' },
          }),
        ),
      );
      const secondRecord = yield* store.get('task-1');

      expect(secondRecord?.status.state).toBe('completed');
      expect(secondRecord?.createdAt).toBe(firstRecord?.createdAt);
      expect((yield* store.listByContext('context-1')).length).toBe(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('links the record back to its workflow run when the task carries a workflow-agent-invocation part', () =>
    Effect.gen(function* () {
      const sessions = yield* SessionsService;
      const taskStore = yield* sessions.getTaskStore('agent-1');
      const store = yield* AgentRunStore;

      yield* Effect.promise(() =>
        taskStore.save(
          submittedTask({
            history: [
              {
                kind: 'message',
                role: 'user',
                messageId: 'task-1:node-1:1',
                taskId: 'task-1',
                contextId: 'context-1',
                parts: [
                  { kind: 'text', text: 'do the thing' },
                  {
                    kind: 'data',
                    data: {
                      type: 'workflow-agent-invocation',
                      workflowId: 'wf-1',
                      runId: 'wfr-1',
                      stepId: 'node-1',
                    },
                  },
                ],
              },
            ],
          }),
        ),
      );

      const record = yield* store.get('task-1');
      expect(record?.origin).toEqual({
        surface: 'workflow',
        workflowId: 'wf-1',
        workflowRunId: 'wfr-1',
        stepId: 'node-1',
        attempt: 1,
      });

      const byWorkflowRun = yield* store.listByWorkflowRun('wfr-1');
      expect(byWorkflowRun.map((r) => r.id)).toEqual(['task-1']);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('stamps assistant messages with their task state and keeps tool events for text-less turns', () =>
    Effect.gen(function* () {
      const sessions = yield* SessionsService;
      const taskStore = yield* sessions.getTaskStore('agent-1');

      yield* Effect.promise(() => taskStore.save(submittedTask()));
      yield* Effect.promise(() =>
        taskStore.save(
          submittedTask({
            status: { state: 'working', timestamp: '2026-07-03T00:00:30.000Z' },
          }),
        ),
      );

      // A completed turn: user text → thinking → tool call/result → assistant text.
      yield* Effect.promise(() =>
        taskStore.save(
          submittedTask({
            status: { state: 'completed', timestamp: '2026-07-03T00:01:00.000Z' },
            history: [
              {
                kind: 'message',
                role: 'user',
                messageId: 'msg-1',
                taskId: 'task-1',
                contextId: 'context-1',
                parts: [{ kind: 'text', text: 'hello' }],
              },
              {
                kind: 'message',
                role: 'agent',
                messageId: 'msg-2',
                taskId: 'task-1',
                contextId: 'context-1',
                parts: [{ kind: 'data', data: { type: 'thinking', text: 'I should search first.' } }],
              },
              {
                kind: 'message',
                role: 'agent',
                messageId: 'msg-3',
                taskId: 'task-1',
                contextId: 'context-1',
                parts: [{ kind: 'data', data: { type: 'tool-call', toolName: 'search', toolCallId: 'call-1' } }],
              },
              {
                kind: 'message',
                role: 'agent',
                messageId: 'msg-4',
                taskId: 'task-1',
                contextId: 'context-1',
                parts: [{ kind: 'data', data: { type: 'tool-result', toolName: 'search', toolCallId: 'call-1' } }],
              },
              {
                kind: 'message',
                role: 'agent',
                messageId: 'msg-5',
                taskId: 'task-1',
                contextId: 'context-1',
                parts: [{ kind: 'text', text: 'the answer' }],
              },
            ],
          }),
        ),
      );

      const [session] = yield* sessions.listChatSessions('agent-1');
      const assistant = session!.messages.find((message) => message.role === 'assistant');
      expect(assistant?.status).toBe('Completed');
      expect(assistant?.statusHistory?.map((entry) => entry.label)).toEqual(['Submitted', 'Working', 'Completed']);
      expect(assistant?.events?.map((event) => event.summary)).toEqual([
        'Thinking',
        'tool-call: search',
        'tool-result: search',
      ]);
      const user = session!.messages.find((message) => message.role === 'user');
      expect(user?.status).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('keeps a failed turn without assistant text as a synthetic assistant message carrying its events', () =>
    Effect.gen(function* () {
      const sessions = yield* SessionsService;
      const taskStore = yield* sessions.getTaskStore('agent-1');

      yield* Effect.promise(() =>
        taskStore.save(
          submittedTask({
            status: { state: 'failed', timestamp: '2026-07-03T00:01:00.000Z' },
            history: [
              {
                kind: 'message',
                role: 'user',
                messageId: 'msg-1',
                taskId: 'task-1',
                contextId: 'context-1',
                parts: [{ kind: 'text', text: 'hello' }],
              },
              {
                kind: 'message',
                role: 'agent',
                messageId: 'msg-2',
                taskId: 'task-1',
                contextId: 'context-1',
                parts: [
                  {
                    kind: 'data',
                    data: { type: 'tool-error', toolName: 'search', toolCallId: 'call-1', error: 'boom' },
                  },
                ],
              },
            ],
          }),
        ),
      );

      const [session] = yield* sessions.listChatSessions('agent-1');
      const assistant = session!.messages.find((message) => message.role === 'assistant');
      expect(assistant).toBeDefined();
      expect(assistant?.text).toBe('');
      expect(assistant?.status).toBe('Failed');
      expect(assistant?.events?.map((event) => event.summary)).toEqual(['tool-error: search']);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('deleteSession removes the underlying agent-run records for that session', () =>
    Effect.gen(function* () {
      const sessions = yield* SessionsService;
      const taskStore = yield* sessions.getTaskStore('agent-1');
      const store = yield* AgentRunStore;

      yield* Effect.promise(() => taskStore.save(submittedTask()));

      const [session] = yield* sessions.listChatSessions('agent-1');
      expect(session).toBeDefined();
      expect(yield* store.get('task-1')).not.toBeNull();

      yield* sessions.deleteSession({ targetId: 'agent-1', sessionId: session!.id });

      expect(yield* store.get('task-1')).toBeNull();
      expect(yield* sessions.listChatSessions('agent-1')).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );
});
