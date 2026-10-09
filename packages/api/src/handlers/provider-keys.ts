import { createChatModel } from 'agentdock-sdk';
import * as Effect from 'effect/Effect';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import * as Schema from 'effect/Schema';
import type * as Types from 'effect/Types';
import { AgentdockApi } from '../api';
import { ProviderKeyRegistry, type SetProviderKeyInput } from '../providers/service';
import { withHttpRootSpan } from '../tracing';

const toErrorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

/** A live probe against the provider's model endpoint came back with an error. */
class ModelProbeError extends Schema.TaggedError<ModelProbeError>()('ModelProbeError', {
  message: Schema.String,
}) {}

const errorResponse = (status: number, error: string) => HttpServerResponse.jsonUnsafe({ error }, { status });

export const providerKeysHandler = HttpApiBuilder.group(AgentdockApi, 'providerKeys', (handlers) =>
  handlers
    .handle('listProviderKeys', () =>
      ProviderKeyRegistry.use((registry) => registry.list()).pipe(
        withHttpRootSpan('agentdock.http.request.provider-keys.list'),
        Effect.catch((error) =>
          Effect.succeed(errorResponse(500, toErrorMessage(error, 'Failed to list provider keys'))),
        ),
      ),
    )
    .handle('setProviderKey', ({ params, payload }) => {
      const apiKey = payload.apiKey.trim();
      const baseUrl = payload.baseUrl?.trim();

      if (apiKey.length === 0 && !baseUrl) {
        return Effect.succeed(errorResponse(400, 'API key must not be empty'));
      }

      const input: Types.Mutable<SetProviderKeyInput> = { apiKey };
      if (baseUrl) input.baseUrl = baseUrl;
      if (payload.name) input.name = payload.name;
      if (payload.queryParams) input.queryParams = payload.queryParams;
      if (payload.kind) input.kind = payload.kind;

      return ProviderKeyRegistry.use((registry) => registry.set(params.provider, input)).pipe(
        withHttpRootSpan('agentdock.http.request.provider-keys.set'),
        Effect.catch((error) =>
          Effect.succeed(errorResponse(500, toErrorMessage(error, 'Failed to set provider key'))),
        ),
      );
    })
    .handle('removeProviderKey', ({ params }) =>
      ProviderKeyRegistry.use((registry) => registry.remove(params.provider)).pipe(
        Effect.map((removed) => ({ removed })),
        withHttpRootSpan('agentdock.http.request.provider-keys.remove'),
        Effect.catch((error) =>
          Effect.succeed(errorResponse(500, toErrorMessage(error, 'Failed to remove provider key'))),
        ),
      ),
    )

    .handle('validateModel', ({ payload }) =>
      Effect.gen(function* () {
        const separator = payload.model.indexOf(':');
        if (separator === -1) {
          return { ok: false, error: "Expected a 'provider:model' value." };
        }
        const provider = payload.model.slice(0, separator).trim();
        const modelId = payload.model.slice(separator + 1).trim();
        if (provider.length === 0 || modelId.length === 0) {
          return { ok: false, error: "Expected a 'provider:model' value." };
        }
        const config = yield* ProviderKeyRegistry.use((registry) => registry.getRuntimeConfig(provider));
        const model = createChatModel(provider, modelId, config);

        yield* Effect.tryPromise({
          try: () => model.invoke([{ role: 'user', content: 'ping' }]),
          catch: (error) => new ModelProbeError({ message: toErrorMessage(error, 'Model request failed') }),
        });
        return { ok: true };
      }).pipe(
        withHttpRootSpan('agentdock.http.request.provider-keys.validate-model'),
        Effect.catch((error) => Effect.succeed({ ok: false, error: toErrorMessage(error, 'Validation failed') })),
      ),
    ),
);
