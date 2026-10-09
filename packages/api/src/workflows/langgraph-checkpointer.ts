import type { LangGraphRunnableConfig as RunnableConfig } from '@langchain/langgraph';
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  copyCheckpoint,
  getCheckpointId,
  type PendingWrite,
  WRITES_IDX_MAP,
} from '@langchain/langgraph-checkpoint';
import { coerceJsonObject, type Json } from 'agentdock-sdk/schemas';
import {
  type DatabaseClient,
  graphExecutionsTable,
  langgraphCheckpointsTable,
  langgraphCheckpointWritesTable,
} from 'db';
import { and, desc, eq, gt, lt, type SQL } from 'drizzle-orm';
import * as Clock from 'effect/Clock';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

export type ExecutionLease = { readonly executionId: string; readonly owner: string };
type Transaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

/** The shape LangGraph's serializer produces, as stored in the JSON columns. */
const SerializedPayload = Schema.Struct({ type: Schema.String, data: Schema.String });
type SerializedPayload = Schema.Schema.Type<typeof SerializedPayload>;
const decodeSerializedPayload = Schema.decodeUnknownSync(SerializedPayload);

/**
 * The three identity keys LangGraph threads through `config.configurable`.
 * Everything else in there is graph-internal, so it is dropped rather than
 * carried inward as an untyped bag.
 */
const CheckpointConfigurable = Schema.Struct({
  thread_id: Schema.optional(Schema.String),
  checkpoint_ns: Schema.optional(Schema.String),
  checkpoint_id: Schema.optional(Schema.String),
});
type CheckpointConfigurable = Schema.Schema.Type<typeof CheckpointConfigurable>;
const decodeCheckpointConfigurable = Schema.decodeUnknownOption(CheckpointConfigurable);

const checkpointConfigurable = (config: RunnableConfig | undefined): CheckpointConfigurable => {
  const configurable = config?.configurable;
  const decoded = decodeCheckpointConfigurable({
    thread_id: configurable?.thread_id,
    checkpoint_ns: configurable?.checkpoint_ns,
    checkpoint_id: configurable?.checkpoint_id,
  });
  return Option.getOrElse(decoded, (): CheckpointConfigurable => ({}));
};

const encode = async <A>(saver: BaseCheckpointSaver, value: A): Promise<SerializedPayload> => {
  const [type, data] = await saver.serde.dumpsTyped(value);
  return { type, data: Buffer.from(data).toString('base64') };
};

const decode = async <A>(saver: BaseCheckpointSaver, value: Json): Promise<A> => {
  const serialized = decodeSerializedPayload(value);
  return await saver.serde.loadsTyped(serialized.type, Buffer.from(serialized.data, 'base64'));
};

const checkpointConfig = (threadId: string, checkpointNs: string, checkpointId: string): RunnableConfig => ({
  configurable: {
    thread_id: threadId,
    checkpoint_ns: checkpointNs,
    checkpoint_id: checkpointId,
  },
});

export class DrizzleLibsqlCheckpointSaver extends BaseCheckpointSaver {
  constructor(
    private readonly db: DatabaseClient,
    private readonly lease?: ExecutionLease,
  ) {
    super();
  }

