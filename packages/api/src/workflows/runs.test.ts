import { describe, expect, it } from '@effect/vitest';
import { randomUUIDv4 } from 'agentdock-sdk';
import type { Workflow, WorkflowRunEvent } from 'agentdock-sdk/schemas';
import { WorkflowId, WorkflowRunEventId } from 'agentdock-sdk/schemas';
import { WorkflowRunStore } from 'agentdock-sdk/workflows';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { ToolApprovalDecider } from '../gateway/approvals';
import { WorkflowRunStoreLive } from './runs';

/** No pending action here names a gateway approval, so deciding one is a defect. */
const unusedApprovalDecider = Layer.succeed(
  ToolApprovalDecider,
  ToolApprovalDecider.of({ decideApproval: () => Effect.die('ToolApprovalDecider unused') }),
);

const workflow: Workflow = {
  id: Schema.decodeUnknownSync(WorkflowId)('workflow-1'),
  source: '/srv/workflows/test',
  sourceHash: 'hash-1',
  manifest: { name: 'Test workflow', description: 'Test workflow', version: '0.1.0' },
  bindings: {},
  revision: 1,
};

const runEventId = Schema.decodeUnknownSync(WorkflowRunEventId);

const runEvents = (
  run: { readonly id: WorkflowRunEvent['runId']; readonly taskId: string },
  workflow: Workflow,
  idPrefix: string,
): ReadonlyArray<WorkflowRunEvent> => {
  const base = {
    runId: run.id,
    workflowId: workflow.id,
    taskId: run.taskId,
    timestamp: '2026-06-03T00:00:00.000Z',
  } as const;
  return [
    { ...base, id: runEventId(`${idPrefix}-event-1`), type: 'run-started', input: 'hello' },
    {
      ...base,
      id: runEventId(`${idPrefix}-event-2`),
      type: 'step-started',
      stepId: 'research',
      label: 'Research',
      input: 'hello',
    },
    {
      ...base,
      id: runEventId(`${idPrefix}-event-3`),
      type: 'step-completed',
      stepId: 'research',
      label: 'Research',
      output: 'findings',
    },
    { ...base, id: runEventId(`${idPrefix}-event-4`), type: 'run-completed', output: 'hello' },
  ];
};

const projectSnapshot = (workflow: Workflow) =>
  Effect.gen(function* () {
    const runs = yield* WorkflowRunStore;
    const idPrefix = yield* randomUUIDv4;
    const run = yield* runs.create({
      workflow,
      taskId: `task-${idPrefix}`,
      contextId: `context-${idPrefix}`,
      input: 'hello',
    });

    for (const event of runEvents(run, workflow, idPrefix)) {
      yield* runs.appendEvent(event);
    }

    return yield* runs.getSnapshot(run.id);
  }).pipe(Effect.provide(WorkflowRunStoreLive.pipe(Layer.provide(unusedApprovalDecider))));

describe('WorkflowRuns', () => {
  // A code workflow's steps are only known once it runs, so the store has to
  // create a step row the first time an event mentions it.
  it.effect('creates a step row on first sight and projects it into the snapshot', () =>
    Effect.gen(function* () {
      const snapshot = yield* projectSnapshot(workflow);

      expect(snapshot?.run.status).toBe('completed');
      expect(snapshot?.run.output).toBe('hello');
      expect(snapshot?.run.sourceHash).toBe('hash-1');
      const step = snapshot?.steps.find((candidate) => candidate.stepId === 'research');
      expect(step?.status).toBe('completed');
      expect(step?.label).toBe('Research');
      expect(step?.output).toBe('findings');
      expect(step?.events).toHaveLength(2);
    }),
  );
});
