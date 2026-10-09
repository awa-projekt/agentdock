import type { Workflow } from 'agentdock-sdk/schemas';
import {
  applyRunEvent,
  stepExecutions,
  type JsonObject,
  WorkflowPendingAction,
  WorkflowRun,
  type WorkflowRunEvent,
  WorkflowRunEventList,
  type WorkflowRunId,
  WorkflowRunList,
  WorkflowRunSnapshot,
  WorkflowStepRun,
} from 'agentdock-sdk/schemas';
import {
  type DatabaseClient,
  tryDbWith,
  workflowPendingActionsTable,
  workflowRunEventsTable,
  workflowRunsTable,
  workflowStepsTable,
} from 'db';
import { and, desc, eq } from 'drizzle-orm';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

const decodeRun = Schema.decodeUnknownSync(WorkflowRun);
const decodePendingAction = Schema.decodeUnknownSync(WorkflowPendingAction);
const decodeRunList = Schema.decodeUnknownSync(WorkflowRunList);
const decodeStepRun = Schema.decodeUnknownSync(WorkflowStepRun);
const decodeEventList = Schema.decodeUnknownSync(WorkflowRunEventList);
const decodeSnapshot = Schema.decodeUnknownSync(WorkflowRunSnapshot);

const eventsForStep = (events: ReadonlyArray<WorkflowRunEvent>, stepId: string): ReadonlyArray<WorkflowRunEvent> =>
  events.filter((event) => 'stepId' in event && event.stepId === stepId);

const eventStepId = (event: WorkflowRunEvent): string | null => ('stepId' in event ? event.stepId : null);

const reduceSingleEvent = (event: WorkflowRunEvent) =>
  applyRunEvent({ runStatus: 'submitted', steps: new Map() }, event);

type Tx = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

const appendRunEvent = async (db: DatabaseClient | Tx, event: WorkflowRunEvent): Promise<void> => {
  const status = reduceSingleEvent(event).runStatus;
  if (event.type === 'run-started') {
    await db
      .update(workflowRunsTable)
      .set({ status, input: event.input })
      .where(eq(workflowRunsTable.id, event.runId))
      .run();
    return;
  }
  if (event.type === 'run-completed') {
    await db
      .update(workflowRunsTable)
      .set({ status, output: event.output, completedAt: event.timestamp })
      .where(eq(workflowRunsTable.id, event.runId))
      .run();
    return;
  }
  if (event.type === 'run-failed') {
    await db
      .update(workflowRunsTable)
      .set({ status, error: event.error, completedAt: event.timestamp })
      .where(eq(workflowRunsTable.id, event.runId))
      .run();
    return;
  }
  if (event.type === 'run-canceled') {
    await db
      .update(workflowRunsTable)
      .set({ status, completedAt: event.timestamp })
      .where(eq(workflowRunsTable.id, event.runId))
      .run();
    return;
  }
  if (event.type === 'human-input-requested') {
    await db.update(workflowRunsTable).set({ status }).where(eq(workflowRunsTable.id, event.runId)).run();
    return;
  }
  if (event.type === 'human-input-resolved') {
    await db.update(workflowRunsTable).set({ status }).where(eq(workflowRunsTable.id, event.runId)).run();
  }
};

/**
 * Steps are discovered as the artifact runs, so every step event upserts its
 * row rather than updating a pre-created one. `onConflictDoUpdate` keeps the
 * first-seen row and layers each subsequent event onto it.
 */
const appendStepEvent = async (db: DatabaseClient | Tx, event: WorkflowRunEvent): Promise<void> => {
  if (!('stepId' in event)) return;
  const step = reduceSingleEvent(event).steps.get(event.stepId);
  const patch = ((): Record<string, string> | null => {
    switch (event.type) {
      case 'step-started':
        return { status: step?.status ?? 'running', input: event.input, startedAt: event.timestamp };
      case 'step-completed':
        return { status: step?.status ?? 'completed', output: event.output, completedAt: event.timestamp };
      case 'step-failed':
        return { status: step?.status ?? 'failed', error: event.error, completedAt: event.timestamp };
      case 'human-input-requested':
        return { status: step?.status ?? 'waiting' };
      case 'human-input-resolved':
        return { status: step?.status ?? 'running' };
      default:
        return null;
    }
  })();

  await db
    .insert(workflowStepsTable)
    .values({
      runId: event.runId,
      stepId: event.stepId,
      label: event.label,
      status: 'pending',
      ...patch,
    })
    .onConflictDoUpdate({
      target: [workflowStepsTable.runId, workflowStepsTable.stepId],
      set: patch ?? { label: event.label },
    })
    .run();
};

