import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import {
  manifestAgentNames,
  manifestGraphLocation,
  manifestInputContract,
  manifestToolNames,
  manifestWorkflowNames,
  reduceRunProgress,
  stepExecutions,
  reduceRunStatus,
  WorkflowId,
  WorkflowManifest,
  WorkflowPendingActionId,
  type WorkflowRunEvent,
  WorkflowRunEventId,
  WorkflowRunId,
  type WorkflowStepRun,
} from './workflows';

describe('WorkflowManifest', () => {
  const decode = Schema.decodeUnknownSync(WorkflowManifest);

  it('carries the graph location, contracts, bindings and secrets', () => {
    const manifest = decode({
      name: 'Brief',
      description: 'A brief.',
      version: '1.0.0',
      graph: './main.ts:graph',
      input: { type: 'object' },
      agents: { research: { description: 'Looks things up' } },
      workflows: { publish: {} },
      tools: { publish_post: { description: 'Publishes the approved post' } },
      secrets: ['OPENAI_API_KEY'],
    });

    expect(manifestGraphLocation(manifest)).toEqual({ module: './main.ts', exportName: 'graph' });
    expect(manifest.input).toEqual({ type: 'object' });
    expect(manifestAgentNames(manifest)).toEqual(['research']);
    expect(manifestWorkflowNames(manifest)).toEqual(['publish']);
    expect(manifestToolNames(manifest)).toEqual(['publish_post']);
    expect(manifest.secrets).toEqual(['OPENAI_API_KEY']);
  });

  it('defaults the graph location and derives the a2a input contract', () => {
    const manifest = decode({ name: 'Brief', description: 'A brief.', version: '1.0.0', input: { type: 'string' } });

    expect(manifestGraphLocation(manifest)).toEqual({ module: './workflow.ts', exportName: 'default' });
    expect(manifestInputContract(manifest)).toEqual({ name: 'input', schema: '{"type":"string"}' });
  });
});

const eventBase = {
  id: WorkflowRunEventId.make('event_1'),
  runId: WorkflowRunId.make('run_1'),
  workflowId: WorkflowId.make('workflow_1'),
  taskId: 'task_1',
  timestamp: '2026-01-01T00:00:00.000Z',
};

const step = {
  runId: WorkflowRunId.make('run_1'),
  stepId: 'review',
  label: 'Review',
  status: 'pending',
  executions: 0,
  events: [],
} satisfies WorkflowStepRun;

const stepEvent = (
  id: string,
  type: 'step-started' | 'step-completed',
  stepId: string,
  executionId: string,
): WorkflowRunEvent =>
  type === 'step-started'
    ? { ...eventBase, id: WorkflowRunEventId.make(id), type, stepId, label: stepId, executionId, input: '' }
    : { ...eventBase, id: WorkflowRunEventId.make(id), type, stepId, label: stepId, executionId, output: '' };

describe('workflow run progress reducer', () => {
  it('keeps every round of a loop and every fan-out branch on one step', () => {
    const rounds = [
      stepEvent('e1', 'step-started', 'review', 'task-1'),
      stepEvent('e2', 'step-completed', 'review', 'task-1'),
      stepEvent('e3', 'step-started', 'review', 'task-2'),
    ];
    const second = reduceRunProgress('working', [], rounds).steps.get('review');
    expect(second?.status).toBe('running');
    expect(second?.executions.size).toBe(2);
    expect(stepExecutions(rounds, 'review')).toBe(2);

    const branches = [
      stepEvent('e1', 'step-started', 'team:research', 'task-a'),
      stepEvent('e2', 'step-started', 'team:research', 'task-b'),
      stepEvent('e3', 'step-completed', 'team:research', 'task-a'),
    ];
    expect(reduceRunProgress('working', [], branches).steps.get('team:research')?.status).toBe('running');
    const done = [...branches, stepEvent('e4', 'step-completed', 'team:research', 'task-b')];
    expect(reduceRunProgress('working', [], done).steps.get('team:research')?.status).toBe('completed');
  });

  it('folds human input requested and resolved events into run and step status', () => {
    const requested = {
      ...eventBase,
      type: 'human-input-requested',
      stepId: 'review',
      label: 'Review',
      actionId: WorkflowPendingActionId.make('action_1'),
      title: 'Review',
    } satisfies WorkflowRunEvent;
    const resolved = {
      ...eventBase,
      id: WorkflowRunEventId.make('event_2'),
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'human-input-resolved',
      stepId: 'review',
      label: 'Review',
      actionId: WorkflowPendingActionId.make('action_1'),
      response: '{"approved":true}',
    } satisfies WorkflowRunEvent;

    const waiting = reduceRunProgress('working', [step], [requested]);
    expect(waiting.runStatus).toBe('input-required');
    expect(waiting.steps.get('review')?.status).toBe('waiting');

    const resumed = reduceRunProgress('working', [step], [requested, resolved]);
    expect(resumed.runStatus).toBe('working');
    expect(resumed.steps.get('review')?.status).toBe('running');
  });

  // Steps are discovered as a code workflow runs, so the reducer has to
  // materialise one it was never told about up front.
  it('materialises a step it first sees in the event stream', () => {
    const started = {
      ...eventBase,
      type: 'step-started',
      stepId: 'research',
      label: 'Research',
      input: 'topic',
    } satisfies WorkflowRunEvent;
    const completed = {
      ...eventBase,
      id: WorkflowRunEventId.make('event_2'),
      type: 'step-completed',
      stepId: 'research',
      label: 'Research',
      output: 'findings',
    } satisfies WorkflowRunEvent;

    const progress = reduceRunProgress('working', [], [started, completed]);

    expect(progress.steps.get('research')).toMatchObject({
      status: 'completed',
      label: 'Research',
      input: 'topic',
      output: 'findings',
    });
  });

  it('reduces the terminal run status from the event stream', () => {
    const failed = {
      ...eventBase,
      type: 'run-failed',
      error: 'boom',
    } satisfies WorkflowRunEvent;

    expect(reduceRunStatus('working', [failed])).toBe('failed');
  });
});
