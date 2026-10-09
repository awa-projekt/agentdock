import type { Session, SessionMessage } from 'agentdock-sdk/schemas';
import { appendTimelineData, dataFromPersistedEvent } from './events';
import {
  type AssistantMessage,
  type ChatMessage,
  type ChatSession,
  humanizeTaskState,
  isAssistantMessage,
  isTerminalState,
  type TimelineItem,
  type UserMessage,
} from './model';

export type ChatPersistence = {
  readonly load: () => Promise<ReadonlyArray<ChatSession>>;
  readonly remove: (serverId: string) => Promise<void>;
};

/** Server statuses are humanized ("Input Required"); map them back to protocol states. */
const stateFromStatus = (status: string | undefined): string =>
  status === undefined ? 'completed' : status.trim().toLowerCase().replace(/\s+/g, '-');

const timelineFromEvents = (message: SessionMessage): ReadonlyArray<TimelineItem> =>
  (message.events ?? []).reduce<ReadonlyArray<TimelineItem>>((items, event) => {
    const data = dataFromPersistedEvent(event.rawEvent);
    return data ? appendTimelineData(items, { data, at: event.at, id: event.id }) : items;
  }, []);

const toAssistantMessage = (message: SessionMessage, fallbackAt: number): AssistantMessage => {
  const state = stateFromStatus(message.status);
  // The status history brackets the run (submitted … completed); message timestamps only mark the answer.
  const at = message.statusHistory?.at(0)?.at ?? message.events?.at(0)?.at ?? message.createdAt ?? fallbackAt;
  const finishedAt = message.statusHistory?.at(-1)?.at ?? message.createdAt ?? message.events?.at(-1)?.at ?? at;
  const failed = state === 'failed' || state === 'rejected';
  return {
    id: message.id,
    role: 'assistant',
    text: failed ? '' : message.text,
    state,
    working: false,
    error: failed ? message.text || humanizeTaskState(state) : undefined,
    timeline: timelineFromEvents(message),
    startedAt: at,
    finishedAt,
    taskId: undefined,
  };
};

const toUserMessage = (message: SessionMessage, fallbackAt: number): UserMessage => ({
  id: message.id,
  role: 'user',
  text: message.text,
  createdAt: message.createdAt ?? fallbackAt,
});

/**
 * The server stores every agent text message as its own assistant row. In the
 * chat, one user message has one assistant turn: earlier texts become steps in
 * its trail (in order with their tool events) and the last text is the answer.
 */
const foldTurns = (messages: ReadonlyArray<SessionMessage>, fallbackAt: number): ReadonlyArray<ChatMessage> => {
  const folded: Array<ChatMessage> = [];
  for (const message of messages) {
    const previous = folded.at(-1);
    if (message.role !== 'assistant' || !previous || previous.role !== 'assistant') {
      folded.push(
        message.role === 'assistant' ? toAssistantMessage(message, fallbackAt) : toUserMessage(message, fallbackAt),
      );
      continue;
    }
    const current = toAssistantMessage(message, fallbackAt);
    const interim: ReadonlyArray<TimelineItem> =
      previous.text.length > 0
        ? [
            {
              kind: 'text',
              id: `${previous.id}:text`,
              at: previous.finishedAt ?? previous.startedAt,
              text: previous.text,
            },
          ]
        : [];
    folded[folded.length - 1] = {
      ...current,
      timeline: [...previous.timeline, ...interim, ...current.timeline],
      startedAt: Math.min(previous.startedAt, current.startedAt),
    };
  }
  return folded;
};

export const toChatSession = (session: Session): ChatSession => {
  const lastAssistant = [...session.messages].reverse().find((message) => message.role === 'assistant');
  const taskState = lastAssistant ? stateFromStatus(lastAssistant.status) : undefined;
  return {
    contextId: session.conversationState.contextId,
    serverId: session.id,
    title: session.title,
    messages: foldTurns(session.messages, session.updatedAt),
    taskId: session.conversationState.taskId,
    taskState,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
};

/**
 * Whether the persisted copy of a session already reflects everything the local
 * copy knows about, so the local copy can be dropped without losing a turn.
 */
export const persistedCoversLocal = (persisted: ChatSession, local: ChatSession): boolean => {
  const lastLocalUser = [...local.messages].reverse().find((message) => message.role === 'user');
  if (!lastLocalUser) return true;
  const lastLocalAssistant = [...local.messages].reverse().find(isAssistantMessage);
  if (lastLocalAssistant && (lastLocalAssistant.working || !isTerminalState(lastLocalAssistant.state))) return false;
  const userIndex = persisted.messages.findIndex((message) => message.id === lastLocalUser.id);
  if (userIndex < 0) return false;
  const persistedAssistant = persisted.messages.slice(userIndex + 1).find(isAssistantMessage);
  // Persistence of the final answer trails the stream slightly; wait for it unless the run had none.
  return persistedAssistant !== undefined || lastLocalAssistant === undefined || lastLocalAssistant.text.length === 0;
};
