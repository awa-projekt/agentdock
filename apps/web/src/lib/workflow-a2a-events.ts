import {
  AgentCallProgressState,
  AgentCallProgressStatePrefix,
  AgentLoopProgressState,
  isJsonObject,
  type Json,
  type JsonObject,
  jsonNumber,
  jsonProperty,
  jsonString,
  ModelCallProgressState,
  ModelTokenProgressState,
  renderJson,
  ToolCallProgressState,
  type WorkflowRunEvent,
} from 'agentdock-sdk/schemas';

/**
 * What happens inside a step, as its progress events report it: the A2A
 * exchange with a called agent, a bound agent's own tool calls and subagents,
 * the model calls with their usage, and the calls of bound tools.
 */
export type StepActivityEvent = Extract<WorkflowRunEvent, { type: 'step-progress' }>;

export type A2AStatusDetail =
  | { readonly kind: 'reasoning'; readonly text: string }
  | {
      readonly kind: 'tool-call';
      readonly toolName: string;
      readonly toolCallId: string;
      readonly input: Json | undefined;
    }
  | {
      readonly kind: 'tool-result';
      readonly toolName: string;
      readonly toolCallId: string;
      readonly output: Json | undefined;
    }
  | { readonly kind: 'tool-error'; readonly toolName: string; readonly toolCallId: string; readonly error: string };

export type ToolDetail = Exclude<A2AStatusDetail, { readonly kind: 'reasoning' }>;

export type A2ATimelineItem =
  | {
      readonly kind: 'sent';
      readonly id: string;
      readonly timestamp: string;
      readonly message: string;
    }
  | {
      readonly kind: 'status';
      readonly id: string;
      readonly timestamp: string;
      readonly eventState: string;
      readonly taskState: string;
      readonly detail?: A2AStatusDetail | undefined;
    }
  | {
      readonly kind: 'message';
      readonly id: string;
      readonly timestamp: string;
      readonly text: string;
    }
  | { readonly kind: 'tool'; readonly id: string; readonly timestamp: string; readonly detail: ToolDetail }
  | {
      readonly kind: 'model-call';
      readonly id: string;
      readonly timestamp: string;
      /** The bound agent or the manifest name of the bound model that made the call. */
      readonly caller: string;
      readonly model: string;
      readonly inputTokens: number | undefined;
      readonly outputTokens: number | undefined;
      readonly toolCalls: number;
    }
  | {
      /** A `send_task` subagent of a bound agent, folded into one row as its reports arrive. */
      readonly kind: 'subagent';
      readonly id: string;
      readonly timestamp: string;
      readonly taskId: string;
      readonly agent: string;
      readonly state: string;
      readonly text: string;
      readonly toolCalls: number;
    };

export type StepActivityModel = {
  readonly rawEvents: ReadonlyArray<StepActivityEvent>;
  readonly rawEventCount: number;
  readonly items: ReadonlyArray<A2ATimelineItem>;
  readonly streamedText: string;
  /** The called agent's task state, when the step called one over A2A. */
  readonly state: string | null;
  readonly agentId: string | null;
};

const dataString = (data: JsonObject, key: string): string => jsonString(data, key) ?? '';

const dataBoolean = (data: JsonObject, key: string): boolean => data[key] === true;

const progressText = (event: StepActivityEvent): string =>
  dataString(event.data, 'text') || dataString(event.data, 'message');

/**
 * Internal agent-call status updates nest a structured payload under
 * `data.data` (see `callInternalAgent` in packages/sdk/src/workflows/agent-invoker.ts),
 * distinguishing reasoning/tool-call/tool-result/tool-error ticks that would
 * otherwise all look like the same generic `a2a-status: working` event.
 */
const statusDetail = (event: StepActivityEvent): A2AStatusDetail | undefined => {
  const nested = event.data.data;
  if (!isJsonObject(nested)) {
    return undefined;
  }
  return loopEventDetail(nested);
};

