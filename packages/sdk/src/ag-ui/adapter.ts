import { z } from 'zod';
import type { AgentLoopEvent } from '../agents/loop';
import { isJsonString, type Json } from '../schemas/json';
import type { AgUiEvent, AgUiRunOutcome } from './types';
import { AgUiEventType } from './types';

export class AgUiEventAdapter {
  private textMessageId: string | undefined;
  private reasoningMessageId: string | undefined;
  private messageSequence = 0;

  constructor(
    private readonly threadId: string,
    private readonly runId: string,
  ) {}

  start(): AgUiEvent {
    return { type: AgUiEventType.RUN_STARTED, threadId: this.threadId, runId: this.runId };
  }

  handle(event: AgentLoopEvent): ReadonlyArray<AgUiEvent> {
    switch (event.type) {
      case 'text-delta':
        return this.textDelta(event.text);
      case 'reasoning':
        return this.reasoningDelta(event.text);
      case 'tool-call':
        return [
          ...this.closeTextMessage(),
          ...this.closeReasoningMessage(),
          { type: AgUiEventType.TOOL_CALL_START, toolCallId: event.toolCallId, toolCallName: event.toolName },
          {
            type: AgUiEventType.TOOL_CALL_ARGS,
            toolCallId: event.toolCallId,
            delta: JSON.stringify(event.input ?? {}),
          },
          { type: AgUiEventType.TOOL_CALL_END, toolCallId: event.toolCallId },
        ];
      case 'tool-result':
        return [
          {
            type: AgUiEventType.TOOL_CALL_RESULT,
            toolCallId: event.toolCallId,
            messageId: `${event.toolCallId}:result`,
            role: 'tool',
            content: isJsonString(event.output) ? event.output : JSON.stringify(event.output ?? null),
          },
        ];
      case 'tool-error':
        // AG-UI has no dedicated tool-error event; surface it as a custom
        // event so frontends can render failures without breaking the stream.
        return [
          {
            type: AgUiEventType.CUSTOM,
            name: 'tool_error',
            value: { toolCallId: event.toolCallId, toolName: event.toolName, error: event.error },
          },
        ];
      case 'finish':
      case 'model-call':
        // Usage/finish-reason ride on RUN_FINISHED metadata; nothing to emit now.
        return [];
    }
  }

  finish(outcome: AgUiRunOutcome): ReadonlyArray<AgUiEvent> {
    const closing = [...this.closeTextMessage(), ...this.closeReasoningMessage()];
    switch (outcome.status) {
      case 'completed':
        return [
          ...closing,
          {
            type: AgUiEventType.RUN_FINISHED,
            threadId: this.threadId,
            runId: this.runId,
            result: outcome.result,
            outcome: { type: 'success' },
          } satisfies AgUiEvent,
        ];
      case 'input-required':
        return [
          ...closing,
          {
            type: AgUiEventType.RUN_FINISHED,
            threadId: this.threadId,
            runId: this.runId,
            outcome: { type: 'interrupt', interrupts: outcome.interrupts },
          } satisfies AgUiEvent,
        ];
      case 'canceled':
        return [
          ...closing,
          {
            type: AgUiEventType.RUN_FINISHED,
            threadId: this.threadId,
            runId: this.runId,
            result: { status: 'canceled' },
            outcome: { type: 'success' },
          } satisfies AgUiEvent,
        ];
      case 'failed':
        return [...closing, { type: AgUiEventType.RUN_ERROR, message: outcome.message }];
    }
  }

  private textDelta(text: string): ReadonlyArray<AgUiEvent> {
    if (this.reasoningMessageId !== undefined) return [...this.closeReasoningMessage(), ...this.openTextAndDelta(text)];
    if (this.textMessageId === undefined) return this.openTextAndDelta(text);
    return [{ type: AgUiEventType.TEXT_MESSAGE_CONTENT, messageId: this.textMessageId, delta: text }];
  }

  private reasoningDelta(text: string): ReadonlyArray<AgUiEvent> {
    if (this.textMessageId !== undefined) {
      return [...this.closeTextMessage(), ...this.openReasoningAndDelta(text)];
    }
    if (this.reasoningMessageId === undefined) return this.openReasoningAndDelta(text);
    return [{ type: AgUiEventType.REASONING_MESSAGE_CONTENT, messageId: this.reasoningMessageId, delta: text }];
  }

