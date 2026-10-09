import {
  coerceJson,
  isJsonObject,
  type Json,
  jsonString,
  type Model,
  ModelSchema,
  ReasoningEffort,
} from 'agentdock-sdk/schemas';
import * as Cache from 'effect/Cache';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { getJson } from '../http-client';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL = Duration.minutes(10);
const FETCH_TIMEOUT = Duration.seconds(10);

const PRIMARY_PROVIDERS: ReadonlyArray<string> = [
  'openai',
  'anthropic',
  'google_genai',
  'xai',
  'mistral',
  'deepseek',
  'groq',
];
const PRIMARY_SET = new Set<string>(PRIMARY_PROVIDERS);
const providerRank = (providerId: string): number => {
  const index = PRIMARY_PROVIDERS.indexOf(providerId);
  return index === -1 ? PRIMARY_PROVIDERS.length : index;
};

const SUGGESTED_PER_PROVIDER = 5;

const normalizeName = (name: string): string =>
  name
    .replace(/\s*\(latest\)\s*$/i, '')
    .replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, '')
    .trim();

/** The subset of a models.dev model entry this catalog reads. Unknown fields are dropped. */
const RawModel = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  tool_call: Schema.optional(Schema.Boolean),
  reasoning: Schema.optional(Schema.Boolean),
  /** How the model's thinking can be steered; `effort` entries list the accepted tiers. */
  reasoning_options: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.String, values: Schema.optional(Schema.Array(Schema.String)) })),
  ),
  release_date: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.Struct({ context: Schema.optional(Schema.Number), output: Schema.optional(Schema.Number) }),
  ),
  cost: Schema.optional(
    Schema.Struct({
      input: Schema.optional(Schema.Number),
      output: Schema.optional(Schema.Number),
      cache_read: Schema.optional(Schema.Number),
      cache_write: Schema.optional(Schema.Number),
    }),
  ),
});
type RawModel = Schema.Schema.Type<typeof RawModel>;

const decodeRawModel = Schema.decodeUnknownOption(RawModel);
const decodeModel = Schema.decodeUnknownSync(ModelSchema);
const decodeReasoningEffort = Schema.decodeUnknownOption(ReasoningEffort);

/** The `effort` tiers models.dev publishes for a model; models without one get no effort knob. */
const reasoningEffortsOf = (raw: RawModel): ReadonlyArray<ReasoningEffort> =>
  (raw.reasoning_options ?? [])
    .filter((option) => option.type === 'effort')
    .flatMap((option) => option.values ?? [])
    .flatMap((value) => Option.toArray(decodeReasoningEffort(value)));

const normalizeProviderId = (providerId: string): string => (providerId === 'google' ? 'google_genai' : providerId);

type MutableModel = { -readonly [K in keyof Model]: Model[K] };

const toModel = (providerId: string, providerName: string, raw: RawModel): MutableModel => {
  const id = raw.id ?? '';
  const model: MutableModel = {
    value: `${providerId}:${id}`,
    provider: providerId,
    providerName,
    id,
    name: normalizeName(raw.name ?? id),
  };
  if (raw.limit?.context !== undefined) model.contextWindow = raw.limit.context;
  if (raw.limit?.output !== undefined) model.maxOutputTokens = raw.limit.output;
  if (raw.cost?.input !== undefined) model.inputCostPerMillion = raw.cost.input;
  if (raw.cost?.output !== undefined) model.outputCostPerMillion = raw.cost.output;
  if (raw.cost?.cache_read !== undefined) model.cacheReadCostPerMillion = raw.cost.cache_read;
  if (raw.cost?.cache_write !== undefined) model.cacheWriteCostPerMillion = raw.cost.cache_write;
  if (raw.tool_call !== undefined) model.toolCall = raw.tool_call;
  if (raw.reasoning !== undefined) model.reasoning = raw.reasoning;
  const reasoningEfforts = reasoningEffortsOf(raw);
  if (reasoningEfforts.length > 0) model.reasoningEfforts = reasoningEfforts;
  if (raw.release_date !== undefined) model.releaseDate = raw.release_date;
  return model;
};

