import {
  type GetTraceQuery,
  isJsonString,
  type Json,
  type JsonObject,
  type JsonObjectDraft,
  type ListTracesQuery,
  type Model,
  type TraceDetailResponse,
  TraceDetailResponse as TraceDetailResponseSchema,
  type TraceListResponse,
  TraceListResponse as TraceListResponseSchema,
  type TraceSpan,
} from 'agentdock-sdk/schemas';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import { TempoConfig } from '../config';
import { ModelCatalog } from '../models/catalog';
import { rollUpUsage, spanUsage } from './usage';

type ListTracesOptions = Schema.Schema.Type<typeof ListTracesQuery>;
type GetTraceOptions = Schema.Schema.Type<typeof GetTraceQuery>;

export type TracesServiceApi = {
  readonly listTraces: (options: ListTracesOptions) => Effect.Effect<TraceListResponse, TraceFetchError>;
  readonly getTrace: (
    traceId: string,
    options?: GetTraceOptions,
  ) => Effect.Effect<TraceDetailResponse, TraceFetchError>;
};

// Only surface agent/workflow activity in the in-app traces view. Plain
// application traces are inspected in Grafana/Tempo instead.
const AGENT_ACTIVITY_PREFIXES = [
  'agentdock.a2a.',
  'agentdock.langgraph.',
  'agentdock.workflow.',
  'agentdock.tools.',
  'ai.',
] as const;

// TraceQL string literals consume one level of backslash escaping before the
// regex engine sees the pattern, hence the double escapes.
const DEFAULT_TRACEQL_QUERY = AGENT_ACTIVITY_PREFIXES.map(
  (prefix) => `{ name =~ "${prefix.replaceAll('.', '\\\\.')}.*" }`,
).join(' || ');

const isAgentActivitySpan = (span: TraceSpan): boolean =>
  AGENT_ACTIVITY_PREFIXES.some((prefix) => span.name.startsWith(prefix));

/** Drop non-agent spans, re-parenting the survivors onto their nearest kept ancestor. */
export const filterTraceSpans = (spans: ReadonlyArray<TraceSpan>, all = false): ReadonlyArray<TraceSpan> => {
  if (all) return spans;

  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const keptIds = new Set(spans.filter(isAgentActivitySpan).map((span) => span.spanId));

  return spans.filter(isAgentActivitySpan).map((span) => {
    let parentSpanId = span.parentSpanId;
    const visited = new Set<string>();
    while (parentSpanId !== null && !keptIds.has(parentSpanId) && !visited.has(parentSpanId)) {
      visited.add(parentSpanId);
      parentSpanId = byId.get(parentSpanId)?.parentSpanId ?? null;
    }
    if (parentSpanId !== null && !keptIds.has(parentSpanId)) parentSpanId = null;
    return parentSpanId === span.parentSpanId ? span : { ...span, parentSpanId };
  });
};
const decodeTraceListResponse = Schema.decodeUnknownSync(TraceListResponseSchema);
const decodeTraceDetailResponse = Schema.decodeUnknownSync(TraceDetailResponseSchema);

export class TraceFetchError extends Schema.TaggedError<TraceFetchError>()('TraceFetchError', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}
const isTraceFetchError = Schema.is(TraceFetchError);

const toTraceFetchError = (cause: unknown): TraceFetchError =>
  isTraceFetchError(cause) ? cause : new TraceFetchError({ message: 'Tempo request failed', cause });

/**
 * Tempo renders OTLP protobuf as JSON, which spells enums and 64-bit numbers as
 * strings for some producers and as numbers for others, so the numeric fields
 * accept either and are narrowed where they are read.
 */
const NumberOrString = Schema.optional(Schema.Union([Schema.Number, Schema.String]));

const TempoSearchResponse = Schema.Struct({
  traces: Schema.optional(
    Schema.Array(
      Schema.Struct({
        traceID: Schema.optional(Schema.String),
        rootServiceName: Schema.optional(Schema.String),
        rootTraceName: Schema.optional(Schema.String),
        startTimeUnixNano: Schema.optional(Schema.String),
        durationMs: NumberOrString,
      }),
    ),
  ),
});

