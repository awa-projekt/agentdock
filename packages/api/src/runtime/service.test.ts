import { type AgentExecutionEvent, DefaultExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { describe, expect, it } from '@effect/vitest';
import { Annotation, Command, interrupt, StateGraph } from '@langchain/langgraph';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { type GraphDeployment, graphThreadId } from 'agentdock-sdk';
import { WorkflowId } from 'agentdock-sdk/schemas';
import { Database, graphExecutionsTable } from 'db';
import { eq } from 'drizzle-orm';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { DrizzleLibsqlCheckpointSaver } from '../workflows/langgraph-checkpointer';
import { makeTestDb } from '../workflows/test-db';
import { GraphRuntime, GraphRuntimeLive } from './service';

const deployment: Extract<GraphDeployment, { readonly kind: 'workflow' }> = {
  kind: 'workflow',
  workflow: {
    id: WorkflowId.make('test'),
    source: '/test',
    sourceHash: 'original',
    manifest: { name: 'Test', description: 'Test', version: '1' },
    bindings: {},
    revision: 1,
  },
  agents: [],
  externalAgents: [],
  workflows: [],
  tools: [],
};
const request = (taskId: string, messageId = 'input', response?: string) =>
  new RequestContext(
    { kind: 'message', role: 'user', messageId, parts: [{ kind: 'text', text: response ?? 'hello' }] },
    taskId,
    'conversation',
  );
const runtimeFor = (db: Awaited<ReturnType<typeof makeTestDb>>) =>
  Effect.gen(function* () {
    return yield* GraphRuntime;
  }).pipe(Effect.provide(GraphRuntimeLive.pipe(Layer.provide(Layer.succeed(Database, { db, client: db.$client })))));

const configure = (
  runtime: Effect.Success<ReturnType<typeof runtimeFor>>,
  db: Awaited<ReturnType<typeof makeTestDb>>,
  effects: Array<string>,
  pause: boolean,
) => {
  runtime.register(
    'workflow',
    async (_snapshot, recover) => ({
      execute: async (ctx, bus) => {
        const State = Annotation.Root({ value: Annotation<string>() });
        const graph = new StateGraph(State)
          .addNode('first', () => {
            effects.push('first');
            return { value: 'saved' };
          })
          .addNode('second', () => ({ value: pause ? interrupt('approve') : 'finished' }))
          .addEdge('__start__', 'first')
          .addEdge('first', 'second')
          .addEdge('second', '__end__')
          .compile({ checkpointer: new DrizzleLibsqlCheckpointSaver(db) });
        const config = {
          configurable: { thread_id: graphThreadId('workflow:test', ctx.taskId) },
          durability: 'sync' as const,
        };
        const state = await graph.invoke(
          recover
            ? null
            : ctx.userMessage.messageId === 'resume'
              ? new Command({ resume: 'approved' })
              : { value: 'start' },
          config,
        );
        const waiting = (await graph.getState(config)).tasks.some((task) => task.interrupts?.length);
        bus.publish({
          kind: 'status-update',
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          final: true,
          status: {
            state: waiting ? 'input-required' : 'completed',
            message: {
              kind: 'message',
              role: 'agent',
              messageId: 'output',
              parts: [{ kind: 'text', text: state.value }],
            },
          },
        });
        bus.finished();
      },
      cancelTask: async () => {},
    }),
    async () => {},
  );
};

describe('GraphRuntime with durable LangGraph checkpoints', () => {
  it.live('persists events and deduplicates completed requests across runtime instances', () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(makeTestDb);
      const effects: string[] = [];
      const first = yield* runtimeFor(db);
      configure(first, db, effects, false);
      yield* Effect.promise(() => first.executor(deployment).execute(request('task'), new DefaultExecutionEventBus()));
      const second = yield* runtimeFor(db);
      configure(second, db, effects, false);
      const replay: AgentExecutionEvent[] = [];
      const bus = new DefaultExecutionEventBus().on('event', (event) => replay.push(event));
      yield* Effect.promise(() => second.executor(deployment).execute(request('task'), bus));
      expect(effects).toEqual(['first']);
      expect(replay.at(-1)).toMatchObject({ status: { state: 'completed' } });
      expect(yield* Effect.promise(() => second.inspect('workflow:test', 'task'))).toMatchObject({
        status: 'completed',
        owner: null,
      });
      yield* Effect.promise(() =>
        expect(
          second.executor(deployment).execute(new RequestContext(request('task').userMessage, 'task', 'other'), bus),
        ).rejects.toThrow('another thread'),
      );
    }),
  );

  it.live('resumes a nested checkpoint after restart using the original deployment', () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(makeTestDb);
      const effects: string[] = [];
      const first = yield* runtimeFor(db);
      configure(first, db, effects, true);
      yield* Effect.promise(() => first.executor(deployment).execute(request('task'), new DefaultExecutionEventBus()));
      expect((yield* Effect.promise(() => first.inspect('workflow:test', 'task')))?.status).toBe('input-required');
      const second = yield* runtimeFor(db);
      configure(second, db, effects, true);
      yield* Effect.promise(() =>
        second
          .executor({ ...deployment, workflow: { ...deployment.workflow, sourceHash: 'changed' } })
          .execute(request('task', 'resume', 'approve'), new DefaultExecutionEventBus()),
      );
      const replay: AgentExecutionEvent[] = [];
      yield* Effect.promise(() =>
        second.resume(
          'workflow:test',
          'task',
          request('task', 'resume', 'approve').userMessage,
          new DefaultExecutionEventBus().on('event', (event) => replay.push(event)),
        ),
      );
      expect(replay.filter((event) => event.kind === 'status-update').map((event) => event.status.state)).toEqual([
        'completed',
      ]);
      expect(effects).toEqual(['first']);
      expect(yield* Effect.promise(() => second.inspect('workflow:test', 'task'))).toMatchObject({
        status: 'completed',
        deployment: { workflow: { sourceHash: 'original' } },
      });
    }),
  );

  it.live('recovers an expired execution without rerunning a completed graph', () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(makeTestDb);
      const effects: string[] = [];
      const first = yield* runtimeFor(db);
      configure(first, db, effects, false);
      yield* Effect.promise(() => first.executor(deployment).execute(request('task'), new DefaultExecutionEventBus()));
      yield* Effect.promise(() =>
        db
          .update(graphExecutionsTable)
          .set({ status: 'working', owner: 'dead-worker', leaseUntil: 1 })
          .where(eq(graphExecutionsTable.id, 'task')),
      );
      const second = yield* runtimeFor(db);
      configure(second, db, effects, false);
      yield* Effect.promise(() => second.recover());
      expect(effects).toEqual(['first']);
      yield* Effect.promise(() =>
        expect.poll(async () => (await second.inspect('workflow:test', 'task'))?.status).toBe('completed'),
      );
    }),
  );

  it.live('fences checkpoint writes from an expired worker after another worker claims the execution', () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(makeTestDb);
      const runtime = yield* runtimeFor(db);
      configure(runtime, db, [], false);
      yield* Effect.promise(() => runtime.start(deployment, request('task'), new DefaultExecutionEventBus()));
      const leaseUntil = (yield* Clock.currentTimeMillis) + 30000;
      yield* Effect.promise(() =>
        db
          .update(graphExecutionsTable)
          .set({ owner: 'new-worker', leaseUntil })
          .where(eq(graphExecutionsTable.id, 'task')),
      );
      const stale = new DrizzleLibsqlCheckpointSaver(db, { executionId: 'task', owner: 'old-worker' });
      const config = { configurable: { thread_id: graphThreadId('workflow:test', 'task') } };
      yield* Effect.promise(() =>
        expect(stale.put(config, emptyCheckpoint(), { source: 'loop', step: 0, parents: {} })).rejects.toThrow(
          'lease lost',
        ),
      );
      yield* Effect.promise(() =>
        expect(
          stale.putWrites(
            { configurable: { ...config.configurable, checkpoint_id: 'stale' } },
            [['value', 'bad']],
            'node',
          ),
        ).rejects.toThrow('lease lost'),
      );
    }),
  );

  it.live('persists cancellation of a paused task and exposes it to a fresh protocol consumer', () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(makeTestDb);
      const runtime = yield* runtimeFor(db);
      configure(runtime, db, [], true);
      yield* Effect.promise(() => runtime.start(deployment, request('task'), new DefaultExecutionEventBus()));
      const other = { ...deployment, workflow: { ...deployment.workflow, id: WorkflowId.make('other') } };
      yield* Effect.promise(() =>
        expect(runtime.executor(other).cancelTask('task', new DefaultExecutionEventBus())).rejects.toThrow('not found'),
      );
      expect((yield* Effect.promise(() => runtime.inspect('workflow:test', 'task')))?.status).toBe('input-required');
      const events: AgentExecutionEvent[] = [];
      yield* Effect.promise(() =>
        runtime.cancel(
          'workflow:test',
          'task',
          new DefaultExecutionEventBus().on('event', (event) => events.push(event)),
        ),
      );
      expect(events.at(-1)).toMatchObject({ status: { state: 'canceled' } });
      const restarted = yield* runtimeFor(db);
      expect(yield* Effect.promise(() => restarted.inspect('workflow:test', 'task'))).toMatchObject({
        status: 'canceled',
        task: { status: { state: 'canceled' } },
      });
      expect((yield* Effect.promise(() => restarted.listEvents('workflow:test', 'task'))).at(-1)?.event).toMatchObject({
        status: { state: 'canceled' },
      });
    }),
  );
});
