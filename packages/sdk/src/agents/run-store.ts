import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import type { AgentRunRecord } from '../schemas/agent-runs';

export class AgentRunStoreError extends Schema.TaggedError<AgentRunStoreError>()('AgentRunStoreError', {
  message: Schema.String,
  error: Schema.Defect(),
}) {}

/**
 * General (protocol-independent) store for every agent run — a2a-originated,
 * workflow-node-originated, or direct SDK calls. The a2a `TaskStore` is an
 * adapter over this store at the boundary (`a2a/run-record.ts` holds the
 * transforms); this store is what makes every internal workflow agent call
 * individually inspectable.
 */
export class AgentRunStore extends Context.Service<
  AgentRunStore,
  {
    readonly save: (record: AgentRunRecord) => Effect.Effect<void, AgentRunStoreError>;
    readonly get: (id: string) => Effect.Effect<AgentRunRecord | null, AgentRunStoreError>;
    readonly listByContext: (contextId: string) => Effect.Effect<ReadonlyArray<AgentRunRecord>, AgentRunStoreError>;
    readonly listByWorkflowRun: (
      workflowRunId: string,
    ) => Effect.Effect<ReadonlyArray<AgentRunRecord>, AgentRunStoreError>;
    /** Deletes a single record by id — used by session deletion to clean up its runs. */
    readonly delete: (id: string) => Effect.Effect<void, AgentRunStoreError>;
  }
>()('agentdock-sdk/agents/run-store/AgentRunStore') {
  static readonly inMemory: Layer.Layer<AgentRunStore> = Layer.sync(AgentRunStore, () => {
    const records = new Map<string, AgentRunRecord>();

    const sortedByCreatedAt = (list: ReadonlyArray<AgentRunRecord>): ReadonlyArray<AgentRunRecord> =>
      [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return {
      save: (record) => Effect.sync(() => void records.set(record.id, record)),
      get: (id) => Effect.sync(() => records.get(id) ?? null),
      listByContext: (contextId) =>
        Effect.sync(() => sortedByCreatedAt([...records.values()].filter((record) => record.contextId === contextId))),
      listByWorkflowRun: (workflowRunId) =>
        Effect.sync(() =>
          sortedByCreatedAt(
            [...records.values()].filter(
              (record) => record.origin.surface === 'workflow' && record.origin.workflowRunId === workflowRunId,
            ),
          ),
        ),
      delete: (id) => Effect.sync(() => void records.delete(id)),
    };
  });
}
