import { describe, expect, it } from '@effect/vitest';
import { AgentRunStore } from 'agentdock-sdk';
import type { AgentRunRecord } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { TestDatabaseLive } from '../workflows/test-db';
import { AgentRunStoreLive } from './run-store';

const testLayer = AgentRunStoreLive.pipe(Layer.provide(TestDatabaseLive));

const record = (overrides: Partial<AgentRunRecord> = {}): AgentRunRecord => ({
  id: 'run-1',
  contextId: 'context-1',
  agentId: 'agent-1',
  status: { state: 'completed', timestamp: '2026-07-03T00:00:00.000Z' },
  history: [{ role: 'user', messageId: 'msg-1', parts: [{ kind: 'text', text: 'hello' }] }],
  artifacts: [{ artifactId: 'artifact-1', parts: [{ kind: 'text', text: 'hi' }] }],
  origin: { surface: 'a2a' },
  createdAt: '2026-07-03T00:00:00.000Z',
  updatedAt: '2026-07-03T00:00:00.000Z',
  ...overrides,
});

describe('AgentRunStoreLive', () => {
  it.effect('round-trips save/get/listByContext/listByWorkflowRun/delete through a real database', () =>
    Effect.gen(function* () {
      const store = yield* AgentRunStore;

      const a2aRun = record({ id: 'run-a2a', contextId: 'ctx-1' });
      const workflowRun = record({
        id: 'run-workflow',
        contextId: 'ctx-1',
        agentId: 'agent-2',
        origin: { surface: 'workflow', workflowId: 'wf-1', workflowRunId: 'wfr-1', stepId: 'node-1', attempt: 2 },
      });
      const otherContextRun = record({ id: 'run-other', contextId: 'ctx-2' });

      yield* store.save(a2aRun);
      yield* store.save(workflowRun);
      yield* store.save(otherContextRun);

      expect(yield* store.get('run-a2a')).toEqual(a2aRun);
      expect(yield* store.get('does-not-exist')).toBeNull();
      expect((yield* store.listByContext('ctx-1')).map((r) => r.id).sort()).toEqual(['run-a2a', 'run-workflow']);
      expect(yield* store.listByWorkflowRun('wfr-1')).toEqual([workflowRun]);

      // Saving again with the same id updates the row rather than inserting a
      // second one (`onConflictDoUpdate`).
      const updated = { ...a2aRun, status: { state: 'failed' as const, timestamp: '2026-07-03T00:00:05.000Z' } };
      yield* store.save(updated);
      expect(yield* store.get('run-a2a')).toEqual(updated);
      expect((yield* store.listByContext('ctx-1')).length).toBe(2);

      yield* store.delete('run-a2a');
      expect(yield* store.get('run-a2a')).toBeNull();
      expect((yield* store.listByContext('ctx-1')).map((r) => r.id)).toEqual(['run-workflow']);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('flattens and reassembles the workflow origin exactly, including the attempt number', () =>
    Effect.gen(function* () {
      const store = yield* AgentRunStore;
      const withMetadataAndMessage = record({
        id: 'run-full',
        origin: { surface: 'workflow', workflowId: 'wf-2', workflowRunId: 'wfr-2', stepId: 'node-9', attempt: 5 },
        metadata: { note: 'from a test' },
        status: {
          state: 'input-required',
          timestamp: '2026-07-03T00:00:10.000Z',
          message: { role: 'agent', messageId: 'msg-status', parts: [{ kind: 'text', text: 'need input' }] },
        },
      });
      yield* store.save(withMetadataAndMessage);
      expect(yield* store.get('run-full')).toEqual(withMetadataAndMessage);
    }).pipe(Effect.provide(testLayer)),
  );
});
