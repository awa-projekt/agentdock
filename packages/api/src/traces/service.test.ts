import type { TraceSpan } from 'agentdock-sdk/schemas';
import { describe, expect, it } from 'vitest';
import { filterTraceSpans } from './service';

const span = (spanId: string, name: string, parentSpanId: string | null): TraceSpan => ({
  spanId,
  parentSpanId,
  traceId: 'trace',
  name,
  serviceName: 'api',
  scopeName: 'test',
  kind: 0,
  startTimeUnixNano: '0',
  endTimeUnixNano: '1',
  attributes: {},
  events: [],
  statusCode: 0,
  statusMessage: null,
});

const spans = [
  span('kept-root', 'agentdock.workflow.run', null),
  span('dropped-middle', 'Effect.fn.internal', 'kept-root'),
  span('kept-grandchild', 'ai.streamText', 'dropped-middle'),
  span('dropped-root', 'agentdock.http.request', null),
  span('kept-child', 'agentdock.tools.execute', 'dropped-root'),
];

describe('filterTraceSpans', () => {
  it('re-parents kept spans to their nearest kept ancestor', () => {
    const filtered = filterTraceSpans(spans);

    expect(filtered.map(({ spanId, parentSpanId }) => ({ spanId, parentSpanId }))).toEqual([
      { spanId: 'kept-root', parentSpanId: null },
      { spanId: 'kept-grandchild', parentSpanId: 'kept-root' },
      { spanId: 'kept-child', parentSpanId: null },
    ]);
  });

  it('keeps every span when all is enabled', () => {
    expect(filterTraceSpans(spans, true)).toEqual(spans);
  });
});
