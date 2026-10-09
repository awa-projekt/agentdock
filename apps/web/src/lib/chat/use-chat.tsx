import type { MessageSendParams } from '@a2a-js/sdk';
import {
  type Client,
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from '@a2a-js/sdk/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { randomUUIDv4 } from 'agentdock-sdk/random';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toErrorMessage } from '@/lib/format';
import { queryKeys } from '@/lib/queries';
import type { StreamEvent } from './events';
import {
  type AssistantMessage,
  type ChatSession,
  type ConnectionState,
  DEFAULT_SESSION_TITLE,
  isTerminalState,
  sessionTitleFromText,
} from './model';
import { type ChatPersistence, persistedCoversLocal } from './persistence';
import { applyStreamEvent, finishTurn, replaceAssistantMessage } from './reducer';
import { fetchWithSession } from './session-fetch';

const now = (): number => Effect.runSync(Clock.currentTimeMillis);
const uuid = (): string => Effect.runSync(randomUUIDv4);

const factory = new ClientFactory(
  ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    transports: [new JsonRpcTransportFactory({ fetchImpl: fetchWithSession })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl: fetchWithSession }),
  }),
);
const RESUBSCRIBE_ATTEMPTS = 20;
const RESUBSCRIBE_DELAY_MS = 750;

const delay = (millis: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, millis);
  });

export type ChatController = {
  readonly connection: ConnectionState;
  /** Sessions with at least one message, newest first. */
  readonly sessions: ReadonlyArray<ChatSession>;
  readonly sessionsLoading: boolean;
  readonly sessionsError: string | null;
  readonly activeSession: ChatSession | undefined;
  readonly isStreaming: boolean;
  readonly input: string;
  readonly setInput: (value: string) => void;
  readonly send: (text?: string) => void;
  readonly cancel: () => void;
  readonly newSession: () => void;
  readonly selectSession: (contextId: string) => void;
  readonly deleteSession: (contextId: string) => Promise<void>;
};

type LiveSessions = Readonly<Record<string, ChatSession>>;

const emptySession = (contextId: string, at: number): ChatSession => ({
  contextId,
  serverId: undefined,
  title: DEFAULT_SESSION_TITLE,
  messages: [],
  taskId: undefined,
  taskState: undefined,
  createdAt: at,
  updatedAt: at,
});

const sortSessions = (sessions: Iterable<ChatSession>): ReadonlyArray<ChatSession> =>
  [...sessions].sort((left, right) => right.updatedAt - left.updatedAt);

const connectionFromQuery = (query: {
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly data: { readonly agentName: string } | undefined;
}): ConnectionState => {
  if (query.isPending) return { status: 'connecting' };
  if (query.error || !query.data) {
    return { status: 'error', message: toErrorMessage(query.error, 'Could not reach the agent') };
  }
  return { status: 'connected', agentName: query.data.agentName };
};

/**
 * Owns one A2A conversation surface: the connection to an agent URL, the list
 * of sessions (persisted ones from the server merged with in-flight local ones)
 * and the streaming of a turn. Rendering is left entirely to the components.
 */
