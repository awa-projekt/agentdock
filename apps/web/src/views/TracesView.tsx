import type { TraceDetailResponse, Usage } from 'agentdock-sdk/schemas';
import type { Json } from 'agentdock-sdk/schemas/json';
import { decodeJsonStringOption, isJsonString } from 'agentdock-sdk/schemas/json';
import * as Option from 'effect/Option';
import { ChevronRight, RefreshCw, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { DetailSkeleton, ListSkeleton } from '@/components/Loading';
import { MasterDetail } from '@/components/MasterDetail';
import { SectionHeader } from '@/components/SectionHeader';
import { SelectableCard } from '@/components/SelectableCard';
import { ErrorBanner } from '@/components/StatusMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  formatCost,
  formatDuration,
  formatInteger,
  formatRelative,
  formatTokens,
  formatUnixNano,
  toErrorMessage,
} from '@/lib/format';
import { useTrace, useTraces } from '@/lib/queries';
import {
  buildSpanTree,
  collapseAiSdkInternalSpans,
  flattenSpanTree,
  isLlmAttributeKey,
  isLlmSpan,
  isUsageAttributeKey,
  type SpanNode,
  spanDurationMs,
  spanModel,
} from '@/lib/trace-spans';
import { cn } from '@/lib/utils';

const GRIDLINE_FRACTIONS = [0, 0.25, 0.5, 0.75, 1] as const;

