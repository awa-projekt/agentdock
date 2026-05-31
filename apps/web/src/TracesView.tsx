import { ChevronDown, ChevronRight, RefreshCw, Search, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getTrace, listTraces } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { TraceDetailResponse, TraceSpan, TraceSummary } from "agentdock-sdk/api";

type Loadable<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

const LLM_ATTRIBUTE_KEYS = [
  "ai.prompt",
  "ai.prompt.messages",
  "ai.prompt.format",
  "ai.response.text",
  "ai.response.object",
  "ai.response.toolCalls",
  "ai.response.finishReason",
  "ai.response.providerMetadata",
  "ai.model.id",
  "ai.model.provider",
  "ai.usage.inputTokens",
  "ai.usage.outputTokens",
  "ai.usage.totalTokens",
  "gen_ai.system",
  "gen_ai.request.model",
  "gen_ai.response.model",
];

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const formatTimestamp = (unixNano: string): string => {
  if (!unixNano || unixNano === "0") return "—";
  const millis = Number(BigInt(unixNano) / 1_000_000n);
  if (!Number.isFinite(millis)) return "—";
  return new Date(millis).toLocaleString();
};

const formatRelative = (unixNano: string): string => {
  if (!unixNano || unixNano === "0") return "—";
  const millis = Number(BigInt(unixNano) / 1_000_000n);
  if (!Number.isFinite(millis)) return "—";
  const diffMs = Date.now() - millis;
  if (diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

const formatDuration = (ms: number): string => {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

const spanDurationMs = (span: TraceSpan): number => {
  if (span.startTimeUnixNano === "0" || span.endTimeUnixNano === "0") return 0;
  const start = BigInt(span.startTimeUnixNano);
  const end = BigInt(span.endTimeUnixNano);
  return Number((end - start) / 1_000_000n);
};

const isLlmSpan = (span: TraceSpan): boolean => {
  if (span.name.includes("streamText") || span.name.includes("generateText") || span.name.startsWith("ai.")) return true;
  return Object.keys(span.attributes).some((key) => key.startsWith("ai.") || key.startsWith("gen_ai."));
};

const stringifyValue = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

type SpanNode = TraceSpan & { children: SpanNode[]; depth: number };

const buildSpanTree = (spans: ReadonlyArray<TraceSpan>): SpanNode[] => {
  const byId = new Map<string, SpanNode>();
  for (const span of spans) {
    byId.set(span.spanId, { ...span, children: [], depth: 0 });
  }
  const roots: SpanNode[] = [];
  for (const node of byId.values()) {
    if (node.parentSpanId && byId.has(node.parentSpanId)) {
      const parent = byId.get(node.parentSpanId);
      if (parent) {
        node.depth = parent.depth + 1;
        parent.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }
  const sortChildren = (node: SpanNode) => {
    node.children.sort((a, b) => Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano)));
    for (const child of node.children) {
      child.depth = node.depth + 1;
      sortChildren(child);
    }
  };
  roots.sort((a, b) => Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano)));
  for (const root of roots) sortChildren(root);
  return roots;
};

const flattenSpanTree = (nodes: ReadonlyArray<SpanNode>, expanded: ReadonlySet<string>): SpanNode[] => {
  const out: SpanNode[] = [];
  const walk = (node: SpanNode) => {
    out.push(node);
    if (expanded.has(node.spanId)) {
      for (const child of node.children) walk(child);
    }
  };
  for (const node of nodes) walk(node);
  return out;
};

export function TracesView() {
  const [tracesState, setTracesState] = useState<Loadable<ReadonlyArray<TraceSummary>>>({ status: "loading" });
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [traceState, setTraceState] = useState<Loadable<TraceDetailResponse>>({ status: "idle" });
  const [filter, setFilter] = useState<string>("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadTraces = useCallback(async () => {
    setTracesState({ status: "loading" });
    try {
      const { traces } = await listTraces({ limit: 100 });
      setTracesState({ status: "ready", data: traces });
      if (traces[0] && !selectedTraceId) {
        setSelectedTraceId(traces[0].traceId);
      }
    } catch (error) {
      setTracesState({ status: "error", message: toErrorMessage(error, "Could not load traces.") });
    }
  }, [selectedTraceId]);

  useEffect(() => {
    void loadTraces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadTrace = useCallback(async (traceId: string) => {
    setTraceState({ status: "loading" });
    try {
      const detail = await getTrace(traceId);
      setTraceState({ status: "ready", data: detail });
      setExpanded(new Set(detail.spans.map((span) => span.spanId)));
    } catch (error) {
      setTraceState({ status: "error", message: toErrorMessage(error, "Could not load trace.") });
    }
  }, []);

  useEffect(() => {
    if (!selectedTraceId) {
      setTraceState({ status: "idle" });
      return;
    }
    void loadTrace(selectedTraceId);
  }, [selectedTraceId, loadTrace]);

  const filteredTraces = useMemo(() => {
    if (tracesState.status !== "ready") return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return tracesState.data;
    return tracesState.data.filter(
      (trace) =>
        trace.rootTraceName.toLowerCase().includes(needle) ||
        trace.rootServiceName.toLowerCase().includes(needle) ||
        trace.traceId.toLowerCase().includes(needle),
    );
  }, [filter, tracesState]);

  const spanTree = useMemo(() => {
    if (traceState.status !== "ready") return [] as SpanNode[];
    return buildSpanTree(traceState.data.spans);
  }, [traceState]);

  const flatSpans = useMemo(() => flattenSpanTree(spanTree, expanded), [spanTree, expanded]);
  const totalDurationMs = useMemo(() => {
    if (traceState.status !== "ready") return 0;
    const spans = traceState.data.spans;
    if (spans.length === 0) return 0;
    let min = BigInt(spans[0]!.startTimeUnixNano);
    let max = BigInt(spans[0]!.endTimeUnixNano);
    for (const span of spans) {
      const start = BigInt(span.startTimeUnixNano);
      const end = BigInt(span.endTimeUnixNano);
      if (start < min) min = start;
      if (end > max) max = end;
    }
    return Number((max - min) / 1_000_000n);
  }, [traceState]);

  const toggleExpanded = useCallback((spanId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(spanId)) next.delete(spanId);
      else next.add(spanId);
      return next;
    });
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Traces</h1>
        <p className="text-sm text-muted-foreground">
          Traces exported from the API server via OpenTelemetry. LLM spans are highlighted with their prompt and response payloads.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
        <section className="flex min-h-0 flex-col gap-3 rounded-xl border bg-card p-4">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter by span name, service, or id"
                className="pl-7"
              />
            </div>
            <Button type="button" variant="outline" size="icon" onClick={() => void loadTraces()} title="Refresh">
              <RefreshCw className="size-4" />
            </Button>
          </div>

          {tracesState.status === "loading" ? (
            <p className="text-sm text-muted-foreground">Loading traces…</p>
          ) : tracesState.status === "error" ? (
            <p className="text-sm text-destructive">{tracesState.message}</p>
          ) : filteredTraces.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              No traces yet. Send a task to an agent and refresh — the server exports to the OTEL collector at <code>localhost:4318</code>.
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5 overflow-y-auto pr-1">
              {filteredTraces.map((trace) => {
                const isActive = trace.traceId === selectedTraceId;
                return (
                  <li key={trace.traceId}>
                    <button
                      type="button"
                      onClick={() => setSelectedTraceId(trace.traceId)}
                      className={cn(
                        "flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors",
                        isActive ? "border-primary bg-primary/5" : "hover:bg-muted/50",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{trace.rootTraceName}</span>
                        <Badge variant="outline" className="shrink-0 tabular-nums">{formatDuration(trace.durationMs)}</Badge>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span className="truncate">{trace.rootServiceName}</span>
                        <span>{formatRelative(trace.startTimeUnixNano)}</span>
                      </div>
                      <code className="truncate font-mono text-[10px] text-muted-foreground">{trace.traceId}</code>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="flex min-h-0 flex-col gap-3 rounded-xl border bg-card p-4">
          {traceState.status === "idle" ? (
            <div className="text-sm text-muted-foreground">Select a trace to inspect its spans.</div>
          ) : traceState.status === "loading" ? (
            <div className="text-sm text-muted-foreground">Loading trace…</div>
          ) : traceState.status === "error" ? (
            <div className="text-sm text-destructive">{traceState.message}</div>
          ) : (
            <TraceDetail
              detail={traceState.data}
              totalDurationMs={totalDurationMs}
              flatSpans={flatSpans}
              expanded={expanded}
              onToggle={toggleExpanded}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function TraceDetail({
  detail,
  totalDurationMs,
  flatSpans,
  expanded,
  onToggle,
}: {
  detail: TraceDetailResponse;
  totalDurationMs: number;
  flatSpans: ReadonlyArray<SpanNode>;
  expanded: ReadonlySet<string>;
  onToggle: (spanId: string) => void;
}) {
  const startNs = useMemo(() => {
    if (detail.spans.length === 0) return 0n;
    return detail.spans.reduce(
      (min, span) => (BigInt(span.startTimeUnixNano) < min ? BigInt(span.startTimeUnixNano) : min),
      BigInt(detail.spans[0]!.startTimeUnixNano),
    );
  }, [detail.spans]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <div className="font-mono text-xs text-muted-foreground">{detail.traceId}</div>
        <div className="text-sm text-muted-foreground">
          {detail.spans.length} spans · {formatDuration(totalDurationMs)}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        {flatSpans.map((span) => (
          <SpanRow
            key={span.spanId}
            span={span}
            startNs={startNs}
            totalDurationMs={totalDurationMs}
            expanded={expanded.has(span.spanId)}
            onToggle={onToggle}
          />
        ))}
      </div>
    </div>
  );
}

function SpanRow({
  span,
  startNs,
  totalDurationMs,
  expanded,
  onToggle,
}: {
  span: SpanNode;
  startNs: bigint;
  totalDurationMs: number;
  expanded: boolean;
  onToggle: (spanId: string) => void;
}) {
  const durationMs = spanDurationMs(span);
  const offsetMs = Number((BigInt(span.startTimeUnixNano) - startNs) / 1_000_000n);
  const offsetPct = totalDurationMs > 0 ? Math.max(0, Math.min(100, (offsetMs / totalDurationMs) * 100)) : 0;
  const widthPct = totalDurationMs > 0 ? Math.max(0.5, Math.min(100 - offsetPct, (durationMs / totalDurationMs) * 100)) : 0;
  const isError = span.statusCode === 2;
  const isLlm = isLlmSpan(span);
  const hasChildren = span.children.length > 0;

  return (
    <div className="rounded-md border bg-background">
      <div className="flex items-center gap-2 px-3 py-2">
        <div style={{ paddingLeft: span.depth * 16 }} className="flex shrink-0 items-center gap-1">
          {hasChildren ? (
            <button
              type="button"
              onClick={() => onToggle(span.spanId)}
              className="flex size-4 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>
          ) : (
            <span className="size-4" />
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className={cn("truncate text-sm", isError && "text-destructive")}>{span.name}</span>
            {isLlm ? (
              <Badge variant="secondary" className="gap-1">
                <Sparkles className="size-3" />
                LLM
              </Badge>
            ) : null}
            {isError ? <Badge variant="destructive">error</Badge> : null}
            <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
              {formatDuration(durationMs)}
            </span>
          </div>

          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full", isError ? "bg-destructive" : isLlm ? "bg-violet-500" : "bg-primary")}
              style={{ marginLeft: `${offsetPct}%`, width: `${widthPct}%` }}
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>{span.serviceName}</span>
            {span.scopeName ? <span>{span.scopeName}</span> : null}
            <span>{formatTimestamp(span.startTimeUnixNano)}</span>
          </div>
        </div>
      </div>

      {expanded ? <SpanDetails span={span} isLlm={isLlm} /> : null}
    </div>
  );
}

function SpanDetails({ span, isLlm }: { span: SpanNode; isLlm: boolean }) {
  const llmAttrs = useMemo(() => {
    if (!isLlm) return [] as Array<[string, unknown]>;
    return LLM_ATTRIBUTE_KEYS.filter((key) => key in span.attributes).map(
      (key) => [key, span.attributes[key]] as [string, unknown],
    );
  }, [isLlm, span.attributes]);

  const otherAttrs = useMemo(() => {
    const llmKeys = new Set(LLM_ATTRIBUTE_KEYS);
    return Object.entries(span.attributes).filter(([key]) => !llmKeys.has(key));
  }, [span.attributes]);

  return (
    <div className="border-t bg-muted/30 px-3 py-3">
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
          {span.events.map((event, index) => (
            <div key={`${event.name}-${index}`} className="rounded-md border bg-background p-2 text-xs">
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

function AttributeBlock({ name, value, pretty = false }: { name: string; value: unknown; pretty?: boolean }) {
  const text = stringifyValue(value);
  const isMultiline = text.includes("\n") || text.length > 80;
  if (pretty || isMultiline) {
    return (
      <div className="rounded-md border bg-background p-2">
        <div className="font-mono text-[11px] text-muted-foreground">{name}</div>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">
          {text}
        </pre>
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
