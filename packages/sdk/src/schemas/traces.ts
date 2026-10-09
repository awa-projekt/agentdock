import * as Schema from 'effect/Schema';
import * as SchemaGetter from 'effect/SchemaGetter';
import { JsonObject } from './json';
import { Usage } from './usage';

export const TraceId = Schema.String.pipe(Schema.brand('TraceId'));

export const TraceSummary = Schema.Struct({
  traceId: Schema.String,
  rootServiceName: Schema.String,
  rootTraceName: Schema.String,
  startTimeUnixNano: Schema.String,
  durationMs: Schema.Number,
});

export const TraceListResponse = Schema.Struct({
  traces: Schema.Array(TraceSummary),
});

export const TraceEvent = Schema.Struct({
  name: Schema.String,
  timeUnixNano: Schema.String,
  attributes: JsonObject,
});

export const TraceSpan = Schema.Struct({
  spanId: Schema.String,
  parentSpanId: Schema.NullOr(Schema.String),
  traceId: Schema.String,
  name: Schema.String,
  serviceName: Schema.String,
  scopeName: Schema.String,
  kind: Schema.Number,
  startTimeUnixNano: Schema.String,
  endTimeUnixNano: Schema.String,
  attributes: JsonObject,
  events: Schema.Array(TraceEvent),
  statusCode: Schema.Number,
  statusMessage: Schema.NullOr(Schema.String),
  /** Present on model-call spans that reported token counts. */
  usage: Schema.optional(Usage),
});

export const TraceDetailResponse = Schema.Struct({
  traceId: Schema.String,
  spans: Schema.Array(TraceSpan),
  /** Sum over the trace's model-call spans; absent when none reported usage. */
  usage: Schema.optional(Usage),
});

export const ListTracesQuery = Schema.Struct({
  service: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  q: Schema.optional(Schema.String),
});

const BooleanFromString = Schema.Literals(['true', 'false']).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === 'true'),
    encode: SchemaGetter.transform((value) => (value ? 'true' : 'false')),
  }),
);

export const GetTraceQuery = Schema.Struct({
  all: Schema.optional(BooleanFromString),
});

export class TracesOperationError extends Schema.TaggedError<TracesOperationError>()(
  'TracesOperationError',
  {
    message: Schema.String,
  },
  { httpApiStatus: 502 },
) {}

export type TraceId = Schema.Schema.Type<typeof TraceId>;
export type TraceSummary = Schema.Schema.Type<typeof TraceSummary>;
export type TraceListResponse = Schema.Schema.Type<typeof TraceListResponse>;
export type TraceEvent = Schema.Schema.Type<typeof TraceEvent>;
export type TraceSpan = Schema.Schema.Type<typeof TraceSpan>;
export type TraceDetailResponse = Schema.Schema.Type<typeof TraceDetailResponse>;
export type GetTraceQuery = Schema.Schema.Type<typeof GetTraceQuery>;
