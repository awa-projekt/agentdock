import type { Message, Part, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import {
  coerceJson,
  decodeJsonStringOption,
  isJsonArray,
  isJsonObject,
  isJsonString,
  type Json,
  type JsonObject,
  jsonProperty,
  jsonString,
} from 'agentdock-sdk/schemas';
import * as Option from 'effect/Option';
import { isTerminalState, type TimelineItem } from './model';

/** The event union an A2A client stream yields; the SDK keeps the alias internal. */
export type StreamEvent = Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

export const textFromParts = (parts: ReadonlyArray<Part> | undefined): string =>
  (parts ?? []).flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('');

/** The first `data` part of a message, as JSON. */
export const dataFromMessage = (message: Message | undefined): JsonObject | undefined => {
  for (const part of message?.parts ?? []) {
    if (part.kind !== 'data') continue;
    const data = coerceJson(part.data);
    if (isJsonObject(data)) return data;
  }
  return undefined;
};

/** Same as {@link dataFromMessage} but over an untyped persisted message payload. */
const dataFromJsonMessage = (message: Json | undefined): JsonObject | undefined => {
  const parts = jsonProperty(message, 'parts');
  if (!isJsonArray(parts)) return undefined;
  for (const part of parts) {
    const kind = jsonProperty(part, 'kind');
    const data = jsonProperty(part, 'data');
    if ((kind === 'data' || kind === undefined) && isJsonObject(data)) return data;
  }
  return undefined;
};

/** The subagent's own data part relayed inside a `send-task-progress` part. */
const nestedDataFromProgress = (progress: JsonObject): JsonObject | undefined => {
  const event = jsonProperty(progress, 'event');
  return isJsonObject(event) ? event : undefined;
};

/** Persisted timeline events wrap the data part as a synthetic status-update; unwrap it. */
export const dataFromPersistedEvent = (rawEvent: Json | undefined): JsonObject | undefined => {
  if (!isJsonObject(rawEvent)) return undefined;
  if (rawEvent.kind === 'status-update') {
    return dataFromJsonMessage(jsonProperty(rawEvent.status, 'message'));
  }
  if (rawEvent.kind === 'task' && isJsonArray(rawEvent.history)) {
    for (const message of [...rawEvent.history].reverse()) {
      const data = dataFromJsonMessage(message);
      if (data) return data;
    }
  }
  return jsonString(rawEvent, 'type') === undefined ? undefined : rawEvent;
};

type ItemInput = { readonly data: JsonObject; readonly at: number; readonly id: string };

const joinReasoning = (previous: string, next: string): string => {
  if (previous.length === 0) return next;
  if (next.length === 0) return previous;
  const needsBreak = !/\s$/.test(previous) && !/^\s/.test(next);
  return needsBreak ? `${previous}\n${next}` : `${previous}${next}`;
};

const replaceAt = <T>(items: ReadonlyArray<T>, index: number, item: T): ReadonlyArray<T> => [
  ...items.slice(0, index),
  item,
  ...items.slice(index + 1),
];

type SubagentItem = Extract<TimelineItem, { kind: 'subagent' }>;

const isSubagent = (item: TimelineItem): item is SubagentItem => item.kind === 'subagent';

const shortToolName = (toolName: string): string => toolName.split(/[.:/]/).pop() ?? toolName;

const isSendTask = (data: JsonObject): boolean => shortToolName(jsonString(data, 'toolName') ?? '') === 'send_task';

/** Tool inputs sometimes arrive as a JSON string; expose the object when they do. */
const toolInputObject = (input: Json | undefined): JsonObject | undefined => {
  if (isJsonObject(input)) return input;
  if (!isJsonString(input)) return undefined;
  const parsed = Option.getOrUndefined(decodeJsonStringOption(input));
  return isJsonObject(parsed) ? parsed : undefined;
};

const findSubagentIndex = (items: ReadonlyArray<TimelineItem>, match: (item: SubagentItem) => boolean): number =>
  items.findIndex((item) => isSubagent(item) && match(item));

/**
 * Which pending delegation a progress relay belongs to. The relay names the
 * task, not the tool call, so the first relay for a task attaches to the
 * earliest call that has no task yet, preferring one aimed at the same agent.
 */
const progressTargetIndex = (items: ReadonlyArray<TimelineItem>, taskId: string, agentId: string | undefined) => {
  const byTask = findSubagentIndex(items, (item) => item.taskId === taskId);
  if (byTask >= 0) return byTask;
  const byAgent =
    agentId === undefined
      ? -1
      : findSubagentIndex(items, (item) => item.taskId === undefined && item.agentId === agentId);
  if (byAgent >= 0) return byAgent;
  return findSubagentIndex(items, (item) => item.taskId === undefined);
};

/**
 * The loop reports the `send_task` call after the tool has already begun, so
 * its first progress relay may arrive first; the call then claims that
 * relay-created step instead of opening a second one.
 */
const startSubagent = (
  items: ReadonlyArray<TimelineItem>,
  { data, at, id }: ItemInput,
): ReadonlyArray<TimelineItem> => {
  const input = toolInputObject(jsonProperty(data, 'input'));
  const agentId = jsonString(input, 'agentId');
  const toolCallId = jsonString(data, 'toolCallId') ?? id;
  const prompt = jsonString(input, 'message');
  const index = findSubagentIndex(items, (item) => item.toolCallId === undefined && item.agentId === agentId);
  const existing = index >= 0 ? items[index] : undefined;
  if (existing && isSubagent(existing)) {
    return replaceAt(items, index, { ...existing, toolCallId, prompt });
  }
  return [
    ...items,
    {
      kind: 'subagent',
      id,
      at,
      toolCallId,
      agentId,
      agentName: undefined,
      prompt,
      taskId: undefined,
      url: undefined,
      state: 'submitted',
      text: undefined,
      error: undefined,
      items: [],
    },
  ];
};

const progressSubagent = (
  items: ReadonlyArray<TimelineItem>,
  { data, at, id }: ItemInput,
  taskId: string,
): ReadonlyArray<TimelineItem> => {
  const nested = nestedDataFromProgress(data);
  const agentId = jsonString(data, 'agentId');
  const index = progressTargetIndex(items, taskId, agentId);
  const existing = index >= 0 ? items[index] : undefined;
  const base: SubagentItem =
    existing && isSubagent(existing)
      ? existing
      : {
          kind: 'subagent',
          id,
          at,
          toolCallId: undefined,
          agentId: undefined,
          agentName: undefined,
          prompt: undefined,
          taskId,
          url: undefined,
          state: 'working',
          text: undefined,
          error: undefined,
          items: [],
        };
  const updated: SubagentItem = {
    ...base,
    taskId,
    agentId: base.agentId ?? agentId,
    agentName: base.agentName ?? jsonString(data, 'agentName'),
    url: base.url ?? jsonString(data, 'url'),
    state: jsonString(data, 'state') ?? base.state,
    text: jsonString(data, 'text') ?? base.text,
    items: nested ? appendTimelineData(base.items, { data: nested, at, id: `${id}:nested` }) : base.items,
  };
  return index >= 0 ? replaceAt(items, index, updated) : [...items, updated];
};

/** Fold the `send_task` result onto its delegation; falls back to a plain result step when the call is unknown. */
const finishSubagent = (
  items: ReadonlyArray<TimelineItem>,
  { data, id }: ItemInput,
  error: string | undefined,
): ReadonlyArray<TimelineItem> | undefined => {
  const toolCallId = jsonString(data, 'toolCallId') ?? id;
  const index = findSubagentIndex(items, (item) => item.toolCallId === toolCallId);
  const existing = index >= 0 ? items[index] : undefined;
  if (!existing || !isSubagent(existing)) return undefined;
  const output = jsonProperty(data, 'output');
  const text = jsonString(output, 'text');
  return replaceAt(items, index, {
    ...existing,
    state: error === undefined ? (jsonString(output, 'state') ?? 'completed') : 'failed',
    text: text !== undefined && text.length > 0 ? text : existing.text,
    error,
  });
};

/**
 * Fold one agent data part into an activity trail. Consecutive reasoning chunks
 * merge into a single step, and a `send_task` call, its relayed progress and
 * its result merge into one subagent step, so the UI renders one item per
 * logical step.
 */
export const appendTimelineData = (
  items: ReadonlyArray<TimelineItem>,
  input: ItemInput,
): ReadonlyArray<TimelineItem> => {
  const { data, at, id } = input;
  const type = jsonString(data, 'type');
  const last = items.at(-1);

  switch (type) {
    case 'reasoning':
    case 'thinking': {
      const text = jsonString(data, 'text') ?? '';
      if (text.trim().length === 0) return items;
      if (last?.kind === 'reasoning') {
        return replaceAt(items, items.length - 1, { ...last, text: joinReasoning(last.text, text) });
      }
      return [...items, { kind: 'reasoning', id, at, text }];
    }
    case 'tool-call':
      if (isSendTask(data)) return startSubagent(items, input);
      return [
        ...items,
        {
          kind: 'tool-call',
          id,
          at,
          toolName: jsonString(data, 'toolName') ?? 'tool',
          toolCallId: jsonString(data, 'toolCallId') ?? id,
          input: jsonProperty(data, 'input'),
        },
      ];
    case 'tool-result':
    case 'tool-error': {
      const error = type === 'tool-error' ? (jsonString(data, 'error') ?? 'Tool error') : undefined;
      if (isSendTask(data)) {
        const folded = finishSubagent(items, input, error);
        if (folded) return folded;
      }
      return [
        ...items,
        {
          kind: 'tool-result',
          id,
          at,
          toolName: jsonString(data, 'toolName') ?? 'tool',
          toolCallId: jsonString(data, 'toolCallId') ?? id,
          output: jsonProperty(data, 'output'),
          error,
        },
      ];
    }
    case 'send-task-progress': {
      const taskId = jsonString(data, 'taskId');
      return taskId === undefined ? items : progressSubagent(items, input, taskId);
    }
    default:
      return items;
  }
};

export const inputRequiredItem = ({ data, at, id }: ItemInput): TimelineItem => ({
  kind: 'input-required',
  id,
  at,
  request: data,
});

/** Human-readable label for the step the agent is currently on, for the activity header. */
export const describeTimelineItem = (item: TimelineItem): string => {
  switch (item.kind) {
    case 'reasoning':
      return 'Thinking';
    case 'tool-call':
      return `Calling ${item.toolName}`;
    case 'tool-result':
      return item.error ? `${item.toolName} failed` : `Finished ${item.toolName}`;
    case 'subagent':
      return `${subagentLabel(item)} ${item.state}`;
    case 'input-required':
      return 'Waiting for your input';
    case 'text':
      return 'Writing';
  }
};

/**
 * What a working turn is doing right now. The model is "thinking" whenever no
 * tool is in flight and no answer text has started, which also covers models
 * that never send reasoning summaries.
 */
export type LiveActivity = 'thinking' | 'tool' | 'subagent' | 'writing';

export const liveActivity = (timeline: ReadonlyArray<TimelineItem>, text: string): LiveActivity => {
  if (text.trim().length > 0) return 'writing';
  const last = timeline.at(-1);
  if (last?.kind === 'tool-call') return 'tool';
  if (last?.kind === 'subagent' && !isSubagentSettled(last)) return 'subagent';
  return 'thinking';
};

/** A delegation stops producing steps once it ends or waits for input its caller cannot provide. */
export const isSubagentSettled = (item: SubagentItem): boolean =>
  isTerminalState(item.state) || item.state === 'input-required';

/** Display name for a delegation: the relayed name, else the agent id, else the host it was sent to. */
export const subagentLabel = (item: SubagentItem): string => {
  if (item.agentName) return item.agentName;
  if (item.agentId) return item.agentId;
  if (item.url && URL.canParse(item.url)) return new URL(item.url).host;
  return 'Subagent';
};

/**
 * The delegations currently in flight, outermost first, ending with the step
 * the innermost agent is on. Empty while the top-level agent itself is active.
 */
export type SubagentChain = {
  /** Delegations in flight, outermost first. */
  readonly chain: ReadonlyArray<SubagentItem>;
  /** The step the innermost agent is on, if any. */
  readonly current: TimelineItem | undefined;
};

export const activeSubagentChain = (items: ReadonlyArray<TimelineItem>): SubagentChain => {
  const chain: Array<SubagentItem> = [];
  let current = items.at(-1);
  while (current && isSubagent(current) && !isSubagentSettled(current)) {
    chain.push(current);
    current = current.items.at(-1);
  }
  return { chain, current };
};

/** Total number of steps including nested subagent steps. */
export const countTimelineSteps = (items: ReadonlyArray<TimelineItem>): number =>
  items.reduce((total, item) => total + 1 + (item.kind === 'subagent' ? countTimelineSteps(item.items) : 0), 0);

export const countSubagents = (items: ReadonlyArray<TimelineItem>): number =>
  items.reduce((total, item) => total + (item.kind === 'subagent' ? 1 + countSubagents(item.items) : 0), 0);

/** How many nested delegation levels the trail reaches; 0 when no subagent was called. */
export const subagentDepth = (items: ReadonlyArray<TimelineItem>): number =>
  items.reduce((max, item) => (item.kind === 'subagent' ? Math.max(max, 1 + subagentDepth(item.items)) : max), 0);
