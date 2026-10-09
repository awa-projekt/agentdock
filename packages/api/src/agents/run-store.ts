import { AgentRunStore, AgentRunStoreError } from 'agentdock-sdk';
import type { AgentRunOrigin } from 'agentdock-sdk/schemas';
import { AgentRunRecord } from 'agentdock-sdk/schemas';
import { agentRunsTable, causeMessage, Database, type DatabaseClient, tryDbWith } from 'db';
import { eq } from 'drizzle-orm';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';

const tryDb = tryDbWith(
  (cause) => new AgentRunStoreError({ message: `Agent run store failed: ${causeMessage(cause)}`, error: cause }),
);

const decodeRecord = Schema.decodeUnknownSync(AgentRunRecord);

type AgentRunRow = typeof agentRunsTable.$inferSelect;

/** Reassembles the flattened `origin_surface`/`workflow_*`/`attempt` columns into the `AgentRunOrigin` union. */
const originFromRow = (row: AgentRunRow): AgentRunOrigin => {
  if (row.originSurface === 'workflow' && row.workflowId && row.workflowRunId && row.stepId) {
    return {
      surface: 'workflow',
      workflowId: row.workflowId,
      workflowRunId: row.workflowRunId,
      stepId: row.stepId,
      attempt: row.attempt ?? 1,
    };
  }
  if (row.originSurface === 'delegation' && row.parentTaskId) {
    return { surface: 'delegation', parentTaskId: row.parentTaskId };
  }
  return {
    surface: row.originSurface === 'workflow' || row.originSurface === 'delegation' ? 'a2a' : row.originSurface,
  };
};

const rowToRecord = (row: AgentRunRow): AgentRunRecord =>
  decodeRecord({
    id: row.id,
    contextId: row.contextId,
    agentId: row.agentId,
    status: {
      state: row.statusState,
      timestamp: row.statusTimestamp,
      message: row.statusMessage ?? undefined,
    },
    statusHistory: row.statusHistory ?? undefined,
    history: row.history,
    artifacts: row.artifacts,
    origin: originFromRow(row),
    metadata: row.metadata ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const recordToRow = (record: AgentRunRecord): typeof agentRunsTable.$inferInsert => ({
  id: record.id,
  contextId: record.contextId,
  agentId: record.agentId,
  workflowId: record.origin.surface === 'workflow' ? record.origin.workflowId : null,
  workflowRunId: record.origin.surface === 'workflow' ? record.origin.workflowRunId : null,
  stepId: record.origin.surface === 'workflow' ? record.origin.stepId : null,
  originSurface: record.origin.surface,
  parentTaskId: record.origin.surface === 'delegation' ? record.origin.parentTaskId : null,
  attempt: record.origin.surface === 'workflow' ? record.origin.attempt : null,
  statusState: record.status.state,
  statusTimestamp: record.status.timestamp,
  statusMessage: record.status.message ?? null,
  statusHistory: record.statusHistory ?? null,
  history: record.history,
  artifacts: record.artifacts,
  metadata: record.metadata ?? null,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

/**
 * Drizzle-backed `AgentRunStore` — the general (protocol-independent) record
 * of every agent run, persisted across process restarts and across separate
 * a2a task turns (unlike the Phase B in-memory stopgap that was rebuilt per
 * `execute()` call).
 *
 * Takes `Database` from ambient context rather than self-providing
 * `DatabaseLive` (unlike most other DB-backed services in this package) so
 * tests can hand it a `makeTestDb()` instance directly; hosts get the real
 * one from `RuntimeHostLayer`'s composition in `packages/api/src/handlers.ts`
 * (or, when this layer is reached through `SessionsServiceLive`, from that
 * layer's own `Database` provision — Effect memoizes `DatabaseLive` by
 * reference, so both paths share one instance).
 */
export const AgentRunStoreLive = Layer.effect(
  AgentRunStore,
  Effect.gen(function* () {
    const db: DatabaseClient = (yield* Database).db;
    return AgentRunStore.of({
      save: Effect.fn('AgentRunStore.save')(function* (record) {
        const row = recordToRow(record);
        yield* tryDb(() =>
          db.insert(agentRunsTable).values(row).onConflictDoUpdate({ target: agentRunsTable.id, set: row }).run(),
        );
      }),
      get: Effect.fn('AgentRunStore.get')(function* (id) {
        const rows = yield* tryDb(() =>
          db.select().from(agentRunsTable).where(eq(agentRunsTable.id, id)).limit(1).all(),
        );
        return rows[0] ? rowToRecord(rows[0]) : null;
      }),
      listByContext: Effect.fn('AgentRunStore.listByContext')(function* (contextId) {
        const rows = yield* tryDb(() =>
          db
            .select()
            .from(agentRunsTable)
            .where(eq(agentRunsTable.contextId, contextId))
            .orderBy(agentRunsTable.createdAt)
            .all(),
        );
        return rows.map(rowToRecord);
      }),
      listByWorkflowRun: Effect.fn('AgentRunStore.listByWorkflowRun')(function* (workflowRunId) {
        const rows = yield* tryDb(() =>
          db
            .select()
            .from(agentRunsTable)
            .where(eq(agentRunsTable.workflowRunId, workflowRunId))
            .orderBy(agentRunsTable.createdAt)
            .all(),
        );
        return rows.map(rowToRecord);
      }),
      delete: Effect.fn('AgentRunStore.delete')(function* (id) {
        yield* tryDb(() => db.delete(agentRunsTable).where(eq(agentRunsTable.id, id)).run());
      }),
    });
  }),
);
