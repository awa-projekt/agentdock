import type { Json, JsonObject } from 'agentdock-sdk/schemas';

/**
 * One step in an assistant turn's activity trail. Every variant is derived from
 * the `data` parts the agent publishes on A2A status updates (see
 * packages/sdk/src/a2a/executor.ts) or, for subagents, from the
 * `send-task-progress` relays in packages/api/src/agents/runtime-layers.ts.
 */
export type TimelineItem =
  | { readonly kind: 'reasoning'; readonly id: string; readonly at: number; readonly text: string }
  | {
      readonly kind: 'tool-call';
      readonly id: string;
      readonly at: number;
      readonly toolName: string;
      readonly toolCallId: string;
      readonly input: Json | undefined;
    }
  | {
      readonly kind: 'tool-result';
      readonly id: string;
      readonly at: number;
      readonly toolName: string;
      readonly toolCallId: string;
      readonly output: Json | undefined;
      readonly error: string | undefined;
    }
  /**
   * One `send_task` delegation: the call, the relayed progress and the result
   * folded into a single step so the trail reads as one conversation with the
   * subagent.
   */
  | {
      readonly kind: 'subagent';
      readonly id: string;
      readonly at: number;
      readonly toolCallId: string | undefined;
      readonly agentId: string | undefined;
      readonly agentName: string | undefined;
      /** The task text the caller sent along. */
      readonly prompt: string | undefined;
      /** The subagent's A2A task, once the first progress relay names it. */
      readonly taskId: string | undefined;
      readonly url: string | undefined;
      readonly state: string;
      /** The subagent's answer, once it reported one. */
      readonly text: string | undefined;
      readonly error: string | undefined;
      /** The subagent's own activity, recursively grouped. */
      readonly items: ReadonlyArray<TimelineItem>;
    }
  | { readonly kind: 'input-required'; readonly id: string; readonly at: number; readonly request: JsonObject }
  /** Assistant text written before a tool call; the final answer stays on the message itself. */
  | { readonly kind: 'text'; readonly id: string; readonly at: number; readonly text: string };

export type UserMessage = {
  readonly id: string;
  readonly role: 'user';
  readonly text: string;
  readonly createdAt: number;
};

export type AssistantMessage = {
  readonly id: string;
  readonly role: 'assistant';
  readonly text: string;
  /** Raw A2A task state ("working", "completed", "input-required", …). */
  readonly state: string;
  readonly working: boolean;
  /** Set when the run ended in a `failed`/`rejected` state; `text` then holds the harness error. */
  readonly error: string | undefined;
  readonly timeline: ReadonlyArray<TimelineItem>;
  readonly startedAt: number;
  readonly finishedAt: number | undefined;
  /** The A2A task this turn belongs to, once known. */
  readonly taskId: string | undefined;
};

export type ChatMessage = UserMessage | AssistantMessage;

export type ChatSession = {
  /** The A2A context id. Generated client-side so it is stable before the server knows the session. */
  readonly contextId: string;
  /** The server's session id, once the session has been persisted. Needed to delete it. */
  readonly serverId: string | undefined;
  readonly title: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  /** The most recent task in this context, used to resume `input-required` turns. */
  readonly taskId: string | undefined;
  readonly taskState: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type ConnectionState =
  | { readonly status: 'connecting' }
  | { readonly status: 'connected'; readonly agentName: string }
  | { readonly status: 'error'; readonly message: string };

const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'canceled', 'rejected']);

export const isTerminalState = (state: string): boolean => TERMINAL_TASK_STATES.has(state);

export const isErrorState = (state: string): boolean => state === 'failed' || state === 'rejected';

/** "input-required" → "Input required". */
export const humanizeTaskState = (state: string): string => {
  const words = state.split(/[-_\s]+/).filter((token) => token.length > 0);
  const [first, ...rest] = words;
  if (first === undefined) return '';
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
};

export const DEFAULT_SESSION_TITLE = 'New chat';

export const sessionTitleFromText = (text: string): string => {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (normalized.length === 0) return DEFAULT_SESSION_TITLE;
  return normalized.length > 48 ? `${normalized.slice(0, 47)}…` : normalized;
};

export const isAssistantMessage = (message: ChatMessage): message is AssistantMessage => message.role === 'assistant';
