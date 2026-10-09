import * as NodeCrypto from 'node:crypto';
import type { Message, MessageSendParams, Part, Task } from '@a2a-js/sdk';
import { tracedA2aClientFactory } from 'agentdock-sdk/a2a/client';
import { buildAgentA2aUrl, buildWorkflowA2aUrl, normalizeBaseUrl } from 'agentdock-sdk/routes';
import type { Trigger } from 'agentdock-sdk/schemas';
import { renderTriggerParts, type TriggerPayload } from 'agentdock-sdk/triggers';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { TriggerConfig } from '../config';
import { TriggerRegistry } from './service';

export type TriggerSource = 'schedule' | 'webhook' | 'email';

export type TriggerDispatchResult = { readonly taskId: string };

type TriggerDispatcherService = {
  readonly dispatch: (
    trigger: Trigger,
    payload: TriggerPayload,
    source: TriggerSource,
  ) => Effect.Effect<TriggerDispatchResult, TriggerDispatchError>;
};

export class TriggerDispatchError extends Schema.TaggedError<TriggerDispatchError>()('TriggerDispatchError', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const targetA2aUrl = (baseUrl: string, trigger: Trigger): string =>
  trigger.target.kind === 'agent'
    ? buildAgentA2aUrl(baseUrl, trigger.target.id)
    : buildWorkflowA2aUrl(baseUrl, trigger.target.id);

const buildParams = (messageId: string, parts: ReadonlyArray<Part>): MessageSendParams => ({
  configuration: { blocking: false },
  message: { kind: 'message', messageId, role: 'user', parts: [...parts] },
});

const taskIdFromResult = (result: Message | Task, fallback: string): string =>
  result.kind === 'task' ? result.id : fallback;

export const TriggerDispatcher = Context.Service<TriggerDispatcherService>('@agentdock/api/TriggerDispatcher');

export const TriggerDispatcherLive = Layer.effect(
  TriggerDispatcher,
  Effect.gen(function* () {
    const registry = yield* TriggerRegistry;
    const config = yield* TriggerConfig;
    const httpClient = yield* HttpClient.HttpClient;
    const baseUrl = normalizeBaseUrl(config.apiBaseUrl);

    return TriggerDispatcher.of({
      dispatch: Effect.fn('TriggerDispatcher.dispatch')(function* (trigger, payload, source) {
        yield* Effect.annotateCurrentSpan({
          'trigger.id': trigger.id,
          'trigger.source': source,
          'trigger.target.kind': trigger.target.kind,
        });

        return yield* Effect.gen(function* () {
          const messageId = NodeCrypto.randomUUID();
          const parts = yield* Effect.try({
            try: () => renderTriggerParts(trigger.taskTemplate, payload),
            catch: (cause) =>
              new TriggerDispatchError({
                message: `failed to render task template: ${cause instanceof Error ? cause.message : String(cause)}`,
                cause,
              }),
          });

          const clientFactory = yield* tracedA2aClientFactory.pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
          const client = yield* Effect.tryPromise({
            try: () => clientFactory.createFromUrl(`${targetA2aUrl(baseUrl, trigger)}/`),
            catch: (cause) => new TriggerDispatchError({ message: 'failed to create a2a client', cause }),
          });

          const result = yield* Effect.tryPromise({
            try: () => client.sendMessage(buildParams(messageId, parts)),
            catch: (cause) => new TriggerDispatchError({ message: 'a2a message/send failed', cause }),
          });

          const taskId = taskIdFromResult(result, messageId);
          yield* registry
            .recordFiring({ triggerId: trigger.id, taskId, source, status: 'dispatched' })
            .pipe(Effect.ignore);
          return { taskId } satisfies TriggerDispatchResult;
        }).pipe(
          Effect.tapError((error) =>
            registry
              .recordFiring({ triggerId: trigger.id, taskId: '', source, status: 'failed', error: error.message })
              .pipe(Effect.ignore),
          ),
        );
      }),
    });
  }),
);
