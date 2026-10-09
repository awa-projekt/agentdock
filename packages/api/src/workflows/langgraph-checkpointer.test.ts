import type { Message, Task } from '@a2a-js/sdk';
import { type ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { type CheckpointMetadata, emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { AgentLoopFactory, AgentRunStore, AgentToolResolver, ModelProvider } from 'agentdock-sdk';
import type { JsonObject, Workflow, WorkflowPendingAction, WorkflowRun, WorkflowRunEvent } from 'agentdock-sdk/schemas';
import { WorkflowId, WorkflowRunId } from 'agentdock-sdk/schemas';
import {
  loadWorkflowManifest,
  WorkflowRunStore,
  WorkflowTaskExecutor,
  WorkflowToolInvoker,
} from 'agentdock-sdk/workflows';
import { type DatabaseClient, langgraphCheckpointsTable } from 'db';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Path from 'effect/Path';
import * as Queue from 'effect/Queue';
import * as Schema from 'effect/Schema';
import type * as Scope from 'effect/Scope';
import { DrizzleLibsqlCheckpointSaver } from './langgraph-checkpointer';
import { makeTestDb } from './test-db';

// No workflow in these tests calls an agent — the agent services just need to
// satisfy the runtime's uniformly widened Effect requirements.
const agentServicesLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(AgentLoopFactory, AgentLoopFactory.of({ create: () => Effect.die('AgentLoopFactory unused') })),
  Layer.succeed(ModelProvider, ModelProvider.of({ resolve: () => Effect.die('ModelProvider unused') })),
  AgentToolResolver.static([]),
  AgentRunStore.inMemory,
  WorkflowToolInvoker.none,
);

const userMessage: Message = {
  kind: 'message',
  messageId: 'message-1',
  role: 'user',
  parts: [{ kind: 'text', text: 'hello' }],
};
const requestContext = new RequestContext(userMessage, 'task-1', 'context-1');
const noopBus: ExecutionEventBus = {
  publish() {},
  on() {
    return this;
  },
  off() {
    return this;
  },
  once() {
    return this;
  },
  removeAllListeners() {
    return this;
  },
  finished() {},
};

const run: WorkflowRun = {
  id: Schema.decodeUnknownSync(WorkflowRunId)('wfr_lgtest'),
  workflowId: Schema.decodeUnknownSync(WorkflowId)('workflow-1'),
  taskId: requestContext.taskId,
  contextId: requestContext.contextId,
  status: 'submitted',
  input: 'hello',
  startedAt: '2026-06-05T00:00:00.000Z',
};

// An artifact that pauses on `interrupt()` and echoes the response, so a
// successful resume can only come from graph state that survived in the DB.
const REVIEW_ENTRYPOINT = `
  import { entrypoint, interrupt, task } from '@langchain/langgraph';
  const done = task('done', async (answer) => JSON.stringify(answer));
  export default entrypoint('review', async (input) => {
    const answer = interrupt({ title: 'Review' });
    return done(answer);
  });
`;

const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const writeArtifact = (prefix: string, entrypoint: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = yield* fs.makeTempDirectory({ directory: import.meta.dirname, prefix });
    yield* fs.writeFileString(
      path.join(folder, 'agentdock.workflow.json'),
      encodeJsonString({
        name: 'Review workflow',
        description: 'Review workflow',
        version: '0.1.0',
        graph: './workflow.mjs:default',
        input: { type: 'string' },
      }),
    );
    yield* fs.writeFileString(path.join(folder, 'package.json'), encodeJsonString({ name: 'review', type: 'module' }));
    yield* fs.writeFileString(path.join(folder, 'workflow.mjs'), entrypoint);
    return folder;
  }).pipe(Effect.orDie, Effect.provide(NodeServices.layer));

const removeFolder = (folder: string) =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    fs.remove(folder, { recursive: true, force: true }),
  ).pipe(Effect.orDie, Effect.provide(NodeServices.layer));

const artifactFolder = (prefix: string, entrypoint: string) =>
  Effect.acquireRelease(writeArtifact(prefix, entrypoint), removeFolder);

const reviewWorkflow: Effect.Effect<Workflow, never, Scope.Scope> = Effect.gen(function* () {
  const folder = yield* artifactFolder('.tmp-checkpointer-', REVIEW_ENTRYPOINT);
  const loaded = yield* Effect.orDie(loadWorkflowManifest(folder));
  const workflow: Workflow = {
    id: run.workflowId,
    source: loaded.folder,
    manifest: loaded.manifest,
    sourceHash: loaded.sourceHash,
    bindings: {},
    revision: 1,
  };
  return workflow;
});

/**
 * The executor hands work back through a Promise-shaped `run` callback; serving it from a
 * child fiber keeps those effects on the test's own fiber tree and services.
 */
const promiseRunner = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<Effect.Effect<void>>();
  yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(queue), (effect) => Effect.forkChild(effect))));
  return <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
    new Promise<A>((resolve, reject) => {
      Queue.offerUnsafe(
        queue,
        Effect.matchCause(effect, {
          onSuccess: resolve,
          onFailure: (cause) => reject(new Error(Cause.pretty(cause))),
        }),
      );
    });
});

const checkpointRows = (db: DatabaseClient) => Effect.promise(() => db.select().from(langgraphCheckpointsTable).all());