// The Tempo HTTP calls go through the injected HttpClient instance (captured at
// layer build) so the network dependency is explicit in the layer's
// requirements while the service methods stay requirement-free.
const fetchJson = <S extends Schema.Top>(
  client: HttpClient.HttpClient,
  url: string,
  schema: S,
): Effect.Effect<S['Type'], TraceFetchError, S['DecodingServices']> =>
  Effect.gen(function* () {
    const response = yield* client.get(url, { headers: { Accept: 'application/json' } });
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ''));
      return yield* new TraceFetchError({
        message: `Tempo request failed: ${response.status} ${body}`,
        cause: body,
      });
    }
    return yield* Schema.decodeUnknownEffect(schema)(yield* response.json);
  }).pipe(Effect.mapError(toTraceFetchError));

const listTracesFromTempo = (client: HttpClient.HttpClient, baseUrl: string) =>
  Effect.fn('TracesService.listTracesFromTempo')(function* (options: ListTracesOptions) {
    const params = new URLSearchParams();
    const limit = options.limit && options.limit > 0 ? options.limit : 50;
    params.set('limit', String(limit));

    const query = options.q?.trim();
    const service = options.service?.trim();

    if (query && query.length > 0) {
      params.set('q', query);
    } else if (service && service.length > 0) {
      params.set('q', `{ resource.service.name = "${service}" }`);
    } else {
      params.set('q', DEFAULT_TRACEQL_QUERY);
    }

    const data = yield* fetchJson(client, `${baseUrl}/api/search?${params.toString()}`, TempoSearchResponse);

    return decodeTraceListResponse({
      traces: (data.traces ?? []).map((trace) => ({
        traceId: trace.traceID ?? '',
        rootServiceName: trace.rootServiceName ?? 'unknown',
        rootTraceName: trace.rootTraceName ?? 'unknown',
        startTimeUnixNano: trace.startTimeUnixNano ?? '0',
        durationMs: Predicate.isNumber(trace.durationMs) ? trace.durationMs : 0,
      })),
    });
  });

type OtlpAttributeValue = {
  readonly stringValue?: string | undefined;
  readonly intValue?: string | number | undefined;
  readonly doubleValue?: number | undefined;
  readonly boolValue?: boolean | undefined;
  readonly bytesValue?: string | undefined;
  readonly arrayValue?: { readonly values?: ReadonlyArray<OtlpAttributeValue> | undefined } | undefined;
  readonly kvlistValue?: { readonly values?: ReadonlyArray<OtlpAttribute> | undefined } | undefined;
};

type OtlpAttribute = {
  readonly key?: string | undefined;
  readonly value?: OtlpAttributeValue | undefined;
};

const OtlpAttributeValue = Schema.Struct({
  stringValue: Schema.optional(Schema.String),
  intValue: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  doubleValue: Schema.optional(Schema.Number),
  boolValue: Schema.optional(Schema.Boolean),
  bytesValue: Schema.optional(Schema.String),
  arrayValue: Schema.optional(
    Schema.Struct({
      values: Schema.optional(Schema.Array(Schema.suspend((): Schema.Codec<OtlpAttributeValue> => OtlpAttributeValue))),
    }),
  ),
  kvlistValue: Schema.optional(
    Schema.Struct({
      values: Schema.optional(Schema.Array(Schema.suspend((): Schema.Codec<OtlpAttribute> => OtlpAttribute))),
    }),
  ),
});

const OtlpAttribute = Schema.Struct({
  key: Schema.optional(Schema.String),
  value: Schema.optional(OtlpAttributeValue),
});

const OtlpAttributes = Schema.optional(Schema.Array(OtlpAttribute));

const OtlpSpan = Schema.Struct({
  traceId: Schema.optional(Schema.String),
  spanId: Schema.optional(Schema.String),
  parentSpanId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  kind: NumberOrString,
  startTimeUnixNano: Schema.optional(Schema.String),
  endTimeUnixNano: Schema.optional(Schema.String),
  attributes: OtlpAttributes,
  events: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        timeUnixNano: Schema.optional(Schema.String),
        attributes: OtlpAttributes,
      }),
    ),
  ),
  status: Schema.optional(Schema.Struct({ code: NumberOrString, message: Schema.optional(Schema.String) })),
});

const OtlpScopeSpans = Schema.Struct({
  scope: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
  spans: Schema.optional(Schema.Array(OtlpSpan)),
});

const OtlpResourceSpans = Schema.Struct({
  resource: Schema.optional(Schema.Struct({ attributes: OtlpAttributes })),
  scopeSpans: Schema.optional(Schema.Array(OtlpScopeSpans)),
  instrumentationLibrarySpans: Schema.optional(Schema.Array(OtlpScopeSpans)),
});

