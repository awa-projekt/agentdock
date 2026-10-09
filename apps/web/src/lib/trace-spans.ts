import { isJsonString, type JsonObject, type TraceSpan } from 'agentdock-sdk/schemas';

const LLM_ATTRIBUTE_KEYS = [
  'ai.prompt',
  'ai.prompt.messages',
  'ai.prompt.format',
  'ai.response.text',
  'ai.response.object',
  'ai.response.toolCalls',
  'ai.response.finishReason',
  'ai.response.providerMetadata',
  'ai.model.id',
  'ai.model.provider',
  'ai.usage.inputTokens',
  'ai.usage.outputTokens',
  'ai.usage.totalTokens',
  'gen_ai.system',
  'gen_ai.operation.name',
  'gen_ai.prompt',
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.total_tokens',
  'llm.request.type',
  'llm.invocation_parameters',
] as const;

const LLM_ATTRIBUTE_PREFIXES = ['gen_ai.prompt.', 'gen_ai.completion.', 'gen_ai.usage.'] as const;
const USAGE_ATTRIBUTE_PREFIXES = ['gen_ai.usage.', 'ai.usage.'] as const;
const MODEL_ATTRIBUTE_KEYS = ['gen_ai.request.model', 'ai.model.id'] as const;
const AI_SDK_PARENT_NAMES = new Set(['ai.streamText', 'ai.generateText', 'ai.streamObject', 'ai.generateObject']);

export const isLlmAttributeKey = (key: string): boolean =>
  LLM_ATTRIBUTE_KEYS.some((attributeKey) => attributeKey === key) ||
  LLM_ATTRIBUTE_PREFIXES.some((prefix) => key.startsWith(prefix));

export const isUsageAttributeKey = (key: string): boolean =>
  USAGE_ATTRIBUTE_PREFIXES.some((prefix) => key.startsWith(prefix));

export const spanDurationMs = (span: TraceSpan): number => {
  if (span.startTimeUnixNano === '0' || span.endTimeUnixNano === '0') return 0;
  return Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000;
};

export const isLlmSpan = (span: TraceSpan): boolean =>
  span.name.startsWith('ai.') ||
  Object.keys(span.attributes).some((key) => key.startsWith('ai.') || key.startsWith('gen_ai.'));

export const spanModel = (span: TraceSpan): string | null => {
  for (const key of MODEL_ATTRIBUTE_KEYS) {
    const value = span.attributes[key];
    if (isJsonString(value) && value.length > 0) return value;
  }
  return null;
};

export type SpanNode = TraceSpan & { readonly children: ReadonlyArray<SpanNode>; readonly depth: number };

const compareStart = (left: TraceSpan, right: TraceSpan): number =>
  Number(BigInt(left.startTimeUnixNano) - BigInt(right.startTimeUnixNano));

export const buildSpanTree = (spans: ReadonlyArray<TraceSpan>): ReadonlyArray<SpanNode> => {
  type MutableSpanNode = TraceSpan & { children: MutableSpanNode[]; depth: number };
  const byId = new Map<string, MutableSpanNode>();
  for (const span of spans) byId.set(span.spanId, { ...span, children: [], depth: 0 });

  const roots: MutableSpanNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentSpanId ? byId.get(node.parentSpanId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const order = (nodes: MutableSpanNode[], depth: number): void => {
    nodes.sort(compareStart);
    for (const node of nodes) {
      node.depth = depth;
      order(node.children, depth + 1);
    }
  };
  order(roots, 0);
  return roots;
};

export const flattenSpanTree = (
  nodes: ReadonlyArray<SpanNode>,
  expanded: ReadonlySet<string>,
): ReadonlyArray<SpanNode> => {
  const flattened: SpanNode[] = [];
  const visit = (node: SpanNode): void => {
    flattened.push(node);
    if (expanded.has(node.spanId)) node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return flattened;
};

const isAiSdkInternalChild = (parent: SpanNode, child: SpanNode): boolean =>
  AI_SDK_PARENT_NAMES.has(parent.name) &&
  (child.name === `${parent.name}.doStream` || child.name === `${parent.name}.doGenerate`);

const mergeModelAttributes = (parent: JsonObject, child: JsonObject): JsonObject => {
  const merged = { ...parent };
  for (const key of MODEL_ATTRIBUTE_KEYS) {
    if (merged[key] === undefined && child[key] !== undefined) merged[key] = child[key];
  }
  return merged;
};

export const collapseAiSdkInternalSpans = (nodes: ReadonlyArray<SpanNode>): ReadonlyArray<SpanNode> => {
  const collapse = (node: SpanNode, depth: number): SpanNode => {
    const internalChildren = node.children.filter((child) => isAiSdkInternalChild(node, child));
    const visibleChildren = node.children.flatMap((child) =>
      isAiSdkInternalChild(node, child) ? child.children : [child],
    );
    const attributes = internalChildren.reduce(
      (current, child) => mergeModelAttributes(current, child.attributes),
      node.attributes,
    );
    const usage = internalChildren.find((child) => child.usage)?.usage;
    const children = visibleChildren.map((child) => collapse(child, depth + 1)).sort(compareStart);
    const collapsed = {
      ...node,
      attributes,
      children,
      depth,
    };
    return !node.usage && usage ? { ...collapsed, usage } : collapsed;
  };
  return nodes.map((node) => collapse(node, 0)).sort(compareStart);
};