describe('DrizzleLibsqlCheckpointSaver', () => {
  it.live('round-trips a LangGraph checkpoint and its writes through the database', () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(makeTestDb);
      const saver = new DrizzleLibsqlCheckpointSaver(db);
      const threadId = 'thread-roundtrip';
      const baseConfig = { configurable: { thread_id: threadId, checkpoint_ns: '' } };

      const checkpoint = { ...emptyCheckpoint(), channel_values: { step: 'research', data: { input: 'hello' } } };
      const metadata: CheckpointMetadata = { source: 'loop', step: 1, parents: {} };
      const savedConfig = yield* Effect.promise(() => saver.put(baseConfig, checkpoint, metadata));
      yield* Effect.promise(() => saver.putWrites(savedConfig, [['data', { review: 'pending' }]], 'task-write'));

      // A fresh saver instance (simulating a process restart) reads from the same DB.
      const reopened = new DrizzleLibsqlCheckpointSaver(db);
      const tuple = yield* Effect.promise(() => reopened.getTuple({ configurable: { thread_id: threadId } }));
      expect(tuple?.checkpoint.channel_values.step).toBe('research');
      expect(tuple?.pendingWrites).toEqual([['task-write', 'data', { review: 'pending' }]]);

      // The checkpoint is a real DB row, not in-process state.
      const rows = yield* checkpointRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.threadId).toBe(threadId);

      yield* Effect.promise(() => saver.deleteThread(threadId));
      expect(yield* checkpointRows(db)).toHaveLength(0);
    }),
  );

  it.live('treats a non-string thread_id as no thread at all', () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(makeTestDb);
      const saver = new DrizzleLibsqlCheckpointSaver(db);
      const config = { configurable: { thread_id: 42 } };
      const metadata: CheckpointMetadata = { source: 'loop', step: 1, parents: {} };

      yield* Effect.promise(() =>
        expect(saver.put(config, emptyCheckpoint(), metadata)).rejects.toThrow('configurable.thread_id'),
      );
      expect(yield* Effect.promise(() => saver.getTuple(config))).toBeUndefined();
      expect(yield* checkpointRows(db)).toHaveLength(0);
    }),
  );

  it.live('pauses a workflow into the DB checkpoint and resumes it from a fresh saver (same taskId)', () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(makeTestDb);
      const workflow = yield* reviewWorkflow;
      // The run store is faked in-memory (covered elsewhere); the checkpointer is the
      // only real-DB piece, so a successful resume proves graph state persisted in the DB.
      const appended: Array<WorkflowRunEvent> = [];
      const pendingActions: Array<WorkflowPendingAction> = [];
      const storeLayer = Layer.succeed(
        WorkflowRunStore,
        WorkflowRunStore.of({
          create: () => Effect.succeed(run),
          getWaitingByTask: () => Effect.succeed({ ...run, status: 'input-required' }),
          append: (event) => Effect.sync(() => void appended.push(event)),
          appendEvent: (event) => Effect.sync(() => void appended.push(event)),
          createPendingAction: (action) => Effect.sync(() => void pendingActions.push(action)),
          resolvePendingAction: ({ actionId, response }) =>
            Effect.sync(() => {
              const action = pendingActions.find(
                (candidate) => candidate.id === actionId && candidate.status === 'pending',
              );
              if (!action) return null;
              const resolved = {
                ...action,
                status: 'resolved' as const,
                response,
                resolvedAt: '2026-06-05T00:00:01.000Z',
              };
              pendingActions[pendingActions.indexOf(action)] = resolved;
              return resolved;
            }),
          list: () => Effect.succeed([]),
          getSnapshot: () => Effect.succeed(null),
          listEvents: () => Effect.succeed(appended),
        }),
      );

      // Each execution gets its OWN saver instance over the SAME db (process-restart model).
      const runEffect = yield* promiseRunner;
      const execute = (context: RequestContext, dbForRun: DatabaseClient) => {
        const executor = new WorkflowTaskExecutor(workflow, [], {
          checkpointer: new DrizzleLibsqlCheckpointSaver(dbForRun),
          run: (effect) => runEffect(effect.pipe(Effect.provide(Layer.mergeAll(storeLayer, agentServicesLayer)))),
        });
        return Effect.promise(() => executor.execute(context, noopBus));
      };
      const pausedTask: Task = {
        kind: 'task',
        id: requestContext.taskId,
        contextId: requestContext.contextId,
        status: { state: 'input-required' },
      };
      const responseContext = (actionId: string, response: JsonObject): RequestContext =>
        new RequestContext(
          {
            ...userMessage,
            messageId: `message-${actionId}`,
            parts: [{ kind: 'data', data: { type: 'workflow-human-input-response', actionId, response } }],
          },
          requestContext.taskId,
          requestContext.contextId,
          pausedTask,
        );

      // 1) Start → graph interrupts at the human-input node and persists a checkpoint.
      yield* execute(requestContext, db);
      const action = pendingActions.at(-1);
      expect(action?.request).toMatchObject({ title: 'Review' });
      // The runtime threads a graph per a2a task, so that is the checkpoint key.
      const rows = yield* checkpointRows(db);
      expect(
        rows.some((row) => row.threadId === encodeJsonString([`workflow:${workflow.id}`, requestContext.taskId])),
      ).toBe(true);
      expect(appended.some((event) => event.type === 'run-completed')).toBe(false);

      // 2) Resume via a2a on the SAME taskId with a fresh saver → completes from DB state.
      yield* execute(responseContext(String(action?.id), { approved: true }), db);
      const completed = appended.findLast((event) => event.type === 'run-completed');
      expect(completed?.type === 'run-completed' ? completed.output : undefined).toBe('{"approved":true}');
    }),
  );
});
