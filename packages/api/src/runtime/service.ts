import type { Message, Task } from '@a2a-js/sdk';
import {
  type AgentExecutionEvent,
  type AgentExecutor,
  DefaultExecutionEventBus,
  type ExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server';
import {
  applyGraphEvent,
  type GraphDeployment,
  type GraphExecution,
  type GraphExecutionEvent,
  graphTarget,
  graphThreadId,
  randomUUIDv4,
} from 'agentdock-sdk';
import { Database, graphExecutionEventsTable as events, graphExecutionsTable as executions } from 'db';
import { and, asc, eq, gt, inArray, lt, ne } from 'drizzle-orm';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';

export type GraphExecutorFactory = (
  deployment: GraphDeployment,
  recover: boolean,
  lease: import('../workflows/langgraph-checkpointer').ExecutionLease,
) => Promise<AgentExecutor>;

import { runtimeFingerprint } from '../workflows/deploy';

const LEASE_MS = 30_000;
const runnable = ['submitted', 'working'] as const;
const isRunnable = (status: GraphExecution['status']) => status === 'submitted' || status === 'working';
type ProjectTask = (deployment: GraphDeployment, task: Task) => Promise<void>;

/** Durable A2A execution host. AG-UI invokes the protocol-neutral runners directly. */
export const GraphRuntime = Context.Service<{
  readonly register: (kind: GraphDeployment['kind'], factory: GraphExecutorFactory, project: ProjectTask) => void;
  readonly start: (deployment: GraphDeployment, request: RequestContext, bus: ExecutionEventBus) => Promise<void>;
  readonly resume: (target: string, taskId: string, message: Message, bus: ExecutionEventBus) => Promise<void>;
  readonly cancel: (target: string, taskId: string, bus: ExecutionEventBus) => Promise<void>;
  readonly listEvents: (target: string, taskId: string, after?: number) => Promise<ReadonlyArray<GraphExecutionEvent>>;
  readonly waiting: (target: string, contextId: string) => Promise<GraphExecution | null>;
  readonly executor: (deployment: GraphDeployment) => AgentExecutor;
  readonly inspect: (target: string, taskId: string) => Promise<GraphExecution | null>;
  readonly recover: () => Promise<void>;
}>('@agentdock/api/GraphRuntime');

export const GraphRuntimeLive = Layer.effect(
  GraphRuntime,
  Effect.gen(function* () {
    const { db } = yield* Database;
    const services = yield* Effect.context<never>();
    // Lease arithmetic runs inside Promise-shaped a2a host callbacks, so the
    // Clock's synchronous accessor is how it stays on `TestClock`.
    const clock = yield* Effect.clockWith(Effect.succeed);
    const nowMs = (): number => clock.currentTimeMillisUnsafe();
    const newId = (): string => Effect.runSyncWith(services)(randomUUIDv4);
    const fingerprint = yield* Effect.orDie(runtimeFingerprint);
    const factories = new Map<GraphDeployment['kind'], GraphExecutorFactory>();
    const recovering = new Set<string>();
    const projections = new Map<GraphDeployment['kind'], ProjectTask>();
    const active = new Map<string, { executor: AgentExecutor; bus: ExecutionEventBus }>();
    const inspect = async (target: string, taskId: string) => {
      const [row] = await db
        .select()
        .from(executions)
        .where(and(eq(executions.id, taskId), eq(executions.target, target)))
        .limit(1);
      return row ?? null;
    };
    const listEvents = async (target: string, taskId: string, after = 0) => {
      if (!(await inspect(target, taskId))) return [];
      return db
        .select({ sequence: events.sequence, requestId: events.requestId, event: events.event })
        .from(events)
        .where(and(eq(events.executionId, taskId), gt(events.sequence, after)))
        .orderBy(asc(events.sequence));
    };
    const publishStored = async (id: string, target: string, bus: ExecutionEventBus) => {
      let sequence = 0;
      const requestId = (await inspect(target, id))?.message.messageId;
      while (true) {
        const rows = await listEvents(target, id, sequence);
        for (const row of rows) {
          if (row.requestId === requestId) bus.publish(row.event);
          sequence = row.sequence;
        }
        const row = await inspect(target, id);
        if (!row || (!isRunnable(row.status) && row.owner === null)) break;
        await Effect.runPromiseWith(services)(Effect.sleep(Duration.millis(100)));
      }
      bus.finished();
    };
    const drive = async (execution: GraphExecution, bus: ExecutionEventBus, recover: boolean): Promise<void> => {
      const factory = factories.get(execution.deployment.kind);
      if (!factory) throw new Error(`No graph executor for ${execution.deployment.kind}`);
      if (execution.runtimeHash !== fingerprint)
        throw new Error('This execution requires its original runtime build. Restore that build to resume.');
      const owner = newId();
      const acquired = await db.transaction(async (tx) => {
        const [busy] = await tx
          .select()
          .from(executions)
          .where(
            and(
              eq(executions.threadId, execution.threadId),
              ne(executions.id, execution.id),
              gt(executions.leaseUntil, nowMs()),
            ),
          )
          .limit(1);
        if (busy) return false;
        const claimed = await tx
          .update(executions)
          .set({ owner, leaseUntil: nowMs() + LEASE_MS, status: 'working' })
          .where(
            and(
              eq(executions.id, execution.id),
              lt(executions.leaseUntil, nowMs()),
              inArray(executions.status, [...runnable]),
            ),
          )
          .returning();
        return claimed.length === 1;
      });
      if (!acquired) {
        const current = await inspect(execution.target, execution.id);
        if (current && (current.owner !== null || !isRunnable(current.status)))
          return publishStored(execution.id, execution.target, bus);
        throw new Error('This graph thread is already executing.');
      }
      let delegate: AgentExecutor | undefined;
      let queue = Promise.resolve();
      let lost = false;
      const wrapped = new DefaultExecutionEventBus();
      const append = async (event: AgentExecutionEvent) => {
        const saved = await db.transaction(async (tx) => {
          const [lease] = await tx
            .select()
            .from(executions)
            .where(
              and(eq(executions.id, execution.id), eq(executions.owner, owner), gt(executions.leaseUntil, nowMs())),
            )
            .limit(1);
          if (!lease) return false;
          const task = applyGraphEvent(lease, event);
          await tx.update(executions).set({ task }).where(eq(executions.id, execution.id));
          await tx.insert(events).values({ executionId: execution.id, requestId: execution.message.messageId, event });
          if (event.kind === 'status-update') {
            const state = event.status.state;
            if (state !== 'unknown' && state !== 'auth-required')
              await tx.update(executions).set({ status: state }).where(eq(executions.id, execution.id));
          }
          return task;
        });
        if (!saved) throw new Error('Graph execution lease lost.');
        await projections.get(execution.deployment.kind)?.(execution.deployment, saved);
        bus.publish(event);
      };
      wrapped.on('event', (event) => {
        queue = queue.then(() => append(event));
        void queue.catch(() => {});
      });
      const heartbeatTick = Effect.tryPromise(async () => {
        const [row] = await db
          .update(executions)
          .set({ leaseUntil: nowMs() + LEASE_MS })
          .where(and(eq(executions.id, execution.id), eq(executions.owner, owner)))
          .returning();
        if (!row || row.cancelRequested) {
          lost = !row;
          await delegate?.cancelTask(execution.id, wrapped);
        }
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            lost = true;
            void delegate?.cancelTask(execution.id, wrapped);
          }),
        ),
      );
      const heartbeat = Effect.runForkWith(services)(
        Effect.forever(Effect.andThen(Effect.sleep(Duration.millis(LEASE_MS / 3)), heartbeatTick)),
      );
      try {
        delegate = await factory(execution.deployment, recover, { executionId: execution.id, owner });
        active.set(execution.id, { executor: delegate, bus: wrapped });
        if (execution.cancelRequested) {
          await append({
            kind: 'status-update',
            taskId: execution.id,
            contextId: execution.contextId,
            final: true,
            status: { state: 'canceled' },
          });
        } else {
          await delegate.execute(
            new RequestContext(execution.message, execution.id, execution.contextId, execution.task ?? undefined),
            wrapped,
          );
        }
        await queue;
        if (lost) throw new Error('Graph execution lease lost.');
      } catch (error) {
        await queue.catch(() => {});
        if (!lost)
          await append({
            kind: 'status-update',
            taskId: execution.id,
            contextId: execution.contextId,
            final: true,
            status: {
              state: 'failed',
              message: {
                kind: 'message',
                role: 'agent',
                messageId: newId(),
                parts: [{ kind: 'text', text: error instanceof Error ? error.message : String(error) }],
              },
            },
          });
      } finally {
        await Effect.runPromiseWith(services)(Fiber.interrupt(heartbeat));
        active.delete(execution.id);
        await db
          .update(executions)
          .set({ owner: null, leaseUntil: 0 })
          .where(and(eq(executions.id, execution.id), eq(executions.owner, owner)));
        bus.finished();
      }
    };
    const executor = (deployment: GraphDeployment): AgentExecutor => {
      const target = graphTarget(deployment);
      return {
        execute: async (request, bus) => {
          const existing = await inspect(target, request.taskId);
          if (existing && existing.contextId !== request.contextId) throw new Error('Task belongs to another thread.');
          if (existing && existing.message.messageId === request.userMessage.messageId && !isRunnable(existing.status))
            return publishStored(existing.id, target, bus);
          if (existing && existing.message.messageId === request.userMessage.messageId && existing.leaseUntil > nowMs())
            return publishStored(existing.id, target, bus);
          if (
            existing &&
            existing.status !== 'input-required' &&
            existing.message.messageId !== request.userMessage.messageId
          )
            throw new Error('Only a waiting task can be resumed. Start a new task for a new turn.');
          if (existing && existing.runtimeHash !== fingerprint)
            throw new Error('This execution requires its original runtime build.');
          if (existing?.status === 'input-required') {
            await db
              .update(executions)
              .set({
                message: request.userMessage,
                task: existing.task
                  ? { ...existing.task, history: [...(existing.task.history ?? []), request.userMessage] }
                  : null,
                status: 'submitted',
              })
              .where(and(eq(executions.id, existing.id), eq(executions.status, 'input-required')));
          } else if (!existing) {
            const threadId = graphThreadId(target, deployment.kind === 'agent' ? request.contextId : request.taskId);
            await db.transaction(async (tx) => {
              const [pending] = await tx
                .select()
                .from(executions)
                .where(
                  and(
                    eq(executions.threadId, threadId),
                    ne(executions.id, request.taskId),
                    inArray(executions.status, ['submitted', 'working', 'input-required']),
                  ),
                )
                .limit(1);
              if (pending)
                throw new Error('Finish or resume the existing task before starting another turn on this thread.');
              await tx
                .insert(executions)
                .values({
                  id: request.taskId,
                  runtimeHash: fingerprint,
                  target,
                  threadId,
                  contextId: request.contextId,
                  deployment,
                  message: request.userMessage,
                  task: request.task ?? null,
                  status: 'submitted',
                })
                .onConflictDoNothing();
            });
          }
          const row = await inspect(target, request.taskId);
          if (!row) throw new Error('Task ID belongs to another graph.');
          if (row.message.messageId !== request.userMessage.messageId)
            throw new Error('Another request already resumed this task.');
          await drive(row, bus, Boolean(existing && isRunnable(existing.status)));
        },
        cancelTask: async (taskId, bus) => {
          if (!(await inspect(target, taskId))) throw new Error('Graph execution not found.');
          await db
            .update(executions)
            .set({ cancelRequested: true })
            .where(
              and(
                eq(executions.id, taskId),
                eq(executions.target, target),
                inArray(executions.status, ['submitted', 'working', 'input-required']),
              ),
            );
          const running = active.get(taskId);
          if (running) await running.executor.cancelTask(taskId, running.bus);
          const row = await inspect(target, taskId);
          if (row && row.leaseUntil === 0 && row.cancelRequested) {
            const event: AgentExecutionEvent = {
              kind: 'status-update',
              taskId,
              contextId: row.contextId,
              final: true,
              status: { state: 'canceled' },
            };
            const task = applyGraphEvent(row, event);
            await db.transaction(async (tx) => {
              await tx.update(executions).set({ status: 'canceled', task }).where(eq(executions.id, taskId));
              await tx.insert(events).values({ executionId: taskId, requestId: row.message.messageId, event });
            });
            await projections.get(row.deployment.kind)?.(row.deployment, task);
            bus.publish(event);
            bus.finished();
          } else if (row) {
            await publishStored(taskId, target, bus);
          } else {
            bus.finished();
          }
        },
      };
    };
    return GraphRuntime.of({
      register: (kind, factory, project) => {
        factories.set(kind, factory);
        projections.set(kind, project);
      },
      executor,
      inspect,
      listEvents,
      start: (deployment, request, bus) => executor(deployment).execute(request, bus),
      resume: async (target, taskId, message, bus) => {
        const execution = await inspect(target, taskId);
        if (!execution) throw new Error('Graph execution not found.');
        await executor(execution.deployment).execute(
          new RequestContext(message, taskId, execution.contextId, execution.task ?? undefined),
          bus,
        );
      },
      cancel: async (target, taskId, bus) => {
        const execution = await inspect(target, taskId);
        if (!execution) throw new Error('Graph execution not found.');
        await executor(execution.deployment).cancelTask(taskId, bus);
      },
      waiting: async (target, contextId) => {
        const [row] = await db
          .select()
          .from(executions)
          .where(
            and(
              eq(executions.target, target),
              eq(executions.contextId, contextId),
              eq(executions.status, 'input-required'),
            ),
          )
          .limit(1);
        return row ?? null;
      },
      recover: async () => {
        const rows = await db
          .select()
          .from(executions)
          .where(and(inArray(executions.status, [...runnable]), lt(executions.leaseUntil, nowMs())));
        await Promise.all(
          rows
            .filter((row) => factories.has(row.deployment.kind))
            .map(async (row) => {
              if (active.has(row.id) || recovering.has(row.id) || row.runtimeHash !== fingerprint) return;
              recovering.add(row.id);
              void drive(row, new DefaultExecutionEventBus(), true)
                .catch((error) => Effect.runSyncWith(services)(Effect.logWarning(String(error))))
                .finally(() => recovering.delete(row.id));
            }),
        );
      },
    });
  }),
);
