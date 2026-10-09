import { randomUUIDv4 } from 'agentdock-sdk';
import { type Lock, type QueueEntry, reviver, type StateAdapter } from 'chat';
import {
  channelStateEntriesTable,
  channelStateListItemsTable,
  channelStateLocksTable,
  channelStateQueueItemsTable,
  channelStateSubscriptionsTable,
  type DatabaseClient,
} from 'db';
import { and, asc, count, eq, gt, isNotNull, lte, or } from 'drizzle-orm';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';

const nowMillis = (): number => Effect.runSync(Clock.currentTimeMillis);

/**
 * Chat SDK state backed by the platform database. One instance per channel
 * account; `scope` keeps accounts from seeing each other's threads and locks.
 */
export class DrizzleChannelStateAdapter implements StateAdapter {
  constructor(
    private readonly db: DatabaseClient,
    private readonly scope: string,
  ) {}

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async subscribe(threadId: string): Promise<void> {
    await this.db
      .insert(channelStateSubscriptionsTable)
      .values({ scope: this.scope, threadId, createdAt: nowMillis() })
      .onConflictDoNothing()
      .run();
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.db
      .delete(channelStateSubscriptionsTable)
      .where(
        and(
          eq(channelStateSubscriptionsTable.scope, this.scope),
          eq(channelStateSubscriptionsTable.threadId, threadId),
        ),
      )
      .run();
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    const rows = await this.db
      .select({ threadId: channelStateSubscriptionsTable.threadId })
      .from(channelStateSubscriptionsTable)
      .where(
        and(
          eq(channelStateSubscriptionsTable.scope, this.scope),
          eq(channelStateSubscriptionsTable.threadId, threadId),
        ),
      )
      .limit(1)
      .all();
    return rows.length > 0;
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const now = nowMillis();
    await this.db
      .delete(channelStateLocksTable)
      .where(
        and(
          eq(channelStateLocksTable.scope, this.scope),
          eq(channelStateLocksTable.threadId, threadId),
          lte(channelStateLocksTable.expiresAt, now),
        ),
      )
      .run();
    const lock: Lock = { threadId, token: Effect.runSync(randomUUIDv4), expiresAt: now + ttlMs };
    const result = await this.db
      .insert(channelStateLocksTable)
      .values({ scope: this.scope, threadId, token: lock.token, expiresAt: lock.expiresAt })
      .onConflictDoNothing()
      .run();
    return result.rowsAffected > 0 ? lock : null;
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const now = nowMillis();
    const result = await this.db
      .update(channelStateLocksTable)
      .set({ expiresAt: now + ttlMs })
      .where(
        and(
          eq(channelStateLocksTable.scope, this.scope),
          eq(channelStateLocksTable.threadId, lock.threadId),
          eq(channelStateLocksTable.token, lock.token),
          gt(channelStateLocksTable.expiresAt, now),
        ),
      )
      .run();
    return result.rowsAffected > 0;
  }

  async releaseLock(lock: Lock): Promise<void> {
    await this.db
      .delete(channelStateLocksTable)
      .where(
        and(
          eq(channelStateLocksTable.scope, this.scope),
          eq(channelStateLocksTable.threadId, lock.threadId),
          eq(channelStateLocksTable.token, lock.token),
        ),
      )
      .run();
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    await this.db
      .delete(channelStateLocksTable)
      .where(and(eq(channelStateLocksTable.scope, this.scope), eq(channelStateLocksTable.threadId, threadId)))
      .run();
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const rows = await this.db
      .select({ value: channelStateEntriesTable.value, expiresAt: channelStateEntriesTable.expiresAt })
      .from(channelStateEntriesTable)
      .where(and(eq(channelStateEntriesTable.scope, this.scope), eq(channelStateEntriesTable.key, key)))
      .limit(1)
      .all();
    const row = rows[0];
    if (!row) return null;
    if (row.expiresAt !== null && row.expiresAt <= nowMillis()) {
      await this.delete(key);
      return null;
    }
    // SAFETY: values are only written by `set`/`setIfNotExists` from the same caller, which owns the type of each key.
    return JSON.parse(row.value, reviver) as T;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    const expiresAt = ttlMs ? nowMillis() + ttlMs : null;
    const serialized = JSON.stringify(value);
    await this.db
      .insert(channelStateEntriesTable)
      .values({ scope: this.scope, key, value: serialized, expiresAt })
      .onConflictDoUpdate({
        target: [channelStateEntriesTable.scope, channelStateEntriesTable.key],
        set: { value: serialized, expiresAt },
      })
      .run();
  }

  async setIfNotExists<T>(key: string, value: T, ttlMs?: number): Promise<boolean> {
    await this.db
      .delete(channelStateEntriesTable)
      .where(
        and(
          eq(channelStateEntriesTable.scope, this.scope),
          eq(channelStateEntriesTable.key, key),
          isNotNull(channelStateEntriesTable.expiresAt),
          lte(channelStateEntriesTable.expiresAt, nowMillis()),
        ),
      )
      .run();
    const result = await this.db
      .insert(channelStateEntriesTable)
      .values({ scope: this.scope, key, value: JSON.stringify(value), expiresAt: ttlMs ? nowMillis() + ttlMs : null })
      .onConflictDoNothing()
      .run();
    return result.rowsAffected > 0;
  }

