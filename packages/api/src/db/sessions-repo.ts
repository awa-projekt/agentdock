import type { Message, Task } from '@a2a-js/sdk';
import { A2AMessage, type EvalTarget } from 'agentdock-sdk/schemas';
import {
  a2aContextMessagesTable,
  agentsTable,
  type DatabaseClient,
  sessionBranchesTable,
  sessionsTable,
  tryDbWith,
  workflowsTable,
} from 'db';
import { asc, desc, eq, sql } from 'drizzle-orm';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

type Tx = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];
type DbOrTx = DatabaseClient | Tx;

export type MessageRow = { readonly message: Message; readonly createdAt?: number | undefined };

/**
 * The `a2a_context_messages.message` column is untyped JSON, so every row is
 * decoded against the a2a message schema on the way out. A row that no longer
 * matches the protocol shape is dropped rather than handed on unparsed.
 */
const decodeMessage = Schema.decodeUnknownOption(A2AMessage);

const safeIdPart = (value: string): string => value.replace(/[^a-zA-Z0-9_.-]/g, '-');
const branchIdForContext = (targetId: string, contextId: string): string =>
  `br_${targetId}_${contextId}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
const sessionIdForContext = (targetId: string, contextId: string): string =>
  `ses_${safeIdPart(targetId)}_${safeIdPart(contextId)}`;

const targetKind = (targetId: string): 'agent' | 'workflow' =>
  targetId.startsWith('workflow:') ? 'workflow' : 'agent';

const resolveTarget = async (db: DbOrTx, targetId: string): Promise<EvalTarget> => {
  if (targetId.startsWith('workflow:')) {
    const workflowId = targetId.slice('workflow:'.length);
    const workflow = await db
      .select({ manifest: workflowsTable.manifest })
      .from(workflowsTable)
      .where(eq(workflowsTable.id, workflowId))
      .limit(1)
      .all();
    return {
      kind: 'workflow',
      id: targetId,
      name: workflow[0]?.manifest.name ?? `Workflow ${workflowId}`,
    };
  }
  const agent = await db
    .select({ name: agentsTable.name })
    .from(agentsTable)
    .where(eq(agentsTable.id, targetId))
    .limit(1)
    .all();
  return agent[0]
    ? { kind: 'agent', id: targetId, name: agent[0].name }
    : { kind: 'unknown', id: targetId, name: targetId };
};

export const createSessionRepo = <E>(db: DatabaseClient, makeError: (cause: unknown) => E) => {
  const tryDb = tryDbWith(makeError);

  const ensureSessionForContext = async (
    tx: DbOrTx,
    targetId: string,
    contextId: string,
    now: number,
  ): Promise<string> => {
    const branchId = branchIdForContext(targetId, contextId);
    const target = await resolveTarget(tx, targetId);
    const sessionId = sessionIdForContext(targetId, contextId);
    await tx
      .insert(sessionsTable)
      .values({
        id: sessionId,
        activeBranchId: branchId,
        targetKind: target.kind === 'unknown' ? targetKind(targetId) : target.kind,
        targetId,
        targetName: target.name,
        title: 'New Task',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    await tx
      .insert(sessionBranchesTable)
      .values({ id: branchId, sessionId, contextId, origin: 'initial', createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .run();
    return branchId;
  };

  const touchSession = async (tx: DbOrTx, branchId: string, updatedAt: number, title?: string): Promise<void> => {
    const branch = await tx
      .select({ sessionId: sessionBranchesTable.sessionId })
      .from(sessionBranchesTable)
      .where(eq(sessionBranchesTable.id, branchId))
      .limit(1)
      .all();
    if (!branch[0]) return;
    await tx.update(sessionBranchesTable).set({ updatedAt }).where(eq(sessionBranchesTable.id, branchId)).run();
    await tx
      .update(sessionsTable)
      .set(title ? { updatedAt, title } : { updatedAt })
      .where(eq(sessionsTable.id, branch[0].sessionId))
      .run();
  };

  return {
    ensureSessionForContext: (targetId: string, contextId: string, now: number): Effect.Effect<string, E> =>
      tryDb(() => ensureSessionForContext(db, targetId, contextId, now)),
    touchSession: (branchId: string, updatedAt: number, title?: string): Effect.Effect<void, E> =>
      tryDb(() => touchSession(db, branchId, updatedAt, title)),
    persistContextMessage: (input: {
      readonly targetId: string;
      readonly contextId: string;
      readonly message: Message;
      readonly messageIndex: number;
      readonly now: number;
    }): Effect.Effect<void, E> =>
      tryDb(() =>
        db.transaction(async (tx) => {
          const branchId = await ensureSessionForContext(tx, input.targetId, input.contextId, input.now);
          await tx
            .insert(a2aContextMessagesTable)
            .values({
              targetId: input.targetId,
              branchId,
              contextId: input.contextId,
              messageId: input.message.messageId,
              messageIndex: input.messageIndex,
              message: input.message,
              createdAt: input.now,
            })
            .onConflictDoNothing()
            .run();
          await touchSession(tx, branchId, input.now);
        }),
      ).pipe(Effect.asVoid),
    hydrateContextMessages: (targetId: string): Promise<ReadonlyMap<string, ReadonlyArray<Message>>> =>
      db
        .select({ contextId: a2aContextMessagesTable.contextId, message: a2aContextMessagesTable.message })
        .from(a2aContextMessagesTable)
        .where(eq(a2aContextMessagesTable.targetId, targetId))
        .orderBy(asc(a2aContextMessagesTable.contextId), asc(a2aContextMessagesTable.messageIndex))
        .all()
        .then((rows) => {
          const messagesByContext = new Map<string, Array<Message>>();
          for (const row of rows) {
            const message = Option.getOrUndefined(decodeMessage(row.message));
            if (!message) continue;
            messagesByContext.set(row.contextId, [...(messagesByContext.get(row.contextId) ?? []), message]);
          }
          return messagesByContext;
        }),
    messagesFor: (targetId: string, contextId: string, task?: Task): Promise<ReadonlyArray<MessageRow>> =>
      db
        .select({ message: a2aContextMessagesTable.message, createdAt: a2aContextMessagesTable.createdAt })
        .from(a2aContextMessagesTable)
        .where(
          sql`${a2aContextMessagesTable.targetId} = ${targetId} and ${a2aContextMessagesTable.contextId} = ${contextId}`,
        )
        .orderBy(asc(a2aContextMessagesTable.messageIndex))
        .all()
        .then((rows) => {
          const messagesById = new Map<string, MessageRow>();
          for (const row of rows) {
            const message = Option.getOrUndefined(decodeMessage(row.message));
            if (!message) continue;
            messagesById.set(message.messageId, { message, createdAt: row.createdAt });
          }
          for (const message of task
            ? [...(task.history ?? []), ...(task.status.message ? [task.status.message] : [])]
            : [])
            if (!messagesById.has(message.messageId)) messagesById.set(message.messageId, { message });
          return Array.from(messagesById.values());
        }),
    listSessionRows: (targetId?: string) => {
      const query = db
        .select({
          sessionId: sessionsTable.id,
          title: sessionsTable.title,
          branchId: sessionsTable.activeBranchId,
          targetId: sessionsTable.targetId,
          targetKind: sessionsTable.targetKind,
          targetName: sessionsTable.targetName,
          contextId: sessionBranchesTable.contextId,
          createdAt: sessionsTable.createdAt,
          updatedAt: sessionsTable.updatedAt,
        })
        .from(sessionsTable)
        .innerJoin(sessionBranchesTable, eq(sessionsTable.activeBranchId, sessionBranchesTable.id))
        .$dynamic();
      return (targetId ? query.where(eq(sessionsTable.targetId, targetId)) : query)
        .orderBy(desc(sessionsTable.updatedAt))
        .all();
    },
    getSessionRow: (targetId: string, sessionId: string) =>
      db
        .select({
          targetKind: sessionsTable.targetKind,
          targetName: sessionsTable.targetName,
          contextId: sessionBranchesTable.contextId,
          createdAt: sessionsTable.createdAt,
          updatedAt: sessionsTable.updatedAt,
        })
        .from(sessionsTable)
        .innerJoin(sessionBranchesTable, eq(sessionsTable.activeBranchId, sessionBranchesTable.id))
        .where(sql`${sessionsTable.targetId} = ${targetId} and ${sessionsTable.id} = ${sessionId}`)
        .limit(1)
        .all()
        .then((rows) => rows[0] ?? null),
    contextIdsForSession: (sessionId: string): Effect.Effect<ReadonlyArray<string>, E> =>
      tryDb(() =>
        db
          .select({ contextId: sessionBranchesTable.contextId })
          .from(sessionBranchesTable)
          .where(eq(sessionBranchesTable.sessionId, sessionId))
          .all()
          .then((rows) => rows.map((row) => row.contextId)),
      ),
    deleteSession: (targetId: string, sessionId: string): Effect.Effect<void, E> =>
      tryDb(() =>
        db.transaction(async (tx) => {
          const branches = await tx
            .select({ contextId: sessionBranchesTable.contextId })
            .from(sessionBranchesTable)
            .where(eq(sessionBranchesTable.sessionId, sessionId))
            .all();
          for (const branch of branches) {
            await tx
              .delete(a2aContextMessagesTable)
              .where(
                sql`${a2aContextMessagesTable.targetId} = ${targetId} and ${a2aContextMessagesTable.contextId} = ${branch.contextId}`,
              )
              .run();
          }
          await tx.delete(sessionBranchesTable).where(eq(sessionBranchesTable.sessionId, sessionId)).run();
          await tx.delete(sessionsTable).where(eq(sessionsTable.id, sessionId)).run();
        }),
      ).pipe(Effect.asVoid),
  };
};
