import { Context, Data, Effect, Layer, Schema } from 'effect';
import type { ListTracesQuerySchema, TraceDetailResponse, TraceListResponse, TraceSpan } from './schemas';

type ListTracesOptions = Schema.Schema.Type<typeof ListTracesQuerySchema>;

type TracesServiceShape = {
  readonly listTraces: (options: ListTracesOptions) => Effect.Effect<TraceListResponse, unknown>;
  readonly getTrace: (traceId: string) => Effect.Effect<TraceDetailResponse, unknown>;
};

const DEFAULT_TEMPO_URL = 'http://127.0.0.1:3200';

const tempoBaseUrl = (): string => (process.env.TEMPO_URL ?? DEFAULT_TEMPO_URL).replace(/\/$/, '');
class TraceFetchError extends Data.TaggedError('TraceFetchError')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const toTraceFetchError = (cause: unknown): TraceFetchError =>
  cause instanceof TraceFetchError
    ? cause
    : new TraceFetchError({ message: 'Tempo request failed', cause });

type TempoSearchResponse = {
  readonly traces?: ReadonlyArray<{
    readonly traceID?: string;
    readonly rootServiceName?: string;
    readonly rootTraceName?: string;
    readonly startTimeUnixNano?: string;
    readonly durationMs?: number;
  }>;
};

const fetchJson = <T>(url: string): Effect.Effect<T, unknown> =>
  Effect.tryPromise({
    try: async () => {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new TraceFetchError({
        message: `Tempo request failed: ${response.status} ${response.statusText} ${body}`,
        cause: body,
      });
      }
      return (await response.json()) as T;
    },
    catch: toTraceFetchError,
  });

const listTracesFromTempo = Effect.fn('TracesService.listTracesFromTempo')(function* (
  options: ListTracesOptions,
) {
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
    params.set('q', '{}');
  }

  const data = yield* fetchJson<TempoSearchResponse>(`${tempoBaseUrl()}/api/search?${params.toString()}`);

  return {
    traces: (data.traces ?? []).map((trace) => ({
      traceId: trace.traceID ?? '',
      rootServiceName: trace.rootServiceName ?? 'unknown',
      rootTraceName: trace.rootTraceName ?? 'unknown',
      startTimeUnixNano: trace.startTimeUnixNano ?? '0',
      durationMs: typeof trace.durationMs === 'number' ? trace.durationMs : 0,
    })),
  };
});

type OtlpAttributeValue = {
  readonly stringValue?: string;
  readonly intValue?: string | number;
  readonly doubleValue?: number;
  readonly boolValue?: boolean;
  readonly arrayValue?: { readonly values?: ReadonlyArray<OtlpAttributeValue> };
  readonly kvlistValue?: { readonly values?: ReadonlyArray<OtlpAttribute> };
  readonly bytesValue?: string;
};

type OtlpAttribute = {
  readonly key?: string;
  readonly value?: OtlpAttributeValue;
};

type OtlpSpan = {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly name?: string;
  readonly kind?: number;
  readonly startTimeUnixNano?: string;
  readonly endTimeUnixNano?: string;
  readonly attributes?: ReadonlyArray<OtlpAttribute>;
  readonly events?: ReadonlyArray<{
    readonly name?: string;
    readonly timeUnixNano?: string;
    readonly attributes?: ReadonlyArray<OtlpAttribute>;
  }>;
  readonly status?: { readonly code?: number; readonly message?: string };
};

type OtlpScopeSpans = {
  readonly scope?: { readonly name?: string };
  readonly spans?: ReadonlyArray<OtlpSpan>;
};

type OtlpResourceSpans = {
  readonly resource?: { readonly attributes?: ReadonlyArray<OtlpAttribute> };
  readonly scopeSpans?: ReadonlyArray<OtlpScopeSpans>;
  readonly instrumentationLibrarySpans?: ReadonlyArray<OtlpScopeSpans>;
};

type TempoTraceResponse = {
  readonly batches?: ReadonlyArray<OtlpResourceSpans>;
  readonly resourceSpans?: ReadonlyArray<OtlpResourceSpans>;
};

const decodeAttributeValue = (value: OtlpAttributeValue | undefined): unknown => {
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

const decodeAttributes = (attrs: ReadonlyArray<OtlpAttribute> | undefined): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (!attrs) return out;
  for (const attr of attrs) {
    if (!attr.key) continue;
    out[attr.key] = decodeAttributeValue(attr.value);
  }
  return out;
};

const serviceNameFromResource = (resource: OtlpResourceSpans['resource']): string => {
  const attrs = decodeAttributes(resource?.attributes);
  const name = attrs['service.name'];
  return typeof name === 'string' && name.length > 0 ? name : 'unknown';
};

const getTraceFromTempo = Effect.fn('TracesService.getTraceFromTempo')(function* (traceId: string) {
  const data = yield* fetchJson<TempoTraceResponse>(`${tempoBaseUrl()}/api/traces/${encodeURIComponent(traceId)}`);
  const resourceSpans = data.batches ?? data.resourceSpans ?? [];
  const spans: TraceSpan[] = [];

  for (const batch of resourceSpans) {
    const serviceName = serviceNameFromResource(batch.resource);
    const groups = batch.scopeSpans ?? batch.instrumentationLibrarySpans ?? [];
    for (const group of groups) {
      const scopeName = group.scope?.name ?? '';
      for (const span of group.spans ?? []) {
        spans.push({
          spanId: span.spanId ?? '',
          parentSpanId: span.parentSpanId && span.parentSpanId.length > 0 ? span.parentSpanId : null,
          traceId: span.traceId ?? traceId,
          name: span.name ?? 'unknown',
          serviceName,
          scopeName,
          kind: typeof span.kind === 'number' ? span.kind : 0,
          startTimeUnixNano: span.startTimeUnixNano ?? '0',
          endTimeUnixNano: span.endTimeUnixNano ?? '0',
          attributes: decodeAttributes(span.attributes),
          events: (span.events ?? []).map((event) => ({
            name: event.name ?? '',
            timeUnixNano: event.timeUnixNano ?? '0',
            attributes: decodeAttributes(event.attributes),
          })),
          statusCode: typeof span.status?.code === 'number' ? span.status.code : 0,
          statusMessage: span.status?.message ?? null,
        });
      }
    }
  }

  return { traceId, spans };
});

export const TracesService = Context.Service<TracesServiceShape>('@agentdock/api/TracesService');

export const TracesServiceLive = Layer.effect(
  TracesService,
  Effect.gen(function* () {
    return TracesService.of({
      listTraces: Effect.fn('TracesService.listTraces')(function* (options: ListTracesOptions) {
        return yield* listTracesFromTempo(options);
      }),
      getTrace: Effect.fn('TracesService.getTrace')(function* (traceId: string) {
        return yield* getTraceFromTempo(traceId);
      }),
    });
  }),
);