  private async assertLease(tx: Transaction): Promise<void> {
    if (!this.lease) return;
    const [execution] = await tx
      .select({ id: graphExecutionsTable.id })
      .from(graphExecutionsTable)
      .where(
        and(
          eq(graphExecutionsTable.id, this.lease.executionId),
          eq(graphExecutionsTable.owner, this.lease.owner),
          gt(graphExecutionsTable.leaseUntil, Effect.runSync(Clock.currentTimeMillis)),
        ),
      )
      .limit(1);
    if (!execution) throw new Error('Graph execution lease lost before checkpoint write.');
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const configurable = checkpointConfigurable(config);
    const threadId = configurable.thread_id;
    if (threadId === undefined) {
      return undefined;
    }

    const checkpointNs = configurable.checkpoint_ns ?? '';
    const checkpointId = getCheckpointId(config);
    const checkpoints = langgraphCheckpointsTable;
    const writes = langgraphCheckpointWritesTable;
    const rows = await this.db
      .select()
      .from(checkpoints)
      .where(
        checkpointId
          ? and(
              eq(checkpoints.threadId, threadId),
              eq(checkpoints.checkpointNs, checkpointNs),
              eq(checkpoints.checkpointId, checkpointId),
            )
          : and(eq(checkpoints.threadId, threadId), eq(checkpoints.checkpointNs, checkpointNs)),
      )
      .orderBy(desc(checkpoints.checkpointId))
      .limit(1)
      .all();
    const row = rows[0];
    if (!row) {
      return undefined;
    }

    const writeRows = await this.db
      .select()
      .from(writes)
      .where(
        and(
          eq(writes.threadId, row.threadId),
          eq(writes.checkpointNs, row.checkpointNs),
          eq(writes.checkpointId, row.checkpointId),
        ),
      )
      .orderBy(writes.taskId, writes.idx)
      .all();

    const pendingWrites = await Promise.all(
      writeRows.map(
        async (write) =>
          [write.taskId, write.channel, await decode(this, write.value)] satisfies [string, string, unknown],
      ),
    );

    const tuple: CheckpointTuple = {
      config: checkpointConfig(row.threadId, row.checkpointNs, row.checkpointId),
      checkpoint: await decode<Checkpoint>(this, row.checkpoint),
      metadata: await decode<CheckpointMetadata>(this, row.metadata),
      pendingWrites,
    };
    return row.parentCheckpointId
      ? { ...tuple, parentConfig: checkpointConfig(row.threadId, row.checkpointNs, row.parentCheckpointId) }
      : tuple;
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const configurable = checkpointConfigurable(config);
    const before = checkpointConfigurable(options?.before);
    const checkpoints = langgraphCheckpointsTable;

    const filters: Array<SQL> = [];
    if (configurable.thread_id !== undefined) filters.push(eq(checkpoints.threadId, configurable.thread_id));
    if (configurable.checkpoint_ns !== undefined) {
      filters.push(eq(checkpoints.checkpointNs, configurable.checkpoint_ns));
    }
    if (before.checkpoint_id !== undefined) filters.push(lt(checkpoints.checkpointId, before.checkpoint_id));

    const rows = await this.db
      .select()
      .from(checkpoints)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(checkpoints.checkpointId))
      .limit(options?.limit ?? 1_000)
      .all();
    for (const row of rows) {
      const tuple = await this.getTuple(checkpointConfig(row.threadId, row.checkpointNs, row.checkpointId));
      if (!tuple) {
        continue;
      }
      const metadata = coerceJsonObject(tuple.metadata);
      if (options?.filter && !Object.entries(options.filter).every(([key, value]) => metadata[key] === value)) {
        continue;
      }
      yield tuple;
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const configurable = checkpointConfigurable(config);
    const threadId = configurable.thread_id;
    if (threadId === undefined) {
      throw new Error('LangGraph checkpoint writes require configurable.thread_id.');
    }

    const checkpointNs = configurable.checkpoint_ns ?? '';
    const parentCheckpointId = configurable.checkpoint_id ?? null;
    const nextConfig = checkpointConfig(threadId, checkpointNs, checkpoint.id);
    const serializedCheckpoint = await encode(this, copyCheckpoint(checkpoint));
    const serializedMetadata = await encode(this, { ...metadata, request_id: config.metadata?.request_id });
    const checkpoints = langgraphCheckpointsTable;
    await this.db.transaction(async (tx) => {
      await this.assertLease(tx);
      await tx
        .insert(checkpoints)
        .values({
          threadId,
          checkpointNs,
          checkpointId: checkpoint.id,
          parentCheckpointId,
          checkpoint: serializedCheckpoint,
          metadata: serializedMetadata,
          createdAt: checkpoint.ts,
        })
        .onConflictDoUpdate({
          target: [checkpoints.threadId, checkpoints.checkpointNs, checkpoints.checkpointId],
          set: {
            checkpoint: serializedCheckpoint,
            metadata: serializedMetadata,
            parentCheckpointId,
            createdAt: checkpoint.ts,
          },
        })
        .run();
    });
    return nextConfig;
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const configurable = checkpointConfigurable(config);
    const threadId = configurable.thread_id;
    const checkpointId = configurable.checkpoint_id;
    if (threadId === undefined) {
      throw new Error('LangGraph checkpoint writes require configurable.thread_id.');
    }
    if (checkpointId === undefined) {
      throw new Error('LangGraph checkpoint writes require configurable.checkpoint_id.');
    }

    const checkpointNs = configurable.checkpoint_ns ?? '';
    const createdAt = DateTime.formatIso(Effect.runSync(DateTime.now));
    await this.db.transaction(async (tx) => {
      await this.assertLease(tx);
      for (const [idx, [channel, value]] of writes.entries()) {
        const writeIdx = WRITES_IDX_MAP[channel] ?? idx;
        const row = {
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          idx: writeIdx,
          channel,
          value: await encode(this, value),
          createdAt,
        };
        if (writeIdx >= 0) {
          await tx.insert(langgraphCheckpointWritesTable).values(row).onConflictDoNothing().run();
        } else {
          const writes = langgraphCheckpointWritesTable;
          await tx
            .insert(writes)
            .values(row)
            .onConflictDoUpdate({
              target: [writes.threadId, writes.checkpointNs, writes.checkpointId, writes.taskId, writes.idx],
              set: { channel, value: row.value, createdAt },
            })
            .run();
        }
      }
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.db
      .delete(langgraphCheckpointWritesTable)
      .where(eq(langgraphCheckpointWritesTable.threadId, threadId))
      .run();
    await this.db.delete(langgraphCheckpointsTable).where(eq(langgraphCheckpointsTable.threadId, threadId)).run();
  }
}
