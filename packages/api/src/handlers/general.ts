import { type Model, ModelSchema, workflowManifestJsonSchema } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import * as Schema from 'effect/Schema';
import { AgentdockApi } from '../api';
import { getJson } from '../http-client';
import { ModelCatalog } from '../models/catalog';
import { ProviderKeyRegistry } from '../providers/service';
import { withHttpRootSpan } from '../tracing';

const CUSTOM_SUGGESTED_LIMIT = 5;
const decodeModel = Schema.decodeUnknownSync(ModelSchema);

/** The OpenAI-compatible `GET /models` document a custom provider answers with. */
const ProviderModelsResponse = Schema.Struct({
  data: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.optional(Schema.String) }))),
});
const decodeProviderModelsResponse = Schema.decodeUnknownEffect(ProviderModelsResponse);

const fetchCustomProviderModels = (provider: {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly queryParams?: Record<string, string> | undefined;
}) =>
  Effect.gen(function* () {
    const base = `${provider.baseUrl.replace(/\/$/, '')}/models`;
    const query = new URLSearchParams(provider.queryParams ?? {}).toString();
    const url = query ? `${base}?${query}` : base;
    const body = yield* getJson(
      url,
      provider.apiKey ? { headers: { Authorization: `Bearer ${provider.apiKey}` } } : {},
    );
    const { data } = yield* decodeProviderModelsResponse(body);
    const ids = (data ?? []).flatMap((entry) => (entry.id === undefined ? [] : [entry.id]));
    return ids.map((id, index) =>
      decodeModel({
        value: `${provider.id}:${id}`,
        provider: provider.id,
        providerName: provider.name,
        id,
        name: id,
        suggested: index < CUSTOM_SUGGESTED_LIMIT ? true : undefined,
      }),
    );
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<Model> => []));

const listAllModels = Effect.fn('GeneralHandler.listAllModels')(function* () {
  const registry = yield* ProviderKeyRegistry;
  const [catalog, custom] = yield* Effect.all([
    ModelCatalog.use((catalog) => catalog.list),
    registry.listCustom().pipe(Effect.orElseSucceed(() => [])),
  ]);
  const customModels = yield* Effect.forEach(custom, fetchCustomProviderModels, { concurrency: 4 });
  return [...customModels.flat(), ...catalog];
});

export const generalHandler = HttpApiBuilder.group(AgentdockApi, 'general', (handlers) =>
  handlers
    .handle('health', () => Effect.succeed('OK'))
    .handle('listModels', () =>
      listAllModels().pipe(
        withHttpRootSpan('agentdock.http.request.models.list'),
        Effect.orElseSucceed((): ReadonlyArray<Model> => []),
      ),
    )
    .handle('workflowManifestSchema', () =>
      Effect.succeed(workflowManifestJsonSchema()).pipe(withHttpRootSpan('agentdock.http.request.schemas.workflow')),
    ),
);
