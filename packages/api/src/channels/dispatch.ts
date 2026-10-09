import type { Message as A2aMessage, Part, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { type A2ARequestHandler, ServerCallContext, UnauthenticatedUser } from '@a2a-js/sdk/server';
import { randomUUIDv4 } from 'agentdock-sdk';
import type { ChannelAccount, ChannelBinding, ChannelTarget, JsonObject } from 'agentdock-sdk/schemas';
import { coerceJson, isJsonObject, jsonString } from 'agentdock-sdk/schemas';
import type { CardElement, Message, Thread } from 'chat';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { AgentA2aHandlers } from '../a2a/handlers';
import { AgentRegistry } from '../agents/service';
import { ServerConfig } from '../config';
import type { SkillRegistry } from '../skills/service';
import { WorkflowA2aHandlers } from '../workflows/a2a';
import { WorkflowRegistry } from '../workflows/service';
import { ChannelRegistry, type ChannelThread } from './service';

export const ACCEPT_ACTION = 'agentdock:accept';
export const DECLINE_ACTION = 'agentdock:decline';

export class ChannelDispatchError extends Schema.TaggedError<ChannelDispatchError>()('ChannelDispatchError', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A user turn: either a plain message, or the answer to a pending input request. */
export type ChannelTurn =
  | { readonly kind: 'message'; readonly messageId: string; readonly text: string }
  | { readonly kind: 'response'; readonly messageId: string; readonly response: JsonObject };

type ChannelDispatcherService = {
  readonly dispatch: (
    account: ChannelAccount,
    binding: ChannelBinding,
    thread: Thread<unknown>,
    turn: ChannelTurn,
  ) => Effect.Effect<void, ChannelDispatchError>;
};

export const ChannelDispatcher = Context.Service<ChannelDispatcherService>('@agentdock/api/ChannelDispatcher');

type A2aStreamEvent = A2aMessage | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

/** Text pushed in as a2a artifact deltas arrive, consumed by `thread.post` as a stream. */
class TextStream implements AsyncIterable<string> {
  private readonly chunks: Array<string> = [];
  private waiting: (() => void) | undefined;
  private closed = false;
  length = 0;

  push(text: string): void {
    if (this.closed || text.length === 0) return;
    this.chunks.push(text);
    this.length += text.length;
    this.wake();
  }

  end(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (true) {
      const next = this.chunks.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }
}

const textOf = (parts: ReadonlyArray<Part>): string =>
  parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('');

const dataOf = (parts: ReadonlyArray<Part>): JsonObject | undefined => {
  for (const part of parts) {
    if (part.kind === 'data') {
      const json = coerceJson(part.data);
      if (isJsonObject(json)) return json;
    }
  }
  return undefined;
};

const inputRequiredCard = (request: JsonObject | undefined): CardElement => {
  const title = (request && (jsonString(request, 'title') ?? jsonString(request, 'actionId'))) ?? 'Input required';
  const detail =
    (request && (jsonString(request, 'message') ?? jsonString(request, 'description'))) ??
    (request ? `\`\`\`json\n${JSON.stringify(request, null, 2)}\n\`\`\`` : 'The run is waiting for your decision.');
  return {
    type: 'card',
    title,
    children: [
      { type: 'text', content: detail },
      {
        type: 'actions',
        children: [
          { type: 'button', id: ACCEPT_ACTION, label: 'Approve', style: 'primary' },
          { type: 'button', id: DECLINE_ACTION, label: 'Decline', style: 'danger' },
        ],
      },
    ],
  };
};

const turnParts = (turn: ChannelTurn): Array<Part> =>
  turn.kind === 'message'
    ? [{ kind: 'text', text: turn.text }]
    : [{ kind: 'data', data: { type: 'input-required-response', response: turn.response } }];

const targetKey = (target: ChannelTarget): string => `${target.kind}:${target.id}`;

export const ChannelDispatcherLive = Layer.effect(
  ChannelDispatcher,
  Effect.gen(function* () {
    const registry = yield* ChannelRegistry;
    const agents = yield* AgentRegistry;
    const workflows = yield* WorkflowRegistry;
    const agentHandlers = yield* AgentA2aHandlers;
    const workflowHandlers = yield* WorkflowA2aHandlers;
    const server = yield* ServerConfig;
    const skills = yield* Effect.context<Context.Service.Identifier<typeof SkillRegistry>>();

    const fail = (message: string) => (cause: unknown) => new ChannelDispatchError({ message, cause });

    const requestHandlerFor = (target: ChannelTarget): Effect.Effect<A2ARequestHandler | null, ChannelDispatchError> =>
      Effect.gen(function* () {
        if (target.kind === 'agent') {
          const agent = yield* agents.getById(target.id);
          if (!agent) return null;
          return yield* agentHandlers.get(agent, server.apiBaseUrl).pipe(Effect.provide(skills));
        }
        const workflow = yield* workflows.getById(target.id);
        if (!workflow) return null;
        return yield* workflowHandlers.get(workflow, server.apiBaseUrl).pipe(Effect.provide(skills));
      }).pipe(Effect.mapError(fail(`Could not resolve ${targetKey(target)}`)));

    /**
     * Run one turn against the target and mirror its a2a events into the
     * platform thread: streamed text becomes one progressively edited message,
     * an input-required stop becomes a card with buttons, and terminal failures
     * become a short notice.
     */
    const runTurn = (
      requestHandler: A2ARequestHandler,
      thread: Thread<unknown>,
      record: ChannelThread,
      turn: ChannelTurn,
    ): Effect.Effect<ChannelThread, ChannelDispatchError> =>
      Effect.tryPromise({
        try: async () => {
          const message: A2aMessage = {
            kind: 'message',
            role: 'user',
            messageId: turn.messageId,
            contextId: record.contextId,
            parts: turnParts(turn),
          };
          if (record.pendingTaskId) message.taskId = record.pendingTaskId;
          const stream = requestHandler.sendMessageStream(
            { message, configuration: { blocking: true } },
            new ServerCallContext(undefined, new UnauthenticatedUser()),
          );

          let text: TextStream | undefined;
          let posting: Promise<void> | undefined;
          let pendingTaskId: string | null = null;
          const pushText = (delta: string): void => {
            if (delta.length === 0) return;
            if (!text) {
              text = new TextStream();
              posting = thread.post(text).then(() => undefined);
            }
            text.push(delta);
          };
          const finishText = async (): Promise<number> => {
            const streamed = text?.length ?? 0;
            text?.end();
            text = undefined;
            await posting;
            posting = undefined;
            return streamed;
          };

          const handle = async (event: A2aStreamEvent): Promise<void> => {
            switch (event.kind) {
              case 'artifact-update':
                pushText(textOf(event.artifact.parts));
                return;
              case 'status-update': {
                const parts = event.status.message?.parts ?? [];
                switch (event.status.state) {
                  case 'input-required': {
                    await finishText();
                    pendingTaskId = event.taskId;
                    await thread.post(inputRequiredCard(dataOf(parts)));
                    return;
                  }
                  case 'completed': {
                    const streamed = await finishText();
                    pendingTaskId = null;
                    if (streamed === 0) {
                      const finalText = textOf(parts);
                      const data = dataOf(parts);
                      const rendered =
                        finalText || (data ? `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`` : '');
                      if (rendered) await thread.post({ markdown: rendered });
                    }
                    return;
                  }
                  case 'failed':
                  case 'rejected':
                  case 'canceled': {
                    await finishText();
                    pendingTaskId = null;
                    await thread.post({ markdown: `⚠️ ${textOf(parts) || `Run ${event.status.state}.`}` });
                    return;
                  }
                  default:
                    return;
                }
              }
              case 'message':
                pushText(textOf(event.parts));
                return;
              case 'task':
                return;
            }
          };

          try {
            for await (const event of stream) {
              await handle(event);
            }
          } finally {
            await finishText();
          }
          return { ...record, pendingTaskId };
        },
        catch: fail('Turn failed'),
      });

    return ChannelDispatcher.of({
      dispatch: Effect.fn('ChannelDispatcher.dispatch')(function* (account, binding, thread, turn) {
        const existing = yield* registry
          .getThread(account.id, thread.id)
          .pipe(Effect.mapError(fail('Could not load thread state')));
        const contextId = yield* randomUUIDv4;
        const record: ChannelThread = existing ?? {
          accountId: account.id,
          threadId: thread.id,
          contextId,
          target: binding.target,
          pendingTaskId: null,
        };
        const requestHandler = yield* requestHandlerFor(record.target);
        if (!requestHandler) {
          yield* Effect.promise(() =>
            thread.post({ markdown: `⚠️ The ${record.target.kind} bound to this conversation no longer exists.` }),
          );
          return;
        }
        yield* Effect.promise(() => thread.startTyping());
        const updated = yield* runTurn(requestHandler, thread, record, turn).pipe(
          Effect.tapError((error) =>
            Effect.promise(() => thread.post({ markdown: `⚠️ ${error.message}: ${String(error.cause)}` })),
          ),
        );
        yield* registry.saveThread(updated).pipe(Effect.mapError(fail('Could not save thread state')));
      }),
    });
  }),
);

export const turnFromMessage = (message: Message): ChannelTurn => ({
  kind: 'message',
  messageId: message.id,
  text: message.text,
});
