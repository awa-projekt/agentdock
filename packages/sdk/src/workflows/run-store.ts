import type * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { randomUUIDv4 } from '../random';
import type {
  JsonObject,
  Workflow,
  WorkflowPendingAction,
  WorkflowPendingActionId,
  WorkflowRun,
  WorkflowRunEvent,
  WorkflowRunId,
  WorkflowRunSnapshot,
  WorkflowStepRun,
} from '../schemas';
import { stepExecutions, WorkflowRunId as WorkflowRunIdSchema } from '../schemas';

export type CreateWorkflowRunOptions = {
  readonly workflow: Workflow;
  readonly taskId: string;
  readonly contextId: string;
  readonly input: string;
};

export class WorkflowRunStoreError extends Schema.TaggedError<WorkflowRunStoreError>()('WorkflowRunStoreError', {
  cause: Schema.Defect(),
}) {}

export type WorkflowRunStoreService = {
  readonly create: (options: CreateWorkflowRunOptions) => Effect.Effect<WorkflowRun, WorkflowRunStoreError>;
  readonly getWaitingByTask: (options: {
    readonly workflowId: Workflow['id'];
    readonly taskId: string;
    readonly contextId: string;
  }) => Effect.Effect<WorkflowRun | null, WorkflowRunStoreError>;
  readonly append: (event: WorkflowRunEvent) => Effect.Effect<void, WorkflowRunStoreError>;
  readonly appendEvent: (event: WorkflowRunEvent) => Effect.Effect<void, WorkflowRunStoreError>;
  readonly createPendingAction: (action: WorkflowPendingAction) => Effect.Effect<void, WorkflowRunStoreError>;
  readonly resolvePendingAction: (options: {
    readonly actionId: WorkflowPendingActionId;
    readonly response: JsonObject;
  }) => Effect.Effect<WorkflowPendingAction | null, WorkflowRunStoreError>;
  readonly list: () => Effect.Effect<ReadonlyArray<WorkflowRun>, WorkflowRunStoreError>;
  readonly getSnapshot: (runId: WorkflowRunId) => Effect.Effect<WorkflowRunSnapshot | null, WorkflowRunStoreError>;
  readonly listEvents: (
    runId: WorkflowRunId,
  ) => Effect.Effect<ReadonlyArray<WorkflowRunEvent> | null, WorkflowRunStoreError>;
};

/**
 * Port for durable workflow-run persistence. The runtime writes run lifecycle
 * data through this service; the API supplies a DB-backed layer.
 *
 * Modelling it as an Effect service (rather than synchronous callbacks bridged
 * with `runSync`) means every write is sequenced inside the run program and is
 * awaited before the task is reported complete — so step/run status can never be
 * persisted out of order, and the REST snapshot is consistent the moment the
 * task finishes.
 *
 * Steps are created on first sight rather than pre-declared: a code workflow's
 * step set is only known once it runs. Manifest-declared steps are seeded up
 * front so the inspector can show them as `pending`.
 */
export class WorkflowRunStore extends Context.Service<WorkflowRunStore, WorkflowRunStoreService>()(
  'agentdock-sdk/workflows/run-store/WorkflowRunStore',
) {
  /**
   * Builds a standalone in-memory store instance — mirrors `WorkflowRunStoreLive`'s
   * event-driven status transitions (api/src/workflows/runs.ts) with plain `Map`s
   * instead of Drizzle tables. Exported as a plain factory (not just a `Layer`) so
   * callers that need the same store instance shared across multiple separate
   * `Effect.provide` calls — e.g. tests driving several sequential `execute()`
   * calls to exercise human-input resumption — can wrap it in `Layer.succeed`
   * themselves instead of getting a fresh, empty store from each layer build.
   */
  static readonly inMemory: Layer.Layer<WorkflowRunStore> = Layer.effect(
    WorkflowRunStore,
    Effect.map(Effect.clockWith(Effect.succeed), makeInMemoryWorkflowRunStore),
  );
}

const eventStepId = (event: WorkflowRunEvent): string | undefined => ('stepId' in event ? event.stepId : undefined);

const eventLabel = (event: WorkflowRunEvent): string | undefined => ('label' in event ? event.label : undefined);