/** A tool call, its result or error, or a reasoning chunk, as an agent loop reports it. */
const loopEventDetail = (nested: JsonObject): A2AStatusDetail | undefined => {
  const toolName = jsonString(nested, 'toolName');
  const toolCallId = jsonString(nested, 'toolCallId');
  switch (jsonString(nested, 'type')) {
    case 'reasoning': {
      const text = jsonString(nested, 'text');
      return text === undefined ? undefined : { kind: 'reasoning', text };
    }
    case 'tool-call':
      return toolName && toolCallId ? { kind: 'tool-call', toolName, toolCallId, input: nested.input } : undefined;
    case 'tool-result':
      return toolName && toolCallId ? { kind: 'tool-result', toolName, toolCallId, output: nested.output } : undefined;
    case 'tool-error':
      return toolName && toolCallId
        ? { kind: 'tool-error', toolName, toolCallId, error: renderJson(nested.error) }
        : undefined;
    default:
      return undefined;
  }
};

const statusDetailKey = (detail: A2AStatusDetail): string =>
  detail.kind === 'reasoning' ? `reasoning:${detail.text}` : `${detail.kind}:${detail.toolCallId}`;

/**
 * Only genuinely redundant items collapse (e.g. repeated "working" heartbeat
 * pings with no distinguishing payload). Anything with a `detail` — a distinct
 * reasoning chunk, tool call, or tool result — always gets its own key so it
 * renders as its own row instead of overwriting the previous one.
 */
const itemKey = (item: A2ATimelineItem): string => {
  switch (item.kind) {
    case 'status':
      return `${item.kind}:${item.eventState}:${item.taskState}:${item.detail ? statusDetailKey(item.detail) : ''}`;
    case 'message':
      return `${item.kind}:${item.text}`;
    case 'sent':
      return item.kind;
    default:
      return `${item.kind}:${item.id}`;
  }
};

const A2A_PROGRESS_STATES: ReadonlySet<string> = new Set(Object.values(AgentCallProgressState));
const STEP_ACTIVITY_STATES: ReadonlySet<string> = new Set([
  ...A2A_PROGRESS_STATES,
  ...Object.values(AgentLoopProgressState),
  ...Object.values(ToolCallProgressState),
  ModelCallProgressState,
  ModelTokenProgressState,
]);

export const isStepActivityEvent = (event: WorkflowRunEvent): event is StepActivityEvent =>
  event.type === 'step-progress' && STEP_ACTIVITY_STATES.has(event.state);

/** A bound tool's events name the tool but carry no call id; a step calls its tools one after the other. */
const boundToolDetail = (event: StepActivityEvent, toolCallId: string): ToolDetail | undefined => {
  const toolName = jsonString(event.data, 'name') ?? 'tool';
  switch (event.state) {
    case ToolCallProgressState.Call:
      return { kind: 'tool-call', toolName, toolCallId, input: event.data.input };
    case ToolCallProgressState.Result:
      return { kind: 'tool-result', toolName, toolCallId, output: event.data.output };
    case ToolCallProgressState.Error:
      return { kind: 'tool-error', toolName, toolCallId, error: renderJson(event.data.error) };
    default:
      return undefined;
  }
};

const modelCallItem = (event: StepActivityEvent): A2ATimelineItem => {
  const usage = jsonProperty(event.data, 'usage');
  return {
    kind: 'model-call',
    id: event.id,
    timestamp: event.timestamp,
    caller: jsonString(event.data, 'agentId') ?? jsonString(event.data, 'modelName') ?? 'model',
    model: dataString(event.data, 'model'),
    inputTokens: jsonNumber(usage, 'input'),
    outputTokens: jsonNumber(usage, 'output'),
    toolCalls: jsonNumber(event.data, 'toolCalls') ?? 0,
  };
};

/** Unwraps a relay nested by deeper delegations down to the subagent's own event. */
const innermostRelayedEvent = (event: Json | undefined): Json | undefined =>
  jsonString(event, 'type') === 'send-task-progress' ? innermostRelayedEvent(jsonProperty(event, 'event')) : event;

const a2aTaskState = (event: StepActivityEvent): string =>
  dataString(event.data, 'taskState') ||
  dataString(event.data, 'state') ||
  event.state.replace(new RegExp(`^${AgentCallProgressStatePrefix}`), '');