function useChatController({
  url,
  persistence,
}: {
  readonly url: string;
  readonly persistence: ChatPersistence | undefined;
}): ChatController {
  const queryClient = useQueryClient();
  const [live, setLive] = useState<LiveSessions>({});
  const [activeContextId, setActiveContextId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [streamingContextIds, setStreamingContextIds] = useState<ReadonlySet<string>>(new Set());
  const abortControllers = useRef(new Map<string, AbortController>());

  const clientQuery = useQuery({
    queryKey: ['a2a-client', url],
    queryFn: async () => {
      // The trailing slash makes the default agent-card path resolve under the a2a url.
      const client = await factory.createFromUrl(`${url}/`);
      const card = await client.getAgentCard();
      return { client, agentName: card.name };
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });

  const sessionsKey = useMemo(() => queryKeys.chatSessions(url), [url]);
  const persistedQuery = useQuery({
    queryKey: sessionsKey,
    queryFn: () => (persistence ? persistence.load() : Promise.resolve<ReadonlyArray<ChatSession>>([])),
  });
  const persisted = persistedQuery.data;

  // Drop local copies the server has caught up with so there is one source of truth per session.
  useEffect(() => {
    if (!persisted) return;
    setLive((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([contextId, local]) => {
          const remote = persisted.find((session) => session.contextId === contextId);
          return !(remote && persistedCoversLocal(remote, local));
        }),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [persisted]);

  const sessionsByContext = useMemo(() => {
    const merged = new Map<string, ChatSession>();
    for (const session of persisted ?? []) merged.set(session.contextId, session);
    for (const session of Object.values(live)) {
      const remote = merged.get(session.contextId);
      merged.set(session.contextId, remote ? { ...session, serverId: session.serverId ?? remote.serverId } : session);
    }
    return merged;
  }, [live, persisted]);

  const sessions = useMemo(
    () => sortSessions([...sessionsByContext.values()].filter((session) => session.messages.length > 0)),
    [sessionsByContext],
  );

  const activeSession = activeContextId === null ? undefined : sessionsByContext.get(activeContextId);

  const updateLive = useCallback((contextId: string, update: (session: ChatSession) => ChatSession) => {
    setLive((current) => {
      const existing = current[contextId];
      if (!existing) return current;
      return { ...current, [contextId]: update(existing) };
    });
  }, []);

  const markStreaming = useCallback((contextId: string, streaming: boolean) => {
    setStreamingContextIds((current) => {
      const next = new Set(current);
      if (streaming) next.add(contextId);
      else next.delete(contextId);
      return next;
    });
  }, []);

  const runTurn = useCallback(
    async (client: Client, contextId: string, initial: AssistantMessage, params: MessageSendParams) => {
      const controller = new AbortController();
      abortControllers.current.set(contextId, controller);
      markStreaming(contextId, true);

      // The turn's authoritative copy lives here; React state only mirrors it.
      let message = initial;
      let taskId: string | undefined;
      let done = false;

      const publish = (at: number) => {
        const snapshot = message;
        updateLive(contextId, (current) => ({
          ...replaceAssistantMessage(current, snapshot),
          taskId: snapshot.taskId ?? current.taskId,
          taskState: snapshot.state,
          updatedAt: at,
        }));
      };

      const fold = (event: StreamEvent) => {
        const at = now();
        const update = applyStreamEvent(message, event, at, uuid());
        message = update.message;
        taskId = update.taskId ?? taskId;
        done = update.done;
        publish(at);
      };

      const fail = (error: string) => {
        const at = now();
        message = finishTurn(message, 'failed', error, at);
        publish(at);
      };

      const consume = async (stream: AsyncIterable<StreamEvent>) => {
        for await (const event of stream) {
          if (controller.signal.aborted) return;
          fold(event);
          if (done) return;
        }
      };

      try {
        try {
          await consume(client.sendMessageStream(params, { signal: controller.signal }));
        } catch (error) {
          if (controller.signal.aborted) return;
          if (taskId === undefined) throw error;
        }
        // The stream can drop before the task settles (proxy timeouts, network blips); re-attach to the task.
        for (let attempt = 0; attempt < RESUBSCRIBE_ATTEMPTS && !done && taskId !== undefined; attempt += 1) {
          if (controller.signal.aborted) return;
          try {
            await consume(client.resubscribeTask({ id: taskId }, { signal: controller.signal }));
          } catch {
            // fall through to the task snapshot below
          }
          if (!done) {
            try {
              fold(await client.getTask({ id: taskId }));
            } catch {
              // task lookup is best-effort
            }
          }
          if (!done) await delay(RESUBSCRIBE_DELAY_MS);
        }
        if (!done && !controller.signal.aborted) fail('Lost connection to the agent');
      } catch (error) {
        if (!controller.signal.aborted) fail(toErrorMessage(error, 'Failed to send the message'));
      } finally {
        if (abortControllers.current.get(contextId) === controller) abortControllers.current.delete(contextId);
        markStreaming(contextId, false);
        await queryClient.invalidateQueries({ queryKey: sessionsKey });
      }
    },
    [markStreaming, queryClient, sessionsKey, updateLive],
  );

  const send = useCallback(
    (textOverride?: string) => {
      const text = (textOverride ?? input).trim();
      const client = clientQuery.data?.client;
      if (text.length === 0 || !client) return;

      const at = now();
      const base = activeSession ?? emptySession(uuid(), at);
      if (streamingContextIds.has(base.contextId)) return;

      const userId = uuid();
      const resumeTaskId = base.taskState === 'input-required' ? base.taskId : undefined;
      const assistant: AssistantMessage = {
        id: uuid(),
        role: 'assistant',
        text: '',
        state: 'submitted',
        working: true,
        error: undefined,
        timeline: [],
        startedAt: at,
        finishedAt: undefined,
        taskId: undefined,
      };
      const session: ChatSession = {
        ...base,
        title: base.messages.length === 0 ? sessionTitleFromText(text) : base.title,
        messages: [...base.messages, { id: userId, role: 'user', text, createdAt: at }, assistant],
        updatedAt: at,
      };

      setLive((current) => ({ ...current, [session.contextId]: session }));
      setActiveContextId(session.contextId);
      if (textOverride === undefined) setInput('');

      void runTurn(client, session.contextId, assistant, {
        configuration: { blocking: false },
        message: {
          kind: 'message',
          messageId: userId,
          role: 'user',
          contextId: session.contextId,
          taskId: resumeTaskId,
          parts: [{ kind: 'text', text }],
        },
      });
    },
    [activeSession, clientQuery.data, input, runTurn, streamingContextIds],
  );

  const cancel = useCallback(() => {
    if (!activeSession) return;
    const contextId = activeSession.contextId;
    abortControllers.current.get(contextId)?.abort();
    abortControllers.current.delete(contextId);
    const at = now();
    updateLive(contextId, (current) => ({
      ...current,
      messages: current.messages.map((message) =>
        message.role === 'assistant' && message.working ? finishTurn(message, 'canceled', undefined, at) : message,
      ),
      taskState: 'canceled',
    }));
    const client = clientQuery.data?.client;
    const taskId = activeSession.taskId;
    if (client && taskId && !isTerminalState(activeSession.taskState ?? '')) {
      void client.cancelTask({ id: taskId }).catch(() => undefined);
    }
  }, [activeSession, clientQuery.data, updateLive]);

  const newSession = useCallback(() => {
    setActiveContextId(null);
    setInput('');
  }, []);

  const selectSession = useCallback((contextId: string) => {
    setActiveContextId(contextId);
  }, []);

  const deleteSession = useCallback(
    async (contextId: string) => {
      const session = sessionsByContext.get(contextId);
      abortControllers.current.get(contextId)?.abort();
      setLive((current) => {
        const { [contextId]: _removed, ...rest } = current;
        return rest;
      });
      if (activeContextId === contextId) setActiveContextId(null);
      if (session?.serverId && persistence) {
        await persistence.remove(session.serverId);
        await queryClient.invalidateQueries({ queryKey: sessionsKey });
      }
    },
    [activeContextId, persistence, queryClient, sessionsByContext, sessionsKey],
  );

  useEffect(() => {
    const controllers = abortControllers.current;
    return () => {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    };
  }, []);

  return {
    connection: connectionFromQuery(clientQuery),
    sessionsLoading: persistedQuery.isPending,
    sessionsError: persistedQuery.isError
      ? toErrorMessage(persistedQuery.error, 'Could not load conversations.')
      : null,
    sessions,
    activeSession,
    isStreaming: activeSession !== undefined && streamingContextIds.has(activeSession.contextId),
    input,
    setInput,
    send,
    cancel,
    newSession,
    selectSession,
    deleteSession,
  };
}

const ChatContext = createContext<ChatController | null>(null);

export function ChatProvider({
  url,
  persistence,
  children,
}: {
  readonly url: string;
  readonly persistence: ChatPersistence | undefined;
  readonly children: ReactNode;
}) {
  const controller = useChatController({ url, persistence });
  return <ChatContext.Provider value={controller}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatController {
  const controller = useContext(ChatContext);
  if (!controller) throw new Error('useChat must be used inside <ChatProvider>');
  return controller;
}