const stringifyValue = (value: Json | undefined): string => {
  if (value === null || value === undefined) return '';
  if (isJsonString(value)) {
    return Option.match(decodeJsonStringOption(value), {
      onNone: () => value,
      onSome: (parsed) => JSON.stringify(parsed, null, 2),
    });
  }
  return JSON.stringify(value, null, 2);
};
export function TracesView() {
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [showInternal, setShowInternal] = useState(false);
  const [allSpans, setAllSpans] = useState(false);

  const tracesQuery = useTraces();
  const traces = tracesQuery.data ?? [];
  const activeTraceId = selectedTraceId ?? traces[0]?.traceId ?? null;
  const traceQuery = useTrace(activeTraceId, allSpans);
  const traceDetail = traceQuery.data;

  useEffect(() => {
    setSelectedSpanId(null);
  }, [activeTraceId, allSpans]);

  useEffect(() => {
    if (traceDetail) setExpanded(new Set(traceDetail.spans.map((span) => span.spanId)));
  }, [traceDetail]);

  const filteredTraces = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return traces;
    return traces.filter(
      (trace) =>
        trace.rootTraceName.toLowerCase().includes(needle) ||
        trace.rootServiceName.toLowerCase().includes(needle) ||
        trace.traceId.toLowerCase().includes(needle),
    );
  }, [filter, traces]);

  const toggleExpanded = useCallback((spanId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(spanId)) next.delete(spanId);
      else next.add(spanId);
      return next;
    });
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col gap-6">
      <SectionHeader title="Traces" description="Inspect agent, workflow, tool, and LLM activity in Tempo traces." />

      <MasterDetail
        master={
          <>
            <div className="flex shrink-0 items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter by span name, service, or id"
                  className="pl-8"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => void tracesQuery.refetch()}
                title="Refresh"
              >
                <RefreshCw className="size-4" />
              </Button>
            </div>

            {tracesQuery.isPending ? (
              <ListSkeleton compact />
            ) : tracesQuery.isError ? (
              <ErrorBanner>{toErrorMessage(tracesQuery.error, 'Could not load traces.')}</ErrorBanner>
            ) : filteredTraces.length === 0 ? (
              <EmptyState
                title="No traces"
                description="Send a task to an agent, then refresh to see its agent and LLM activity."
              />
            ) : (
              <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
                {filteredTraces.map((trace) => {
                  const isActive = trace.traceId === activeTraceId;
                  return (
                    <li key={trace.traceId}>
                      <SelectableCard
                        onClick={() => setSelectedTraceId(trace.traceId)}
                        active={isActive}
                        className="flex flex-col gap-1 px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">{trace.rootTraceName}</span>
                          <Badge variant="outline" className="shrink-0 tabular-nums">
                            {formatDuration(trace.durationMs)}
                          </Badge>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span className="truncate">{trace.rootServiceName}</span>
                          <span>{formatRelative(trace.startTimeUnixNano)}</span>
                        </div>
                        <code className="truncate font-mono text-[10px] text-muted-foreground">{trace.traceId}</code>
                      </SelectableCard>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        }
        detail={
          tracesQuery.isPending ? (
            <DetailSkeleton />
          ) : activeTraceId === null ? (
            <EmptyState title="Select a trace" description="Choose a trace to inspect its spans." />
          ) : traceQuery.isError ? (
            <ErrorBanner>{toErrorMessage(traceQuery.error, 'Could not load trace.')}</ErrorBanner>
          ) : !traceDetail ? (
            <DetailSkeleton />
          ) : (
            <TraceDetail
              detail={traceDetail}
              expanded={expanded}
              selectedSpanId={selectedSpanId}
              showInternal={showInternal}
              allSpans={allSpans}
              onToggle={toggleExpanded}
              onSelect={setSelectedSpanId}
              onShowInternalChange={setShowInternal}
              onAllSpansChange={setAllSpans}
            />
          )
        }
      />
    </div>
  );
}

function UsageSummary({ usage, className }: { usage: Usage; className?: string }) {
  const { tokens, cost } = usage;
  return (
    <div className={cn('flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs tabular-nums', className)}>
      <span title={`${formatInteger(tokens.input)} input tokens (cached portion included)`}>
        <span className="font-medium text-foreground">{formatTokens(tokens.input)}</span> in
      </span>
      {tokens.cacheRead > 0 ? (
        <span title={`${formatInteger(tokens.cacheRead)} input tokens served from the prompt cache`}>
          <span className="font-medium text-foreground">{formatTokens(tokens.cacheRead)}</span> cached
        </span>
      ) : null}
      {tokens.cacheWrite > 0 ? (
        <span title={`${formatInteger(tokens.cacheWrite)} input tokens written to the prompt cache`}>
          <span className="font-medium text-foreground">{formatTokens(tokens.cacheWrite)}</span> cache write
        </span>
      ) : null}
      <span title={`${formatInteger(tokens.output)} output tokens`}>
        <span className="font-medium text-foreground">{formatTokens(tokens.output)}</span> out
      </span>
      {tokens.reasoning > 0 ? (
        <span title={`${formatInteger(tokens.reasoning)} reasoning tokens (part of the output)`}>
          <span className="font-medium text-foreground">{formatTokens(tokens.reasoning)}</span> reasoning
        </span>
      ) : null}
      {cost === undefined ? (
        <span title="models.dev has no rates for this model">cost n/a</span>
      ) : (
        <span className="font-medium text-foreground">{formatCost(cost)}</span>
      )}
    </div>
  );
}

function TraceDetail({
  detail,
  expanded,
  selectedSpanId,
  showInternal,
  allSpans,
  onToggle,
  onSelect,
  onShowInternalChange,
  onAllSpansChange,
}: {
  detail: TraceDetailResponse;
  expanded: ReadonlySet<string>;
  selectedSpanId: string | null;
  showInternal: boolean;
  allSpans: boolean;
  onToggle: (spanId: string) => void;
  onSelect: (spanId: string | null) => void;
  onShowInternalChange: (show: boolean) => void;
  onAllSpansChange: (show: boolean) => void;
}) {
  const fullTree = useMemo(() => buildSpanTree(detail.spans), [detail.spans]);
  const spanTree = useMemo(
    () => (showInternal ? fullTree : collapseAiSdkInternalSpans(fullTree)),
    [fullTree, showInternal],
  );
  const flatSpans = useMemo(() => flattenSpanTree(spanTree, expanded), [expanded, spanTree]);
  const selectedSpan = useMemo(() => {
    if (!selectedSpanId) return null;
    const pending = [...spanTree];
    while (pending.length > 0) {
      const span = pending.shift();
      if (!span) break;
      if (span.spanId === selectedSpanId) return span;
      pending.push(...span.children);
    }
    return null;
  }, [selectedSpanId, spanTree]);

  const { startNs, durationMs } = useMemo(() => {
    let start = BigInt(detail.spans[0]?.startTimeUnixNano ?? '0');
    let end = BigInt(detail.spans[0]?.endTimeUnixNano ?? '0');
    for (const span of detail.spans) {
      const spanStart = BigInt(span.startTimeUnixNano);
      const spanEnd = BigInt(span.endTimeUnixNano);
      if (spanStart < start) start = spanStart;
      if (spanEnd > end) end = spanEnd;
    }
    return { startNs: start, durationMs: Number(end - start) / 1_000_000 };
  }, [detail.spans]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
        <code className="text-xs text-muted-foreground">{detail.traceId}</code>
        <span className="text-sm text-muted-foreground">
          {detail.spans.length} spans · {formatDuration(durationMs)}
        </span>
        {detail.usage ? <UsageSummary usage={detail.usage} className="text-muted-foreground" /> : null}
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant={showInternal ? 'outline' : 'ghost'}
            aria-pressed={showInternal}
            onClick={() => onShowInternalChange(!showInternal)}
          >
            Show internal spans
          </Button>
          <Button
            type="button"
            size="sm"
            variant={allSpans ? 'outline' : 'ghost'}
            aria-pressed={allSpans}
            onClick={() => onAllSpansChange(!allSpans)}
          >
            All spans
          </Button>
        </div>
      </div>

      {detail.spans.length === 0 ? (
        <EmptyState title="No matching spans" description="Enable All spans to inspect the full Tempo trace." />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-md border">
          <div className="relative grid min-w-[760px] grid-cols-[minmax(0,340px)_1fr] text-xs">
            <div className="sticky top-0 z-20 flex h-7 items-center border-b bg-card px-2 font-medium">Span</div>
            <div className="sticky top-0 z-20 h-7 border-b bg-card">
              {GRIDLINE_FRACTIONS.map((fraction) => (
                <span
                  key={fraction}
                  className={cn(
                    'absolute top-1.5 font-mono text-[10px] text-muted-foreground tabular-nums',
                    fraction === 0 ? 'left-0' : fraction === 1 ? 'right-0' : '-translate-x-1/2',
                  )}
                  style={fraction > 0 && fraction < 1 ? { left: `${fraction * 100}%` } : undefined}
                >
                  {fraction === 0 ? '0' : formatDuration(durationMs * fraction)}
                </span>
              ))}
            </div>

            <div className="pointer-events-none absolute inset-y-0 left-0 right-0 z-0 col-start-2 col-end-3">
              {GRIDLINE_FRACTIONS.map((fraction) => (
                <span
                  key={fraction}
                  className="absolute inset-y-0 w-px bg-border/60"
                  style={{ left: `${fraction * 100}%` }}
                />
              ))}
            </div>

            {flatSpans.map((span, index) => (
              <WaterfallRow
                key={span.spanId}
                span={span}
                index={index}
                startNs={startNs}
                totalDurationMs={durationMs}
                expanded={expanded.has(span.spanId)}
                selected={selectedSpanId === span.spanId}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      )}

      {selectedSpan ? <SelectedSpanDetails span={selectedSpan} onClose={() => onSelect(null)} /> : null}
    </div>
  );
}

function WaterfallRow({
  span,
  index,
  startNs,
  totalDurationMs,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  span: SpanNode;
  index: number;
  startNs: bigint;
  totalDurationMs: number;
  expanded: boolean;
  selected: boolean;
  onToggle: (spanId: string) => void;
  onSelect: (spanId: string) => void;
}) {
  const durationMs = spanDurationMs(span);
  const offsetMs = Math.max(0, Number(BigInt(span.startTimeUnixNano) - startNs) / 1_000_000);
  const offsetPct = totalDurationMs > 0 ? Math.min(100, (offsetMs / totalDurationMs) * 100) : 0;
  const widthPct = totalDurationMs > 0 ? Math.min(100 - offsetPct, (durationMs / totalDurationMs) * 100) : 0;
  const llm = isLlmSpan(span);
  const model = llm ? spanModel(span) : null;
  const rowBackground = selected
    ? 'bg-primary/10'
    : index % 2 === 1
      ? 'bg-muted/20 group-hover:bg-muted/50'
      : 'group-hover:bg-muted/50';
  const barColor =
    span.statusCode === 2
      ? 'bg-destructive'
      : llm
        ? 'bg-violet-500'
        : span.name.startsWith('agentdock.a2a.')
          ? 'bg-muted-foreground/50'
          : 'bg-primary';

  return (
    <div className="group contents">
      <div className={cn('relative z-10 flex h-7 min-w-0 items-center transition-colors', rowBackground)}>
        <div className="flex shrink-0 items-center" style={{ paddingLeft: span.depth * 14 + 4 }}>
          {span.children.length > 0 ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-5"
              aria-expanded={expanded}
              aria-label={expanded ? `Collapse ${span.name}` : `Expand ${span.name}`}
              onClick={() => onToggle(span.spanId)}
            >
              <ChevronRight className={cn('transition-transform', expanded && 'rotate-90')} />
            </Button>
          ) : (
            <span className="size-5" />
          )}
        </div>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 pr-2 text-left"
          onClick={() => onSelect(span.spanId)}
        >
          <span className={cn('truncate', span.statusCode === 2 && 'text-destructive')}>{span.name}</span>
          {model ? (
            <Badge variant="secondary" className="max-w-32 shrink truncate px-1.5 py-0 font-mono text-[10px]">
              {model}
            </Badge>
          ) : null}
          {span.usage ? (
            <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
              {formatTokens(span.usage.tokens.input)} in · {formatTokens(span.usage.tokens.output)} out
            </span>
          ) : null}
        </button>
      </div>
      <button
        type="button"
        className={cn('relative z-10 h-7 text-left transition-colors', rowBackground)}
        onClick={() => onSelect(span.spanId)}
      >
        <span
          className={cn('absolute top-1.5 h-4 rounded-sm', barColor)}
          style={{ left: `${offsetPct}%`, width: `${widthPct}%`, minWidth: '2px' }}
        />
        <span
          className={cn(
            'absolute top-1.5 flex h-4 items-center whitespace-nowrap font-mono text-[10px] leading-none tabular-nums',
            widthPct >= 18 ? 'text-primary-foreground' : 'text-muted-foreground',
          )}
          style={
            widthPct >= 18
              ? { left: `calc(${offsetPct}% + 4px)` }
              : { left: `min(calc(${offsetPct + widthPct}% + 4px), calc(100% - 42px))` }
          }
        >
          {formatDuration(durationMs)}
        </span>
      </button>
    </div>
  );
}

function SelectedSpanDetails({ span, onClose }: { span: SpanNode; onClose: () => void }) {
  return (
    <div className="flex max-h-[45%] min-h-32 shrink-0 flex-col overflow-hidden rounded-md border bg-muted/20">
      <div className="flex shrink-0 items-center gap-3 border-b px-3 py-2">
        <span className="truncate text-sm font-medium">{span.name}</span>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {formatDuration(spanDurationMs(span))}
        </span>
        {span.usage ? <UsageSummary usage={span.usage} className="text-muted-foreground" /> : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          onClick={onClose}
          title="Close details"
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 overflow-y-auto">
        <SpanDetails span={span} isLlm={isLlmSpan(span)} />
      </div>
    </div>
  );
}

function SpanDetails({ span, isLlm }: { span: SpanNode; isLlm: boolean }) {
  const llmAttrs: Array<[string, Json]> = useMemo(() => {
    if (!isLlm) return [];
    // The raw token attributes are already rendered structurally on the span
    // row, so they'd only repeat here as one pre-formatted block per number.
    return Object.entries(span.attributes).filter(
      ([key]) => isLlmAttributeKey(key) && !(span.usage && isUsageAttributeKey(key)),
    );
  }, [isLlm, span.attributes, span.usage]);

  const otherAttrs = useMemo(
    () => Object.entries(span.attributes).filter(([key]) => !isLlmAttributeKey(key)),
    [span.attributes],
  );

  return (
    <div className="p-3">
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{span.serviceName}</span>
        {span.scopeName ? <span>{span.scopeName}</span> : null}
        <span>{formatUnixNano(span.startTimeUnixNano)}</span>
      </div>
      {llmAttrs.length > 0 ? (
        <div className="mb-3 flex flex-col gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">LLM</div>
          {llmAttrs.map(([key, value]) => (
            <AttributeBlock key={key} name={key} value={value} pretty />
          ))}
        </div>
      ) : null}
      {span.events.length > 0 ? (
        <div className="mb-3 flex flex-col gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Events</div>
          {span.events.map((event) => (
            <div key={`${event.name}-${event.timeUnixNano}`} className="rounded-md border bg-background p-2 text-xs">
              <div className="font-medium">{event.name}</div>
              {Object.keys(event.attributes).length > 0 ? (
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
                  {stringifyValue(event.attributes)}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {otherAttrs.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Attributes</div>
          <div className="grid gap-1 text-xs">
            {otherAttrs.map(([key, value]) => (
              <AttributeBlock key={key} name={key} value={value} />
            ))}
          </div>
        </div>
      ) : null}
      {span.statusMessage ? (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
          {span.statusMessage}
        </div>
      ) : null}
    </div>
  );
}

function AttributeBlock({ name, value, pretty = false }: { name: string; value: Json; pretty?: boolean }) {
  const text = stringifyValue(value);
  const isMultiline = text.includes('\n') || text.length > 80;
  if (pretty || isMultiline) {
    return (
      <div className="rounded-md border bg-background p-2">
        <div className="font-mono text-[11px] text-muted-foreground">{name}</div>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">{text}</pre>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_2fr] items-baseline gap-2">
      <code className="truncate font-mono text-[11px] text-muted-foreground">{name}</code>
      <code className="truncate font-mono text-[11px]">{text}</code>
    </div>
  );
}
