import * as Effect from 'effect/Effect';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import * as Schema from 'effect/Schema';
import { AgentdockApi } from '../api';
import { withHttpRootSpan } from '../tracing';
import { TriggerRegistry, TriggerValidationError } from '../triggers/service';

const isTriggerValidationError = Schema.is(TriggerValidationError);

const jsonResponse = (status: number, error: string) => HttpServerResponse.jsonUnsafe({ error }, { status });

const toErrorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

/** Validation errors are the client's fault (400); everything else is a 500. */
const mapWriteError = (cause: unknown, fallback: string) =>
  Effect.succeed(
    isTriggerValidationError(cause)
      ? jsonResponse(400, cause.message)
      : jsonResponse(500, toErrorMessage(cause, fallback)),
  );

export const triggersHandler = HttpApiBuilder.group(AgentdockApi, 'triggers', (handlers) =>
  handlers
    .handle('listTriggers', () =>
      TriggerRegistry.use((registry) => registry.list()).pipe(
        withHttpRootSpan('agentdock.http.request.triggers.list'),
        Effect.catch((error) => Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to list triggers')))),
      ),
    )
    .handle('addTrigger', ({ payload }) =>
      TriggerRegistry.use((registry) => registry.add(payload)).pipe(
        withHttpRootSpan('agentdock.http.request.triggers.add'),
        Effect.catch((error) => mapWriteError(error, 'Failed to add trigger')),
      ),
    )
    .handle('updateTrigger', ({ params, payload }) =>
      Effect.gen(function* () {
        const registry = yield* TriggerRegistry;
        const trigger = yield* registry.update(params.triggerId, payload);
        return trigger ?? jsonResponse(404, 'Trigger not found');
      }).pipe(
        withHttpRootSpan('agentdock.http.request.triggers.update'),
        Effect.catch((error) => mapWriteError(error, 'Failed to update trigger')),
      ),
    )
    .handle('removeTrigger', ({ params }) =>
      TriggerRegistry.use((registry) => registry.remove(params.triggerId)).pipe(
        Effect.map((removed) => ({ removed })),
        Effect.withSpan('agentdock.http.triggers.remove', { attributes: { 'trigger.id': params.triggerId } }),
        withHttpRootSpan('agentdock.http.request.triggers.remove'),
        Effect.catch((error) => Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to remove trigger')))),
      ),
    ),
);