export const buildStepActivityModel = (events: ReadonlyArray<StepActivityEvent>): StepActivityModel => {
  let artifactText = '';
  let latestMessageText = '';
  let tokenText = '';
  let state: string | null = null;
  let agentId: string | null = null;
  const items: A2ATimelineItem[] = [];
  const subagents = new Map<string, number>();
  const boundCalls = new Map<string, string>();

  const pushItem = (item: A2ATimelineItem) => {
    const previous = items.at(-1);
    if (previous && itemKey(previous) === itemKey(item)) {
      items[items.length - 1] = item;
      return;
    }
    items.push(item);
  };

  for (const event of events) {
    agentId ??= dataString(event.data, 'agentId') || null;

    switch (event.state) {
      case ModelCallProgressState:
        pushItem(modelCallItem(event));
        continue;
      case ModelTokenProgressState:
        tokenText += dataString(event.data, 'text');
        continue;
      case AgentLoopProgressState.ToolCall:
      case AgentLoopProgressState.ToolResult:
      case AgentLoopProgressState.ToolError: {
        const detail = loopEventDetail(event.data);
        if (detail !== undefined && detail.kind !== 'reasoning') {
          pushItem({ kind: 'tool', id: event.id, timestamp: event.timestamp, detail });
        }
        continue;
      }
      case ToolCallProgressState.Call:
      case ToolCallProgressState.Result:
      case ToolCallProgressState.Error: {
        const toolName = dataString(event.data, 'name');
        const toolCallId = boundCalls.get(toolName) ?? event.id;
        if (event.state === ToolCallProgressState.Call) boundCalls.set(toolName, event.id);
        else boundCalls.delete(toolName);
        const detail = boundToolDetail(event, toolCallId);
        if (detail !== undefined) pushItem({ kind: 'tool', id: event.id, timestamp: event.timestamp, detail });
        continue;
      }
      case AgentLoopProgressState.Delegation: {
        const relay = jsonProperty(event.data, 'event');
        const taskId = jsonString(relay, 'taskId');
        if (taskId === undefined) continue;
        const index = subagents.get(taskId);
        const previous = index === undefined ? undefined : items[index];
        const known = previous?.kind === 'subagent' ? previous : undefined;
        const relayed = innermostRelayedEvent(jsonProperty(relay, 'event'));
        const relayedType = jsonString(relayed, 'type');
        const item: A2ATimelineItem = {
          kind: 'subagent',
          id: known?.id ?? event.id,
          timestamp: event.timestamp,
          taskId,
          agent: jsonString(relay, 'agentName') ?? jsonString(relay, 'agentId') ?? known?.agent ?? 'subagent',
          state: jsonString(relay, 'state') ?? known?.state ?? 'working',
          text: jsonString(relay, 'text') ?? known?.text ?? '',
          toolCalls: (known?.toolCalls ?? 0) + (relayedType === 'tool-call' ? 1 : 0),
        };
        if (index === undefined) {
          subagents.set(taskId, items.length);
          items.push(item);
        } else {
          items[index] = item;
        }
        continue;
      }
      default:
        break;
    }

    // A streamed chunk says nothing about the task's state, and a bound agent's carry none.
    if (event.state === AgentCallProgressState.Artifact) {
      artifactText += progressText(event);
      continue;
    }

    state = a2aTaskState(event);

    if (event.state === AgentCallProgressState.Send) {
      pushItem({ kind: 'sent', id: event.id, timestamp: event.timestamp, message: dataString(event.data, 'message') });
      continue;
    }

    if (event.state === AgentCallProgressState.Message) {
      const text = progressText(event);
      if (text) {
        latestMessageText = text;
        pushItem({ kind: 'message', id: event.id, timestamp: event.timestamp, text });
      }
      continue;
    }

    if (event.state === AgentCallProgressState.Status) {
      const text = progressText(event);
      if (text && dataBoolean(event.data, 'final')) {
        latestMessageText = text;
      }
    }

    pushItem({
      kind: 'status',
      id: event.id,
      timestamp: event.timestamp,
      eventState: event.state,
      taskState: a2aTaskState(event),
      detail: statusDetail(event),
    });
  }

  return {
    rawEvents: events,
    rawEventCount: events.length,
    items,
    streamedText: artifactText || latestMessageText || tokenText,
    state,
    agentId,
  };
};
