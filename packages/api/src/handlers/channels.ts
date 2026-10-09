import * as Effect from 'effect/Effect';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import { AgentdockApi } from '../api';
import { ChannelGateway } from '../channels/gateway';
import { ChannelRegistry, type ChannelRegistryError, type ChannelValidationError } from '../channels/service';
import { withHttpRootSpan } from '../tracing';

const jsonResponse = (status: number, error: string) => HttpServerResponse.jsonUnsafe({ error }, { status });

const toErrorMessage = (error: ChannelRegistryError, fallback: string): string =>
  error.cause instanceof Error ? error.cause.message : fallback;

/** Validation errors are the client's fault (400); everything else is a 500. */
const mapWriteError = (error: ChannelRegistryError | ChannelValidationError, fallback: string) =>
  Effect.succeed(
    error._tag === 'ChannelValidationError'
      ? jsonResponse(400, error.message)
      : jsonResponse(500, toErrorMessage(error, fallback)),
  );

export const channelsHandler = HttpApiBuilder.group(AgentdockApi, 'channels', (handlers) =>
  handlers
    .handle('listChannelAccounts', () =>
      ChannelRegistry.use((registry) => registry.listAccounts()).pipe(
        withHttpRootSpan('agentdock.http.request.channels.accounts.list'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to list channel accounts'))),
        ),
      ),
    )
    .handle('addChannelAccount', ({ payload }) =>
      ChannelRegistry.use((registry) => registry.addAccount(payload)).pipe(
        withHttpRootSpan('agentdock.http.request.channels.accounts.add'),
        Effect.catch((error) => mapWriteError(error, 'Failed to add channel account')),
      ),
    )
    .handle('updateChannelAccount', ({ params, payload }) =>
      Effect.gen(function* () {
        const registry = yield* ChannelRegistry;
        const account = yield* registry.updateAccount(params.accountId, payload);
        return account ?? jsonResponse(404, 'Channel account not found');
      }).pipe(
        withHttpRootSpan('agentdock.http.request.channels.accounts.update'),
        Effect.catch((error) => mapWriteError(error, 'Failed to update channel account')),
      ),
    )
    .handle('removeChannelAccount', ({ params }) =>
      ChannelRegistry.use((registry) => registry.removeAccount(params.accountId)).pipe(
        Effect.map((removed) => ({ removed })),
        withHttpRootSpan('agentdock.http.request.channels.accounts.remove'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to remove channel account'))),
        ),
      ),
    )
    .handle('listChannelAccountStatuses', () =>
      ChannelGateway.use((gateway) => gateway.statuses()).pipe(
        withHttpRootSpan('agentdock.http.request.channels.accounts.status'),
      ),
    )
    .handle('listChannelBindings', () =>
      ChannelRegistry.use((registry) => registry.listBindings()).pipe(
        withHttpRootSpan('agentdock.http.request.channels.bindings.list'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to list channel bindings'))),
        ),
      ),
    )
    .handle('addChannelBinding', ({ payload }) =>
      ChannelRegistry.use((registry) => registry.addBinding(payload)).pipe(
        withHttpRootSpan('agentdock.http.request.channels.bindings.add'),
        Effect.catch((error) => mapWriteError(error, 'Failed to add channel binding')),
      ),
    )
    .handle('updateChannelBinding', ({ params, payload }) =>
      Effect.gen(function* () {
        const registry = yield* ChannelRegistry;
        const binding = yield* registry.updateBinding(params.bindingId, payload);
        return binding ?? jsonResponse(404, 'Channel binding not found');
      }).pipe(
        withHttpRootSpan('agentdock.http.request.channels.bindings.update'),
        Effect.catch((error) => mapWriteError(error, 'Failed to update channel binding')),
      ),
    )
    .handle('removeChannelBinding', ({ params }) =>
      ChannelRegistry.use((registry) => registry.removeBinding(params.bindingId)).pipe(
        Effect.map((removed) => ({ removed })),
        withHttpRootSpan('agentdock.http.request.channels.bindings.remove'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to remove channel binding'))),
        ),
      ),
    ),
);
