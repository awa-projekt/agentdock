import { eq } from 'drizzle-orm';
import { db, workflowsTable } from 'db';
import { Context, Data, Effect, Layer, Schema } from 'effect';
import {
  CreateWorkflowInputSchema,
  UpdateWorkflowInputSchema,
  WorkflowListSchema,
  WorkflowSchema,
  type CreateWorkflowInput,
  type UpdateWorkflowInput,
  type Workflow,
} from './schemas';

type WorkflowRegistryService = {
  readonly add: (input: CreateWorkflowInput) => Effect.Effect<Workflow, unknown>;
  readonly update: (workflowId: string, input: UpdateWorkflowInput) => Effect.Effect<Workflow | null, unknown>;
  readonly list: () => Effect.Effect<ReadonlyArray<Workflow>, unknown>;
  readonly getById: (workflowId: string) => Effect.Effect<Workflow | null, unknown>;
  readonly remove: (workflowId: string) => Effect.Effect<boolean, unknown>;
};

const decodeCreateWorkflowInput = Schema.decodeUnknownSync(CreateWorkflowInputSchema);
const decodeUpdateWorkflowInput = Schema.decodeUnknownSync(UpdateWorkflowInputSchema);
const decodeWorkflow = Schema.decodeUnknownSync(WorkflowSchema);
const decodeWorkflowList = Schema.decodeUnknownSync(WorkflowListSchema);

const workflowId = (): string => `wf_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
class WorkflowRegistryError extends Data.TaggedError('WorkflowRegistryError')<{
  readonly cause: unknown;
}> {}

const toWorkflowRegistryError = (cause: unknown): WorkflowRegistryError => new WorkflowRegistryError({ cause });
const tryDb = <A>(try_: () => Promise<A>): Effect.Effect<A, WorkflowRegistryError> =>
  Effect.tryPromise({ try: try_, catch: toWorkflowRegistryError });

const addWorkflow = Effect.fn('WorkflowRegistry.addWorkflow')(function* (input: CreateWorkflowInput) {
  const validatedInput = decodeCreateWorkflowInput(input);
  const workflow = decodeWorkflow({
    ...validatedInput,
    id: workflowId(),
  });

  yield* tryDb(() => db.insert(workflowsTable).values(workflow).run());
  return workflow;
});

const listWorkflows = Effect.fn('WorkflowRegistry.listWorkflows')(function* () {
  const rows = yield* tryDb(() => db.select().from(workflowsTable).all());
  return decodeWorkflowList(rows);
});

const getWorkflowById = Effect.fn('WorkflowRegistry.getWorkflowById')(function* (workflowId: string) {
  const workflows = yield* tryDb(() =>
    db.select().from(workflowsTable).where(eq(workflowsTable.id, workflowId)).limit(1).all(),
  );

  return workflows[0] ? decodeWorkflow(workflows[0]) : null;
});

const updateWorkflow = Effect.fn('WorkflowRegistry.updateWorkflow')(function* (
  workflowId: string,
  input: UpdateWorkflowInput,
) {
  const validatedInput = decodeUpdateWorkflowInput(input);
  const workflow = decodeWorkflow({
    ...validatedInput,
    id: workflowId,
  });
  const result = yield* tryDb(() =>
    db.update(workflowsTable).set(workflow).where(eq(workflowsTable.id, workflowId)).run(),
  );

  return result.rowsAffected > 0 ? workflow : null;
});

const removeWorkflow = Effect.fn('WorkflowRegistry.removeWorkflow')(function* (workflowId: string) {
  const result = yield* tryDb(() => db.delete(workflowsTable).where(eq(workflowsTable.id, workflowId)).run());

  return result.rowsAffected > 0;
});

export const WorkflowRegistry = Context.Service<WorkflowRegistryService>('@agentdock/api/WorkflowRegistry');

export const WorkflowRegistryLive = Layer.effect(
  WorkflowRegistry,
  Effect.gen(function* () {
    return WorkflowRegistry.of({
      add: Effect.fn('WorkflowRegistry.add')(function* (input: CreateWorkflowInput) {
        return yield* addWorkflow(input);
      }),
      update: Effect.fn('WorkflowRegistry.update')(function* (workflowId: string, input: UpdateWorkflowInput) {
        return yield* updateWorkflow(workflowId, input);
      }),
      list: Effect.fn('WorkflowRegistry.list')(function* () {
        return yield* listWorkflows();
      }),
      getById: Effect.fn('WorkflowRegistry.getById')(function* (workflowId: string) {
        return yield* getWorkflowById(workflowId);
      }),
      remove: Effect.fn('WorkflowRegistry.remove')(function* (workflowId: string) {
        return yield* removeWorkflow(workflowId);
      }),
    });
  }),
);