export const createWorkflowRunRepo = <E>(db: DatabaseClient, makeError: (cause: unknown) => E) => {
  const tryDb = tryDbWith(makeError);
  return {
    createRun: (input: {
      readonly workflow: Workflow;
      readonly taskId: string;
      readonly contextId?: string;
      readonly value: WorkflowRun;
    }): Effect.Effect<WorkflowRun, E> =>
      tryDb(() =>
        db.transaction(async (tx) => {
          await tx.insert(workflowRunsTable).values(input.value).run();
          return input.value;
        }),
      ),
    getWaitingByTask: (input: {
      readonly workflowId: string;
      readonly taskId: string;
      readonly contextId: string;
    }): Effect.Effect<WorkflowRun | null, E> =>
      tryDb(() =>
        db
          .select()
          .from(workflowRunsTable)
          .where(
            and(
              eq(workflowRunsTable.workflowId, input.workflowId),
              eq(workflowRunsTable.taskId, input.taskId),
              eq(workflowRunsTable.contextId, input.contextId),
              eq(workflowRunsTable.status, 'input-required'),
            ),
          )
          .orderBy(desc(workflowRunsTable.startedAt))
          .limit(1)
          .all(),
      ).pipe(Effect.map((rows) => (rows[0] ? decodeRun(rows[0]) : null))),
    createPendingAction: (action: WorkflowPendingAction): Effect.Effect<void, E> =>
      tryDb(() => db.insert(workflowPendingActionsTable).values(action).onConflictDoNothing().run()).pipe(
        Effect.asVoid,
      ),
    resolvePendingAction: (input: {
      readonly actionId: string;
      readonly response: JsonObject;
      readonly resolvedAt: string;
    }): Effect.Effect<WorkflowPendingAction | null, E> =>
      tryDb(() =>
        db.transaction(async (tx) => {
          const rows = await tx
            .select()
            .from(workflowPendingActionsTable)
            .where(
              and(
                eq(workflowPendingActionsTable.id, input.actionId),
                eq(workflowPendingActionsTable.status, 'pending'),
              ),
            )
            .limit(1)
            .all();
          const action = rows[0];
          if (!action) return null;
          await tx
            .update(workflowPendingActionsTable)
            .set({ status: 'resolved', response: input.response, resolvedAt: input.resolvedAt })
            .where(eq(workflowPendingActionsTable.id, input.actionId))
            .run();
          return decodePendingAction({
            ...action,
            status: 'resolved',
            response: input.response,
            resolvedAt: input.resolvedAt,
          });
        }),
      ),
    appendEvent: (event: WorkflowRunEvent): Effect.Effect<void, E> =>
      tryDb(async () => {
        await db
          .insert(workflowRunEventsTable)
          .values({
            id: event.id,
            runId: event.runId,
            workflowId: event.workflowId,
            taskId: event.taskId,
            eventType: event.type,
            stepId: eventStepId(event),
            timestamp: event.timestamp,
            event,
          })
          .run();
        await appendRunEvent(db, event);
        await appendStepEvent(db, event);
      }).pipe(Effect.asVoid),
    list: (): Effect.Effect<ReadonlyArray<WorkflowRun>, E> =>
      tryDb(() => db.select().from(workflowRunsTable).orderBy(desc(workflowRunsTable.startedAt)).all()).pipe(
        Effect.map(decodeRunList),
      ),
    getSnapshot: (id: WorkflowRunId): Effect.Effect<WorkflowRunSnapshot | null, E> =>
      tryDb(async () => {
        const runs = await db.select().from(workflowRunsTable).where(eq(workflowRunsTable.id, id)).limit(1).all();
        const run = runs[0];
        if (!run) return null;
        const eventRows = await db
          .select({ event: workflowRunEventsTable.event })
          .from(workflowRunEventsTable)
          .where(eq(workflowRunEventsTable.runId, id))
          .orderBy(workflowRunEventsTable.timestamp)
          .all();
        const events = decodeEventList(eventRows.map((row) => row.event));
        const stepRows = await db.select().from(workflowStepsTable).where(eq(workflowStepsTable.runId, id)).all();
        const steps = stepRows.map((step) =>
          decodeStepRun({
            ...step,
            executions: stepExecutions(events, step.stepId),
            events: eventsForStep(events, step.stepId),
          }),
        );
        return decodeSnapshot({ run, steps });
      }),
    listEvents: (id: WorkflowRunId): Effect.Effect<ReadonlyArray<WorkflowRunEvent> | null, E> =>
      tryDb(async () => {
        const runs = await db
          .select({ id: workflowRunsTable.id })
          .from(workflowRunsTable)
          .where(eq(workflowRunsTable.id, id))
          .limit(1)
          .all();
        if (!runs[0]) return null;
        const rows = await db
          .select({ event: workflowRunEventsTable.event })
          .from(workflowRunEventsTable)
          .where(eq(workflowRunEventsTable.runId, id))
          .orderBy(workflowRunEventsTable.timestamp)
          .all();
        return decodeEventList(rows.map((row) => row.event));
      }),
  };
};