export function makeInMemoryWorkflowRunStore(clock: Clock.Clock): WorkflowRunStoreService {
  const runs = new Map<string, WorkflowRun>();
  const stepRuns = new Map<string, Map<string, WorkflowStepRun>>();
  const events = new Map<string, Array<WorkflowRunEvent>>();
  const pendingActions = new Map<string, WorkflowPendingAction>();

  const now = (): string => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));

  /** Upsert: a step exists as soon as any event mentions it. */
  const patchStep = (runId: WorkflowRunId, stepId: string, label: string, patch: Partial<WorkflowStepRun>): void => {
    const steps = stepRuns.get(runId);
    if (!steps) return;
    const existing = steps.get(stepId) ?? {
      runId,
      stepId,
      label,
      status: 'pending' as const,
      executions: 0,
      events: [],
    };
    steps.set(stepId, { ...existing, ...patch });
  };

  const applyStepEvent = (event: WorkflowRunEvent): void => {
    const stepId = eventStepId(event);
    if (!stepId) return;
    const label = eventLabel(event) ?? stepId;
    switch (event.type) {
      case 'step-started':
        patchStep(event.runId, stepId, label, {
          status: 'running',
          input: event.input,
          startedAt: event.timestamp,
        });
        return;
      case 'step-completed':
        patchStep(event.runId, stepId, label, {
          status: 'completed',
          output: event.output,
          completedAt: event.timestamp,
        });
        return;
      case 'step-failed':
        patchStep(event.runId, stepId, label, {
          status: 'failed',
          error: event.error,
          completedAt: event.timestamp,
        });
        return;
      case 'human-input-requested':
        patchStep(event.runId, stepId, label, { status: 'waiting' });
        return;
      case 'human-input-resolved':
        patchStep(event.runId, stepId, label, { status: 'running' });
        return;
      default:
        patchStep(event.runId, stepId, label, {});
    }
  };

  const applyRunEvent = (event: WorkflowRunEvent): void => {
    const run = runs.get(event.runId);
    if (!run) return;
    switch (event.type) {
      case 'run-started':
        runs.set(event.runId, { ...run, status: 'working', input: event.input });
        return;
      case 'run-completed':
        runs.set(event.runId, { ...run, status: 'completed', output: event.output, completedAt: event.timestamp });
        return;
      case 'run-failed':
        runs.set(event.runId, { ...run, status: 'failed', error: event.error, completedAt: event.timestamp });
        return;
      case 'run-canceled':
        runs.set(event.runId, { ...run, status: 'canceled', completedAt: event.timestamp });
        return;
      case 'human-input-requested':
        runs.set(event.runId, { ...run, status: 'input-required' });
        return;
      case 'human-input-resolved':
        runs.set(event.runId, { ...run, status: 'working' });
        return;
      default:
        return;
    }
  };

  const recordEvent = (event: WorkflowRunEvent): Effect.Effect<void, WorkflowRunStoreError> =>
    Effect.sync(() => {
      events.set(event.runId, [...(events.get(event.runId) ?? []), event]);
      applyRunEvent(event);
      applyStepEvent(event);
    });

  return {
    create: ({ workflow, taskId, contextId, input }) =>
      Effect.gen(function* () {
        const id = WorkflowRunIdSchema.make(`wfr_${yield* randomUUIDv4}`);
        const run: WorkflowRun = {
          id,
          workflowId: workflow.id,
          taskId,
          contextId,
          status: 'submitted',
          input,
          sourceHash: workflow.sourceHash,
          startedAt: now(),
        };
        runs.set(id, run);
        stepRuns.set(id, new Map());
        events.set(id, []);
        return run;
      }),
    getWaitingByTask: ({ workflowId, taskId, contextId }) =>
      Effect.sync(
        () =>
          [...runs.values()]
            .filter(
              (run) =>
                run.workflowId === workflowId &&
                run.taskId === taskId &&
                run.contextId === contextId &&
                run.status === 'input-required',
            )
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null,
      ),
    append: recordEvent,
    appendEvent: recordEvent,
    createPendingAction: (action) => Effect.sync(() => void pendingActions.set(action.id, action)),
    resolvePendingAction: ({ actionId, response }) =>
      Effect.sync(() => {
        const action = pendingActions.get(actionId);
        if (action?.status !== 'pending') return null;
        const resolved: WorkflowPendingAction = { ...action, status: 'resolved', response, resolvedAt: now() };
        pendingActions.set(actionId, resolved);
        return resolved;
      }),
    list: () => Effect.sync(() => [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))),
    getSnapshot: (runId) =>
      Effect.sync(() => {
        const run = runs.get(runId);
        if (!run) return null;
        const runEvents = events.get(runId) ?? [];
        const steps = [...(stepRuns.get(runId)?.values() ?? [])].map((step) => ({
          ...step,
          executions: stepExecutions(runEvents, step.stepId),
          events: runEvents.filter((event) => eventStepId(event) === step.stepId),
        }));
        return { run, steps };
      }),
    listEvents: (runId) => Effect.sync(() => (runs.has(runId) ? (events.get(runId) ?? []) : null)),
  };
}
