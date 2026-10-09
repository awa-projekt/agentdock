import type { JsonObject, TraceSpan, Usage } from 'agentdock-sdk/schemas';
import { describe, expect, it } from 'vitest';
import { buildSpanTree, collapseAiSdkInternalSpans } from './trace-spans';

const span = ({
  spanId,
  parentSpanId = null,
  name = spanId,
  start = '0',
  attributes = {},
  usage,
}: {
  readonly spanId: string;
  readonly parentSpanId?: string | null;
  readonly name?: string;
  readonly start?: string;
  readonly attributes?: JsonObject;
  readonly usage?: Usage;
}): TraceSpan => {
  const value: TraceSpan = {
    spanId,
    parentSpanId,
    traceId: 'trace',
    name,
    serviceName: 'api',
    scopeName: 'test',
    kind: 0,
    startTimeUnixNano: start,
    endTimeUnixNano: String(BigInt(start) + 1n),
    attributes,
    events: [],
    statusCode: 0,
    statusMessage: null,
  };
  return usage ? { ...value, usage } : value;
};

describe('buildSpanTree', () => {
  it('orders roots and children by start time and assigns depth', () => {
    const roots = buildSpanTree([
      span({ spanId: 'late-child', parentSpanId: 'root', start: '30' }),
      span({ spanId: 'later-root', start: '40' }),
      span({ spanId: 'root', start: '10' }),
      span({ spanId: 'early-child', parentSpanId: 'root', start: '20' }),
      span({ spanId: 'grandchild', parentSpanId: 'early-child', start: '25' }),
    ]);

    expect(roots.map(({ spanId, depth }) => ({ spanId, depth }))).toEqual([
      { spanId: 'root', depth: 0 },
      { spanId: 'later-root', depth: 0 },
    ]);
    expect(roots[0]?.children.map(({ spanId, depth }) => ({ spanId, depth }))).toEqual([
      { spanId: 'early-child', depth: 1 },
      { spanId: 'late-child', depth: 1 },
    ]);
    expect(roots[0]?.children[0]?.children[0]?.depth).toBe(2);
  });
});

describe('collapseAiSdkInternalSpans', () => {
  it('hides doStream children and fills missing model and usage on the parent', () => {
    const usage: Usage = {
      tokens: { input: 12, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 16 },
      cost: 0.001,
    };
    const tree = buildSpanTree([
      span({ spanId: 'parent', name: 'ai.streamText', start: '10' }),
      span({
        spanId: 'internal',
        parentSpanId: 'parent',
        name: 'ai.streamText.doStream',
        start: '20',
        attributes: { 'gen_ai.request.model': 'anthropic:claude' },
        usage,
      }),
      span({ spanId: 'tool', parentSpanId: 'internal', name: 'agentdock.tools.call', start: '30' }),
    ]);

    const collapsed = collapseAiSdkInternalSpans(tree);

    expect(collapsed[0]?.usage).toEqual(usage);
    expect(collapsed[0]?.attributes['gen_ai.request.model']).toBe('anthropic:claude');
    expect(collapsed[0]?.children.map((child) => child.spanId)).toEqual(['tool']);
    expect(collapsed[0]?.children[0]?.depth).toBe(1);
  });
});
