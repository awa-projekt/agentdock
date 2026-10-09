import { whenPresent } from '@integragents/contracts';
import type { TraceFile, TraceRecord } from '@integragents/observability';
import { type Attributes, type HrTime, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';

const kinds = {
  [SpanKind.INTERNAL]: 'internal',
  [SpanKind.SERVER]: 'server',
  [SpanKind.CLIENT]: 'client',
  [SpanKind.PRODUCER]: 'producer',
  [SpanKind.CONSUMER]: 'consumer',
} satisfies Record<SpanKind, TraceRecord['kind']>;

const millisOf = ([seconds, nanos]: HrTime): number => seconds * 1000 + nanos / 1_000_000;

const isoOf = (time: HrTime): string => DateTime.formatIso(DateTime.makeUnsafe(millisOf(time)));

const jsonAttributes = (attributes: Attributes): TraceRecord['attributes'] => {
  const json: Record<string, TraceRecord['attributes'][string]> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    json[key] = Array.isArray(value) ? value.map((item) => item ?? null) : value;
  }
  return json;
};

const isException = (event: ReadableSpan['events'][number]): boolean => event.name === 'exception';

const outcomeOf = (span: ReadableSpan): Pick<TraceRecord, 'outcome' | 'cause'> => {
  if (span.attributes['status.interrupted'] === true) return { outcome: 'interrupted' };
  if (span.status.code !== SpanStatusCode.ERROR) return { outcome: 'success' };
  const stacks = span.events.filter(isException).map((event) => String(event.attributes?.['exception.stacktrace']));
  return {
    outcome: 'failure',
    cause: stacks.length > 0 ? stacks.join('\n\n') : (span.status.message ?? 'Unknown error'),
  };
};

/** One finished OpenTelemetry span in the trace file's shape, whether Effect or a library created it. */
const traceRecordOf = (service: string, span: ReadableSpan): TraceRecord => ({
  service,
  name: span.name,
  kind: kinds[span.kind],
  traceId: span.spanContext().traceId,
  spanId: span.spanContext().spanId,
  ...whenPresent('parentSpanId', span.parentSpanContext?.spanId),
  start: isoOf(span.startTime),
  durationMs: millisOf(span.duration),
  ...outcomeOf(span),
  attributes: jsonAttributes(span.attributes),
  events: span.events
    .filter((event) => !isException(event))
    .map((event) => ({
      name: event.name,
      time: isoOf(event.time),
      attributes: jsonAttributes(event.attributes ?? {}),
    })),
});

export const traceFileSpanProcessor = (service: string, file: TraceFile['Service']): SpanProcessor => ({
  onStart: () => undefined,
  onEnd: (span) => file.record(traceRecordOf(service, span)),
  forceFlush: () => Effect.runPromise(file.flush),
  shutdown: () => Effect.runPromise(file.flush),
});