type OtlpResource = Schema.Schema.Type<typeof OtlpResourceSpans>['resource'];

const TempoTraceResponse = Schema.Struct({
  batches: Schema.optional(Schema.Array(OtlpResourceSpans)),
  resourceSpans: Schema.optional(Schema.Array(OtlpResourceSpans)),
});

const decodeAttributeValue = (value: OtlpAttributeValue | undefined): Json => {
  if (!value) return null;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.bytesValue !== undefined) return value.bytesValue;
  if (value.arrayValue?.values) {
    return value.arrayValue.values.map(decodeAttributeValue);
  }
  if (value.kvlistValue?.values) {
    return decodeAttributes(value.kvlistValue.values);
  }
  return null;
};

const decodeAttributes = (attrs: ReadonlyArray<OtlpAttribute> | undefined): JsonObject => {
  const out: JsonObjectDraft = {};
  if (!attrs) return out;
  for (const attr of attrs) {
    if (!attr.key) continue;
    out[attr.key] = decodeAttributeValue(attr.value);
  }
  return out;
};

const serviceNameFromResource = (resource: OtlpResource): string => {
  const attrs = decodeAttributes(resource?.attributes);
  const name = attrs['service.name'];
  return isJsonString(name) && name.length > 0 ? name : 'unknown';
};

const getTraceFromTempo = (
  client: HttpClient.HttpClient,
  baseUrl: string,
  models: Effect.Effect<ReadonlyArray<Model>>,
) =>
  Effect.fn('TracesService.getTraceFromTempo')(function* (traceId: string, options: GetTraceOptions = {}) {
    const data = yield* fetchJson(client, `${baseUrl}/api/traces/${encodeURIComponent(traceId)}`, TempoTraceResponse);
    const catalog = yield* models;
    const resourceSpans = data.batches ?? data.resourceSpans ?? [];
    const spans: TraceSpan[] = [];

    for (const batch of resourceSpans) {
      const serviceName = serviceNameFromResource(batch.resource);
      const groups = batch.scopeSpans ?? batch.instrumentationLibrarySpans ?? [];
      for (const group of groups) {
        const scopeName = group.scope?.name ?? '';
        for (const span of group.spans ?? []) {
          const attributes = decodeAttributes(span.attributes);
          const usage = spanUsage(attributes, catalog);
          spans.push({
            spanId: span.spanId ?? '',
            parentSpanId: span.parentSpanId && span.parentSpanId.length > 0 ? span.parentSpanId : null,
            traceId: span.traceId ?? traceId,
            name: span.name ?? 'unknown',
            serviceName,
            scopeName,
            kind: Predicate.isNumber(span.kind) ? span.kind : 0,
            startTimeUnixNano: span.startTimeUnixNano ?? '0',
            endTimeUnixNano: span.endTimeUnixNano ?? '0',
            attributes,
            events: (span.events ?? []).map((event) => ({
              name: event.name ?? '',
              timeUnixNano: event.timeUnixNano ?? '0',
              attributes: decodeAttributes(event.attributes),
            })),
            statusCode: Predicate.isNumber(span.status?.code) ? span.status.code : 0,
            statusMessage: span.status?.message ?? null,
            usage,
          });
        }
      }
    }

    const visibleSpans = filterTraceSpans(spans, options.all);
    const usage = rollUpUsage(visibleSpans.flatMap((span) => (span.usage ? [span.usage] : [])));
    return decodeTraceDetailResponse(
      usage ? { traceId, spans: visibleSpans, usage } : { traceId, spans: visibleSpans },
    );
  });

export const TracesService = Context.Service<TracesServiceApi>('@agentdock/api/TracesService');

export const TracesServiceLive = Layer.effect(
  TracesService,
  Effect.gen(function* () {
    const { baseUrl } = yield* TempoConfig;
    const client = yield* HttpClient.HttpClient;
    const catalog = yield* ModelCatalog;
    const list = listTracesFromTempo(client, baseUrl);
    const get = getTraceFromTempo(client, baseUrl, catalog.list);
    return TracesService.of({
      listTraces: Effect.fn('TracesService.listTraces')(function* (options: ListTracesOptions) {
        return yield* list(options);
      }),
      getTrace: Effect.fn('TracesService.getTrace')(function* (traceId: string, options: GetTraceOptions = {}) {
        return yield* get(traceId, options);
      }),
    });
  }),
);
