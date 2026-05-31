import type { Message, Task } from '@a2a-js/sdk';
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { db, a2aContextMessagesTable, a2aTasksTable, agentsTable, sessionsTable, workflowsTable } from 'db';
import { Context, Effect, Layer } from 'effect';
import type { ContextHistoryStore } from 'agentdock-sdk';

type ChatMessageEvent = {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly details?: string;
  readonly rawEvent?: unknown;
  readonly at: number;
};

type ChatMessage = {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly events?: ReadonlyArray<ChatMessageEvent>;
};

type Session = {
  readonly id: string;
  readonly title: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly conversationState: {
    readonly contextId: string;
    readonly taskId?: string;
  };
  readonly createdAt: number;
  readonly updatedAt: number;
};

type EvalTarget = {
  readonly kind: 'agent' | 'workflow' | 'unknown';
  readonly id: string;
  readonly name: string;
};

type EvalToolAction = {
  readonly id: string;
  readonly type: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly error?: string;
};

type EvalMessage = {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly parts: ReadonlyArray<unknown>;
  readonly createdAt?: number;
};

type EvalOutcome = {
  readonly state?: string;
  readonly text: string;
  readonly actions: ReadonlyArray<EvalToolAction>;
};

type EvalSessionSummary = {
  readonly id: string;
  readonly target: EvalTarget;
  readonly title: string;
  readonly initialMessage: string;
  readonly outcome: EvalOutcome;
  readonly messageCount: number;
  readonly actionCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

type EvalSessionDetail = EvalSessionSummary & {
  readonly messages: ReadonlyArray<EvalMessage>;
  readonly task?: unknown;
};

type PersistentAgentTaskStore = TaskStore & {
  readonly list: () => Promise<ReadonlyArray<Task>>;
};

type AgentA2aSessionStoreService = {
  readonly getTaskStore: (agentId: string) => Effect.Effect<PersistentAgentTaskStore, unknown>;
  readonly getContextHistoryStore: (agentId: string) => Effect.Effect<ContextHistoryStore, unknown>;
  readonly listSessions: (agentId: string) => Effect.Effect<ReadonlyArray<Session>, unknown>;
  readonly listEvalSessions: () => Effect.Effect<ReadonlyArray<EvalSessionSummary>, unknown>;
  readonly getEvalSession: (input: {
    readonly targetId: string;
    readonly sessionId: string;
  }) => Effect.Effect<EvalSessionDetail, unknown>;
  readonly deleteSession: (input: {
    readonly agentId: string;
    readonly sessionId: string;
  }) => Effect.Effect<void, unknown>;
};

const textFromMessage = (message: Message): string =>
  message.parts
    .flatMap((part) => (part.kind === 'text' ? [part.text] : []))
    .join('\n');

const messageParts = (message: Message): ReadonlyArray<unknown> => message.parts as ReadonlyArray<unknown>;

const dataPartsFromMessage = (message: Message): ReadonlyArray<Record<string, unknown>> =>
  message.parts.flatMap((part) => {
    if (part.kind !== 'data' || typeof part.data !== 'object' || part.data === null) {
      return [];
    }

    return [part.data as Record<string, unknown>];
  });

const stringField = (value: Record<string, unknown>, key: string): string | undefined => {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
};

const maybeField = (value: Record<string, unknown>, key: string): { readonly [key: string]: unknown } =>
  key in value ? { [key]: value[key] } : {};

const toToolAction = (message: Message, data: Record<string, unknown>): EvalToolAction | null => {
  const type = stringField(data, 'type');
  if (type !== 'tool-call' && type !== 'tool-result' && type !== 'tool-error') {
    return null;
  }

  const toolName = stringField(data, 'toolName');
  const toolCallId = stringField(data, 'toolCallId');
  const error = stringField(data, 'error');

  return {
    id: `${message.messageId}:${type}:${toolCallId ?? 'unknown'}`,
    type,
    ...(toolName ? { toolName } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...maybeField(data, 'input'),
    ...maybeField(data, 'output'),
    ...(error ? { error } : {}),
  };
};

const toolEventsFromMessage = (message: Message, at: number): ReadonlyArray<ChatMessageEvent> =>
  dataPartsFromMessage(message).flatMap((data) => {
    const type = stringField(data, 'type');
    if (type !== 'tool-call' && type !== 'tool-result' && type !== 'tool-error') {
      return [];
    }

    const toolName = stringField(data, 'toolName') ?? 'tool';
    const toolCallId = stringField(data, 'toolCallId') ?? 'unknown';

    return [
      {
        id: `${message.messageId}:${type}:${toolCallId}`,
        kind: 'status-update',
        summary: `${type}: ${toolName}`,
        rawEvent: {
          kind: 'status-update',
          status: {
            message: {
              parts: [{ kind: 'data', data }],
            },
          },
        },
        at,
      },
    ];
  });

const toChatMessage = (
  message: Message,
  pendingEvents: ReadonlyArray<ChatMessageEvent>,
): ChatMessage | null => {
  const text = textFromMessage(message);
  if (text.length === 0) {
    return null;
  }

  return {
    id: message.messageId,
    role: message.role === 'agent' ? 'assistant' : 'user',
    text,
    ...(pendingEvents.length > 0 ? { events: pendingEvents } : {}),
  };
};

const getSessionTitle = (messages: ReadonlyArray<ChatMessage>): string => {
  const firstUserMessage = messages.find((message) => message.role === 'user')?.text.trim().replace(/\s+/g, ' ');
  if (!firstUserMessage) {
    return 'New Task';
  }

  return firstUserMessage.length > 36 ? `${firstUserMessage.slice(0, 33)}...` : firstUserMessage;
};

const getTaskContextId = (task: Task): string => {
  if (typeof task.contextId === 'string' && task.contextId.length > 0) {
    return task.contextId;
  }

  const messageContextId = task.history?.find((message) => typeof message.contextId === 'string')?.contextId;
  return messageContextId ?? task.id;
};

const targetIdFromWorkflowTarget = (targetId: string): string | null =>
  targetId.startsWith('workflow:') ? targetId.slice('workflow:'.length) : null;

const resolveTargets = async (): Promise<Map<string, EvalTarget>> => {
  const [agents, workflows] = await Promise.all([
    db.select({ id: agentsTable.id, name: agentsTable.name }).from(agentsTable).all(),
    db.select({ id: workflowsTable.id, name: workflowsTable.name }).from(workflowsTable).all(),
  ]);

  const targets = new Map<string, EvalTarget>();
  for (const agent of agents) {
    targets.set(agent.id, { kind: 'agent', id: agent.id, name: agent.name });
  }
  for (const workflow of workflows) {
    targets.set(`workflow:${workflow.id}`, { kind: 'workflow', id: `workflow:${workflow.id}`, name: workflow.name });
  }

  return targets;
};

const fallbackTarget = (targetId: string): EvalTarget => {
  const workflowId = targetIdFromWorkflowTarget(targetId);
  return workflowId
    ? { kind: 'workflow', id: targetId, name: `Workflow ${workflowId}` }
    : { kind: 'unknown', id: targetId, name: targetId };
};

const upsertSession = async ({
  agentId,
  sessionId,
  taskId,
  updatedAt,
}: {
  readonly agentId: string;
  readonly sessionId: string;
  readonly taskId?: string;
  readonly updatedAt: number;
}): Promise<void> => {
  await db
    .insert(sessionsTable)
    .values({
      agentId,
      id: sessionId,
      ...(taskId ? { taskId } : {}),
      createdAt: updatedAt,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [sessionsTable.agentId, sessionsTable.id],
      set: {
        ...(taskId ? { taskId } : {}),
        updatedAt,
      },
    })
    .run();
};

class DbTaskStore implements PersistentAgentTaskStore {
  constructor(private readonly agentId: string) {}

  async load(taskId: string, _context?: ServerCallContext): Promise<Task | undefined> {
    const rows = await db
      .select({ task: a2aTasksTable.task })
      .from(a2aTasksTable)
      .where(sql`${a2aTasksTable.agentId} = ${this.agentId} and ${a2aTasksTable.taskId} = ${taskId}`)
      .limit(1)
      .all();

    return rows[0]?.task as Task | undefined;
  }

  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    const now = Date.now();
    const contextId = getTaskContextId(task);
    const existing = await db
      .select({ createdAt: a2aTasksTable.createdAt })
      .from(a2aTasksTable)
      .where(sql`${a2aTasksTable.agentId} = ${this.agentId} and ${a2aTasksTable.taskId} = ${task.id}`)
      .limit(1)
      .all();

    await db
      .insert(a2aTasksTable)
      .values({
        agentId: this.agentId,
        taskId: task.id,
        contextId,
        task,
        createdAt: existing[0]?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [a2aTasksTable.agentId, a2aTasksTable.taskId],
        set: {
          contextId,
          task,
          updatedAt: now,
        },
      })
      .run();

    await upsertSession({ agentId: this.agentId, sessionId: contextId, taskId: task.id, updatedAt: now });
  }

  async list(): Promise<ReadonlyArray<Task>> {
    const rows = await db
      .select({ task: a2aTasksTable.task })
      .from(a2aTasksTable)
      .where(eq(a2aTasksTable.agentId, this.agentId))
      .orderBy(desc(a2aTasksTable.updatedAt))
      .all();

    return rows.map((row) => row.task as Task);
  }
}

class DbContextHistoryStore extends Map<string, ReadonlyArray<Message>> {
  constructor(private readonly agentId: string) {
    super();
  }

  override set(contextId: string, messages: ReadonlyArray<Message>): this {
    const previousLength = this.get(contextId)?.length ?? 0;
    super.set(contextId, messages);

    const newMessages = messages.slice(previousLength);
    for (let index = 0; index < newMessages.length; index += 1) {
      const message = newMessages[index];
      if (!message) {
        continue;
      }

      void persistContextMessage({
        agentId: this.agentId,
        contextId,
        message,
        messageIndex: previousLength + index,
      });
    }

    return this;
  }
}

const persistContextMessage = async ({
  agentId,
  contextId,
  message,
  messageIndex,
}: {
  readonly agentId: string;
  readonly contextId: string;
  readonly message: Message;
  readonly messageIndex: number;
}): Promise<void> => {
  const now = Date.now();
  await db
    .insert(a2aContextMessagesTable)
    .values({
      agentId,
      contextId,
      messageId: message.messageId,
      messageIndex,
      message,
      createdAt: now,
    })
    .onConflictDoNothing()
    .run();

  await upsertSession({ agentId, sessionId: contextId, updatedAt: now });
};

const hydrateContextStore = async (agentId: string, store: DbContextHistoryStore): Promise<void> => {
  const rows = await db
    .select({ contextId: a2aContextMessagesTable.contextId, message: a2aContextMessagesTable.message })
    .from(a2aContextMessagesTable)
    .where(eq(a2aContextMessagesTable.agentId, agentId))
    .orderBy(asc(a2aContextMessagesTable.contextId), asc(a2aContextMessagesTable.messageIndex))
    .all();

  const messagesByContext = new Map<string, Array<Message>>();
  for (const row of rows) {
    const messages = messagesByContext.get(row.contextId) ?? [];
    messages.push(row.message as Message);
    messagesByContext.set(row.contextId, messages);
  }

  for (const [contextId, messages] of messagesByContext) {
    Map.prototype.set.call(store, contextId, messages);
  }
};

const listSessions = async (agentId: string): Promise<ReadonlyArray<Session>> => {
  const sessionRows = await db
    .select({
      id: sessionsTable.id,
      taskId: sessionsTable.taskId,
      createdAt: sessionsTable.createdAt,
      updatedAt: sessionsTable.updatedAt,
    })
    .from(sessionsTable)
    .where(eq(sessionsTable.agentId, agentId))
    .orderBy(desc(sessionsTable.updatedAt))
    .all();

  const taskRows = await db
    .select({
      taskId: a2aTasksTable.taskId,
      contextId: a2aTasksTable.contextId,
      task: a2aTasksTable.task,
      createdAt: a2aTasksTable.createdAt,
      updatedAt: a2aTasksTable.updatedAt,
    })
    .from(a2aTasksTable)
    .where(eq(a2aTasksTable.agentId, agentId))
    .orderBy(desc(a2aTasksTable.updatedAt))
    .all();

  const messageRows = await db
    .select({
      contextId: a2aContextMessagesTable.contextId,
      message: a2aContextMessagesTable.message,
      createdAt: a2aContextMessagesTable.createdAt,
    })
    .from(a2aContextMessagesTable)
    .where(eq(a2aContextMessagesTable.agentId, agentId))
    .orderBy(asc(a2aContextMessagesTable.contextId), asc(a2aContextMessagesTable.messageIndex))
    .all();

  const tasksByContext = new Map<string, typeof taskRows[number]>();
  for (const task of taskRows) {
    const existing = tasksByContext.get(task.contextId);
    if (!existing || task.updatedAt > existing.updatedAt) {
      tasksByContext.set(task.contextId, task);
    }
  }

  const rowsByContext = new Map<string, Array<typeof messageRows[number]>>();
  for (const row of messageRows) {
    const rows = rowsByContext.get(row.contextId) ?? [];
    rows.push(row);
    rowsByContext.set(row.contextId, rows);
  }

  return sessionRows
    .map((session) => {
      const contextId = session.id;
      const task = tasksByContext.get(contextId);
      const rows = rowsByContext.get(contextId) ?? [];
      const storedTask = task?.task as Task | undefined;
      const taskFallbackAt = task?.updatedAt ?? session.updatedAt;
      const taskMessages = storedTask
        ? [...(storedTask.history ?? []), ...(storedTask.status.message ? [storedTask.status.message] : [])]
        : [];
      const rawMessagesById = new Map<string, { readonly message: Message; readonly at: number }>();
      for (const row of rows) {
        const message = row.message as Message;
        rawMessagesById.set(message.messageId, { message, at: row.createdAt });
      }
      for (const message of taskMessages) {
        if (!rawMessagesById.has(message.messageId)) {
          rawMessagesById.set(message.messageId, { message, at: taskFallbackAt });
        }
      }
      const rawMessages = Array.from(rawMessagesById.values());
      const messages: Array<ChatMessage> = [];
      let pendingEvents: Array<ChatMessageEvent> = [];
      for (const { message, at } of rawMessages) {
        const events = toolEventsFromMessage(message, at);
        if (events.length > 0) {
          pendingEvents.push(...events);
        }
        const chatMessage = toChatMessage(message, pendingEvents);
        if (chatMessage) {
          messages.push(chatMessage);
          pendingEvents = [];
        }
      }
      const latestTaskId = task?.taskId ?? session.taskId ?? undefined;

      return {
        id: contextId,
        title: getSessionTitle(messages),
        messages,
        conversationState: {
          contextId,
          ...(latestTaskId ? { taskId: latestTaskId } : {}),
        },
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
};

const evalMessagesFromRows = (
  rows: ReadonlyArray<{ readonly message: unknown; readonly createdAt: number }>,
  task: Task | undefined,
): ReadonlyArray<EvalMessage> => {
  const taskMessages = task ? [...(task.history ?? []), ...(task.status.message ? [task.status.message] : [])] : [];
  const messagesById = new Map<string, { readonly message: Message; readonly createdAt?: number }>();
  for (const row of rows) {
    const message = row.message as Message;
    messagesById.set(message.messageId, { message, createdAt: row.createdAt });
  }
  for (const message of taskMessages) {
    if (!messagesById.has(message.messageId)) {
      messagesById.set(message.messageId, { message });
    }
  }

  return Array.from(messagesById.values()).map(({ message, createdAt }) => ({
    id: message.messageId,
    role: message.role,
    text: textFromMessage(message),
    parts: messageParts(message),
    ...(createdAt ? { createdAt } : {}),
  }));
};

const evalActionsFromMessages = (messages: ReadonlyArray<Message>): ReadonlyArray<EvalToolAction> =>
  messages.flatMap((message) =>
    dataPartsFromMessage(message).flatMap((data) => {
      const action = toToolAction(message, data);
      return action ? [action] : [];
    }),
  );

const evalOutcomeFrom = (messages: ReadonlyArray<EvalMessage>, task: Task | undefined): EvalOutcome => {
  const rawMessages = messages.map((message) => ({
    kind: 'message' as const,
    role: message.role,
    messageId: message.id,
    parts: message.parts as Message['parts'],
  })) as ReadonlyArray<Message>;
  const state = task?.status.state;
  const statusText = task?.status.message ? textFromMessage(task.status.message) : '';
  const lastAssistantText = [...messages].reverse().find((message) => message.role === 'agent' && message.text.trim().length > 0)?.text ?? '';

  return {
    ...(state ? { state } : {}),
    text: statusText || lastAssistantText,
    actions: evalActionsFromMessages(rawMessages),
  };
};

const buildEvalSession = ({
  session,
  target,
  messageRows,
  task,
}: {
  readonly session: { readonly agentId: string; readonly id: string; readonly createdAt: number; readonly updatedAt: number };
  readonly target: EvalTarget;
  readonly messageRows: ReadonlyArray<{ readonly message: unknown; readonly createdAt: number }>;
  readonly task: Task | undefined;
}): EvalSessionDetail => {
  const messages = evalMessagesFromRows(messageRows, task);
  const chatMessages = messages.flatMap((message) => {
    if (message.text.trim().length === 0) return [];
    return [{ id: message.id, role: message.role === 'agent' ? 'assistant' as const : 'user' as const, text: message.text }];
  });
  const initialMessage = messages.find((message) => message.role === 'user' && message.text.trim().length > 0)?.text ?? '';
  const outcome = evalOutcomeFrom(messages, task);

  return {
    id: session.id,
    target,
    title: getSessionTitle(chatMessages),
    initialMessage,
    messages,
    outcome,
    messageCount: messages.length,
    actionCount: outcome.actions.length,
    ...(task ? { task } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
};

const listEvalSessions = async (): Promise<ReadonlyArray<EvalSessionSummary>> => {
  const [targets, sessionRows, taskRows, messageRows] = await Promise.all([
    resolveTargets(),
    db.select({ agentId: sessionsTable.agentId, id: sessionsTable.id, createdAt: sessionsTable.createdAt, updatedAt: sessionsTable.updatedAt })
      .from(sessionsTable)
      .orderBy(desc(sessionsTable.updatedAt))
      .all(),
    db.select({ agentId: a2aTasksTable.agentId, contextId: a2aTasksTable.contextId, task: a2aTasksTable.task, updatedAt: a2aTasksTable.updatedAt })
      .from(a2aTasksTable)
      .orderBy(desc(a2aTasksTable.updatedAt))
      .all(),
    db.select({ agentId: a2aContextMessagesTable.agentId, contextId: a2aContextMessagesTable.contextId, message: a2aContextMessagesTable.message, createdAt: a2aContextMessagesTable.createdAt })
      .from(a2aContextMessagesTable)
      .orderBy(asc(a2aContextMessagesTable.agentId), asc(a2aContextMessagesTable.contextId), asc(a2aContextMessagesTable.messageIndex))
      .all(),
  ]);

  const tasksBySession = new Map<string, typeof taskRows[number]>();
  for (const task of taskRows) {
    const key = `${task.agentId}\u0000${task.contextId}`;
    const existing = tasksBySession.get(key);
    if (!existing || task.updatedAt > existing.updatedAt) {
      tasksBySession.set(key, task);
    }
  }

  const messagesBySession = new Map<string, Array<typeof messageRows[number]>>();
  for (const row of messageRows) {
    const key = `${row.agentId}\u0000${row.contextId}`;
    const rows = messagesBySession.get(key) ?? [];
    rows.push(row);
    messagesBySession.set(key, rows);
  }

  return sessionRows.map((session) => {
    const key = `${session.agentId}\u0000${session.id}`;
    const detail = buildEvalSession({
      session,
      target: targets.get(session.agentId) ?? fallbackTarget(session.agentId),
      messageRows: messagesBySession.get(key) ?? [],
      task: tasksBySession.get(key)?.task as Task | undefined,
    });
    const { messages: _messages, task: _task, ...summary } = detail;
    return summary;
  });
};

const getEvalSession = async ({ targetId, sessionId }: { readonly targetId: string; readonly sessionId: string }): Promise<EvalSessionDetail> => {
  const [targets, sessionRows, taskRows, messageRows] = await Promise.all([
    resolveTargets(),
    db.select({ agentId: sessionsTable.agentId, id: sessionsTable.id, createdAt: sessionsTable.createdAt, updatedAt: sessionsTable.updatedAt })
      .from(sessionsTable)
      .where(sql`${sessionsTable.agentId} = ${targetId} and ${sessionsTable.id} = ${sessionId}`)
      .limit(1)
      .all(),
    db.select({ task: a2aTasksTable.task, updatedAt: a2aTasksTable.updatedAt })
      .from(a2aTasksTable)
      .where(sql`${a2aTasksTable.agentId} = ${targetId} and ${a2aTasksTable.contextId} = ${sessionId}`)
      .orderBy(desc(a2aTasksTable.updatedAt))
      .limit(1)
      .all(),
    db.select({ message: a2aContextMessagesTable.message, createdAt: a2aContextMessagesTable.createdAt })
      .from(a2aContextMessagesTable)
      .where(sql`${a2aContextMessagesTable.agentId} = ${targetId} and ${a2aContextMessagesTable.contextId} = ${sessionId}`)
      .orderBy(asc(a2aContextMessagesTable.messageIndex))
      .all(),
  ]);

  const session = sessionRows[0];
  if (!session) {
    throw new Error('Session not found');
  }

  return buildEvalSession({
    session,
    target: targets.get(targetId) ?? fallbackTarget(targetId),
    messageRows,
    task: taskRows[0]?.task as Task | undefined,
  });
};

const deleteSession = async ({ agentId, sessionId }: { readonly agentId: string; readonly sessionId: string }): Promise<void> => {
  await db
    .delete(a2aContextMessagesTable)
    .where(sql`${a2aContextMessagesTable.agentId} = ${agentId} and ${a2aContextMessagesTable.contextId} = ${sessionId}`)
    .run();
  await db
    .delete(a2aTasksTable)
    .where(sql`${a2aTasksTable.agentId} = ${agentId} and ${a2aTasksTable.contextId} = ${sessionId}`)
    .run();
  await db
    .delete(sessionsTable)
    .where(sql`${sessionsTable.agentId} = ${agentId} and ${sessionsTable.id} = ${sessionId}`)
    .run();
};

export const AgentA2aSessionStore = Context.Service<AgentA2aSessionStoreService>(
  '@agentdock/api/AgentA2aSessionStore',
);

export const AgentA2aSessionStoreLive = Layer.effect(
  AgentA2aSessionStore,
  Effect.gen(function* () {
    const taskStores = new Map<string, PersistentAgentTaskStore>();
    const contextStores = new Map<string, ContextHistoryStore>();

    return AgentA2aSessionStore.of({
      getTaskStore: Effect.fn('AgentA2aSessionStore.getTaskStore')(function* (agentId: string) {
        const existing = taskStores.get(agentId);
        if (existing) {
          return existing;
        }

        const store = new DbTaskStore(agentId);
        taskStores.set(agentId, store);
        return store;
      }),
      getContextHistoryStore: Effect.fn('AgentA2aSessionStore.getContextHistoryStore')(function* (agentId: string) {
        const existing = contextStores.get(agentId);
        if (existing) {
          return existing;
        }

        const store = new DbContextHistoryStore(agentId);
        yield* Effect.tryPromise(() => hydrateContextStore(agentId, store));
        contextStores.set(agentId, store);
        return store;
      }),
      listSessions: Effect.fn('AgentA2aSessionStore.listSessions')(function* (agentId: string) {
        return yield* Effect.tryPromise(() => listSessions(agentId));
      }),
      listEvalSessions: Effect.fn('AgentA2aSessionStore.listEvalSessions')(function* () {
        return yield* Effect.tryPromise(() => listEvalSessions());
      }),
      getEvalSession: Effect.fn('AgentA2aSessionStore.getEvalSession')(function* (input: {
        readonly targetId: string;
        readonly sessionId: string;
      }) {
        return yield* Effect.tryPromise(() => getEvalSession(input));
      }),
      deleteSession: Effect.fn('AgentA2aSessionStore.deleteSession')(function* (input: {
        readonly agentId: string;
        readonly sessionId: string;
      }) {
        contextStores.get(input.agentId)?.delete(input.sessionId);
        return yield* Effect.tryPromise(() => deleteSession(input));
      }),
    });
  }),
);

export type { Session };