const releaseRank = (model: Model): number => (model.releaseDate ? Date.parse(model.releaseDate) || 0 : 0);

/**
 * models.dev is a third-party document, so each model entry is decoded on its
 * own: an entry that no longer matches is skipped instead of losing the catalog.
 */
export const buildCatalog = (catalog: Json): ReadonlyArray<Model> => {
  if (!isJsonObject(catalog)) return [];
  const byProvider = new Map<string, Map<string, MutableModel>>();
  for (const [rawProviderId, provider] of Object.entries(catalog)) {
    if (!isJsonObject(provider)) continue;
    const providerId = normalizeProviderId(rawProviderId);
    const providerName = jsonString(provider, 'name') ?? providerId;
    const dedup = byProvider.get(providerId) ?? new Map<string, MutableModel>();
    const models = provider.models;
    for (const entry of isJsonObject(models) ? Object.values(models) : []) {
      const raw = Option.getOrUndefined(decodeRawModel(entry));
      if (!raw?.id || raw.tool_call !== true) continue;
      const model = toModel(providerId, providerName, raw);
      const existing = dedup.get(model.name);
      if (!existing || model.id.length < existing.id.length) dedup.set(model.name, model);
    }
    byProvider.set(providerId, dedup);
  }

  // Mark each primary provider's most-recent models as suggested.
  const models: Array<MutableModel> = [];
  for (const dedup of byProvider.values()) {
    const providerModels = [...dedup.values()].sort((a, b) => releaseRank(b) - releaseRank(a));
    providerModels.forEach((model, index) => {
      if (index < SUGGESTED_PER_PROVIDER && PRIMARY_SET.has(model.provider)) model.suggested = true;
      models.push(model);
    });
  }

  models.sort((a, b) => {
    const rankDiff = providerRank(a.provider) - providerRank(b.provider);
    if (rankDiff !== 0) return rankDiff;
    if (a.provider !== b.provider) return a.providerName.localeCompare(b.providerName);
    const recencyDiff = releaseRank(b) - releaseRank(a);
    return recencyDiff !== 0 ? recencyDiff : a.name.localeCompare(b.name);
  });
  return models;
};

const placeholderModel = (modelValue: string): Model => {
  const hasProvider = modelValue.includes(':');
  const [providerPart, idPart] = modelValue.split(':', 2);
  const provider = hasProvider ? (providerPart ?? 'unknown') : 'unknown';
  const id = hasProvider ? (idPart ?? modelValue) : modelValue;
  return decodeModel({ value: modelValue, provider, providerName: provider, id, name: modelValue });
};

export type ModelCatalogService = {
  /** The models.dev catalog, refreshed at most once per {@link CACHE_TTL}. */
  readonly list: Effect.Effect<ReadonlyArray<Model>>;
  readonly find: (modelValue: string) => Effect.Effect<Model>;
};

export const ModelCatalog = Context.Service<ModelCatalogService>('@agentdock/api/ModelCatalog');

/**
 * The catalog is a remote document that changes rarely, so one memoised fetch
 * per {@link CACHE_TTL} is built at layer construction and shared by every
 * caller. It lives in a `Cache` rather than `Effect.cachedWithTTL`: the cache
 * runs the fetch in its own fiber and forgets an interrupted one, where the
 * memo would hand every later caller the interruption of a client that
 * aborted the request that happened to start the fetch. The HTTP client is
 * captured here so the service methods stay requirement-free.
 */
export const ModelCatalogLive = Layer.effect(
  ModelCatalog,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const fetchCatalog = getJson(MODELS_DEV_URL).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.map((json) => buildCatalog(coerceJson(json))),
      Effect.timeout(FETCH_TIMEOUT),
      Effect.orElseSucceed((): ReadonlyArray<Model> => []),
    );
    const catalog = yield* Cache.make({ capacity: 1, timeToLive: CACHE_TTL, lookup: () => fetchCatalog });
    const list = Cache.get(catalog, MODELS_DEV_URL);

    return ModelCatalog.of({
      list,
      find: (modelValue) =>
        Effect.map(
          list,
          (models) => models.find((model) => model.value === modelValue) ?? placeholderModel(modelValue),
        ),
    });
  }),
);