  /** Message ids only have to be unique within the run, which already has a unique id. */
  private nextMessageId(): string {
    this.messageSequence += 1;
    return `${this.runId}:${this.messageSequence}`;
  }

  private openTextAndDelta(text: string): ReadonlyArray<AgUiEvent> {
    this.textMessageId = this.nextMessageId();
    return [
      { type: AgUiEventType.TEXT_MESSAGE_START, messageId: this.textMessageId, role: 'assistant' },
      { type: AgUiEventType.TEXT_MESSAGE_CONTENT, messageId: this.textMessageId, delta: text },
    ];
  }

  private openReasoningAndDelta(text: string): ReadonlyArray<AgUiEvent> {
    this.reasoningMessageId = this.nextMessageId();
    return [
      { type: AgUiEventType.REASONING_MESSAGE_START, messageId: this.reasoningMessageId, role: 'reasoning' },
      { type: AgUiEventType.REASONING_MESSAGE_CONTENT, messageId: this.reasoningMessageId, delta: text },
    ];
  }

  private closeTextMessage(): ReadonlyArray<AgUiEvent> {
    if (this.textMessageId === undefined) return [];
    const end: AgUiEvent = { type: AgUiEventType.TEXT_MESSAGE_END, messageId: this.textMessageId };
    this.textMessageId = undefined;
    return [end];
  }

  private closeReasoningMessage(): ReadonlyArray<AgUiEvent> {
    if (this.reasoningMessageId === undefined) return [];
    const end: AgUiEvent = { type: AgUiEventType.REASONING_MESSAGE_END, messageId: this.reasoningMessageId };
    this.reasoningMessageId = undefined;
    return [end];
  }
}

/**
 * Bridges a promise-based agent run into an `AsyncIterable` of AG-UI events.
 * `run` receives an emit callback (already mapped through the adapter) and
 * resolves with the terminal outcome; the iterable yields RUN_STARTED, the
 * mapped events, and finally RUN_FINISHED/RUN_ERROR.
 */
export const streamAgentRunAsAgUi = (
  context: { readonly threadId: string; readonly runId: string },
  run: (emit: (event: AgUiEvent) => void) => Promise<AgUiRunOutcome>,
): AsyncIterable<AgUiEvent> => {
  const adapter = new AgUiEventAdapter(context.threadId, context.runId);

  const buffer: AgUiEvent[] = [];
  let notify: (() => void) | undefined;
  let finished = false;
  let detached = false;

  const emit = (event: AgUiEvent): void => {
    if (detached) return;
    buffer.push(event);
    const wake = notify;
    notify = undefined;
    wake?.();
  };

  const waitForNext = (): Promise<void> =>
    new Promise((resolve) => {
      notify = resolve;
    });

  const driver = (async () => {
    emit(adapter.start());
    try {
      const outcome = await run(emit);
      for (const event of adapter.finish(outcome)) emit(event);
    } catch (error) {
      for (const event of adapter.finish({
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })) {
        emit(event);
      }
    } finally {
      finished = true;
      const wake = notify;
      notify = undefined;
      wake?.();
    }
  })();

  return {
    [Symbol.asyncIterator]() {
      return {
        return: async (): Promise<IteratorResult<AgUiEvent>> => {
          detached = true;
          buffer.length = 0;
          notify?.();
          return { value: undefined, done: true };
        },
        next: async (): Promise<IteratorResult<AgUiEvent>> => {
          while (buffer.length === 0 && !finished && !detached) await waitForNext();
          if (buffer.length > 0) {
            const value = buffer.shift();
            if (value) return { value, done: false };
          }
          void driver;
          return { value: undefined, done: true };
        },
      };
    },
  };
};

const loopEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  z.object({ type: z.literal('tool-call'), toolCallId: z.string(), toolName: z.string(), input: z.json() }),
  z.object({ type: z.literal('tool-result'), toolCallId: z.string(), toolName: z.string(), output: z.json() }),
  z.object({ type: z.literal('tool-error'), toolCallId: z.string(), toolName: z.string(), error: z.string() }),
]);

export const graphEventToAgUi = (adapter: AgUiEventAdapter, data: Json): ReadonlyArray<AgUiEvent> => {
  const event = loopEventSchema.safeParse(data);
  if (event.success) return adapter.handle(event.data);
  return [{ type: AgUiEventType.CUSTOM, name: 'graph_event', value: data }];
};
