import type { Message } from '@a2a-js/sdk';

export type AgentGenerationMessage = {
  readonly role: 'user' | 'assistant';
  readonly content: string;
};

export type ContextHistoryStore = Map<string, ReadonlyArray<Message>>;

const textFromMessage = (message: Message): string =>
  message.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n');

const toGenerationMessage = (message: Message): AgentGenerationMessage | null => {
  const content = textFromMessage(message);

  if (content.length === 0) {
    return null;
  }

  return {
    role: message.role === 'agent' ? 'assistant' : 'user',
    content,
  };
};

export const addToContextHistory = (store: ContextHistoryStore, contextId: string, message: Message): void => {
  store.set(contextId, [...(store.get(contextId) ?? []), message]);
};

export const buildGenerationMessages = (
  store: ContextHistoryStore,
  contextId: string,
  taskHistory: ReadonlyArray<Message>,
  userMessage: Message,
): ReadonlyArray<AgentGenerationMessage> =>
  [...(store.get(contextId) ?? []), ...taskHistory, userMessage].flatMap((message) => {
    const generationMessage = toGenerationMessage(message);

    return generationMessage ? [generationMessage] : [];
  });