  async delete(key: string): Promise<void> {
    await this.db
      .delete(channelStateEntriesTable)
      .where(and(eq(channelStateEntriesTable.scope, this.scope), eq(channelStateEntriesTable.key, key)))
      .run();
  }

  async appendToList<T>(key: string, value: T, options?: { maxLength?: number; ttlMs?: number }): Promise<void> {
    const expiresAt = options?.ttlMs ? nowMillis() + options.ttlMs : null;
    const listScope = and(eq(channelStateListItemsTable.scope, this.scope), eq(channelStateListItemsTable.key, key));
    await this.db
      .insert(channelStateListItemsTable)
      .values({ scope: this.scope, key, value: JSON.stringify(value), expiresAt })
      .run();
    if (options?.maxLength) {
      const rows = await this.db
        .select({ seq: channelStateListItemsTable.seq })
        .from(channelStateListItemsTable)
        .where(listScope)
        .orderBy(asc(channelStateListItemsTable.seq))
        .all();
      const excess = rows.length - options.maxLength;
      if (excess > 0) {
        const cutoff = rows[excess - 1]?.seq;
        if (cutoff !== undefined) {
          await this.db
            .delete(channelStateListItemsTable)
            .where(and(listScope, lte(channelStateListItemsTable.seq, cutoff)))
            .run();
        }
      }
    }
    if (expiresAt !== null) {
      await this.db.update(channelStateListItemsTable).set({ expiresAt }).where(listScope).run();
    }
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const listScope = and(eq(channelStateListItemsTable.scope, this.scope), eq(channelStateListItemsTable.key, key));
    await this.db
      .delete(channelStateListItemsTable)
      .where(
        and(
          listScope,
          isNotNull(channelStateListItemsTable.expiresAt),
          lte(channelStateListItemsTable.expiresAt, nowMillis()),
        ),
      )
      .run();
    const rows = await this.db
      .select({ value: channelStateListItemsTable.value })
      .from(channelStateListItemsTable)
      .where(listScope)
      .orderBy(asc(channelStateListItemsTable.seq))
      .all();
    // SAFETY: list items are only written by `appendToList` from the same caller, which owns the type of each key.
    return rows.map((row) => JSON.parse(row.value, reviver) as T);
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    const now = nowMillis();
    const queueScope = and(
      eq(channelStateQueueItemsTable.scope, this.scope),
      eq(channelStateQueueItemsTable.threadId, threadId),
    );
    await this.db
      .delete(channelStateQueueItemsTable)
      .where(and(queueScope, lte(channelStateQueueItemsTable.expiresAt, now)))
      .run();
    await this.db
      .insert(channelStateQueueItemsTable)
      .values({ scope: this.scope, threadId, value: JSON.stringify(entry), expiresAt: entry.expiresAt })
      .run();
    const rows = await this.db
      .select({ seq: channelStateQueueItemsTable.seq })
      .from(channelStateQueueItemsTable)
      .where(queueScope)
      .orderBy(asc(channelStateQueueItemsTable.seq))
      .all();
    const excess = maxSize > 0 ? rows.length - maxSize : 0;
    if (excess > 0) {
      const cutoff = rows[excess - 1]?.seq;
      if (cutoff !== undefined) {
        await this.db
          .delete(channelStateQueueItemsTable)
          .where(and(queueScope, lte(channelStateQueueItemsTable.seq, cutoff)))
          .run();
      }
    }
    return Math.min(rows.length, maxSize > 0 ? maxSize : rows.length);
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    const now = nowMillis();
    const queueScope = and(
      eq(channelStateQueueItemsTable.scope, this.scope),
      eq(channelStateQueueItemsTable.threadId, threadId),
    );
    await this.db
      .delete(channelStateQueueItemsTable)
      .where(and(queueScope, lte(channelStateQueueItemsTable.expiresAt, now)))
      .run();
    const rows = await this.db
      .select({ seq: channelStateQueueItemsTable.seq, value: channelStateQueueItemsTable.value })
      .from(channelStateQueueItemsTable)
      .where(queueScope)
      .orderBy(asc(channelStateQueueItemsTable.seq))
      .limit(1)
      .all();
    const row = rows[0];
    if (!row) return null;
    const removed = await this.db
      .delete(channelStateQueueItemsTable)
      .where(eq(channelStateQueueItemsTable.seq, row.seq))
      .run();
    if (removed.rowsAffected === 0) return this.dequeue(threadId);
    // SAFETY: queue rows are only written by `enqueue`, which serializes a `QueueEntry`; `reviver` restores its `Message`.
    return JSON.parse(row.value, reviver) as QueueEntry;
  }

  async queueDepth(threadId: string): Promise<number> {
    const rows = await this.db
      .select({ depth: count() })
      .from(channelStateQueueItemsTable)
      .where(
        and(
          eq(channelStateQueueItemsTable.scope, this.scope),
          eq(channelStateQueueItemsTable.threadId, threadId),
          or(gt(channelStateQueueItemsTable.expiresAt, nowMillis())),
        ),
      )
      .all();
    return rows[0]?.depth ?? 0;
  }
}
