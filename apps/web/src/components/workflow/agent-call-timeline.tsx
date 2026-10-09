import {
  BotIcon,
  BrainIcon,
  CpuIcon,
  GitBranchIcon,
  MessageSquareIcon,
  RadioIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from 'lucide-react';

import { JsonCode } from '@/components/chat/code-view';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/chat/disclosure';
import { Markdown, MarkdownPreview } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { type A2ATimelineItem, buildStepActivityModel, type StepActivityEvent } from '@/lib/workflow-a2a-events';

function AgentText({ text, compact, lines }: { text: string; compact: boolean; lines: number }) {
  return (
    <div className="rounded-md bg-background/70 p-2 text-xs text-foreground">
      {compact ? <MarkdownPreview lines={lines}>{text}</MarkdownPreview> : <Markdown>{text}</Markdown>}
    </div>
  );
}

function AgentCallProgressItem({ item, compact }: { item: A2ATimelineItem; compact: boolean }) {
  const time = formatTime(item.timestamp);

  if (item.kind === 'sent') {
    return (
      <div className="space-y-1 text-xs">
        <div className="flex items-center justify-between gap-2 text-muted-foreground">
          <span className="font-medium text-foreground">Sent task</span>
          <span className="shrink-0 font-mono text-[10px]">{time}</span>
        </div>
        {item.message ? <AgentText text={item.message} compact={compact} lines={4} /> : null}
      </div>
    );
  }

  if (item.kind === 'message') {
    return item.text ? (
      <div className="space-y-1 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <MessageSquareIcon className="size-3.5" aria-hidden="true" />
          <span>Message</span>
          <span className="ml-auto shrink-0 font-mono text-[10px]">{time}</span>
        </div>
        <AgentText text={item.text} compact={compact} lines={6} />
      </div>
    ) : null;
  }

  if (item.kind === 'model-call') {
    const tokens =
      item.inputTokens === undefined && item.outputTokens === undefined
        ? 'usage not reported'
        : `${item.inputTokens ?? 0} in · ${item.outputTokens ?? 0} out`;
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <CpuIcon className="size-3.5" aria-hidden="true" />
        <span>Model call</span>
        <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[10px]">
          {item.model}
        </Badge>
        <span className="font-mono text-[10px]">{item.caller}</span>
        <span className="font-mono text-[10px]">{tokens}</span>
        {item.toolCalls > 0 ? (
          <span className="font-mono text-[10px]">
            {item.toolCalls} tool call{item.toolCalls === 1 ? '' : 's'}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 font-mono text-[10px]">{time}</span>
      </div>
    );
  }

  if (item.kind === 'subagent') {
    return (
      <div className="space-y-1 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <BotIcon className="size-3.5" aria-hidden="true" />
          <span>Subagent</span>
          <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[10px]">
            {item.agent}
          </Badge>
          <Badge variant="outline" className="h-5 px-1.5 font-mono text-[10px]">
            {item.state}
          </Badge>
          {item.toolCalls > 0 ? (
            <span className="font-mono text-[10px]">
              {item.toolCalls} tool call{item.toolCalls === 1 ? '' : 's'}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 font-mono text-[10px]">{time}</span>
        </div>
        {item.text ? <AgentText text={item.text} compact={compact} lines={4} /> : null}
      </div>
    );
  }

  const detail = item.kind === 'status' || item.kind === 'tool' ? item.detail : undefined;

  if (detail?.kind === 'reasoning') {
    return (
      <div className="space-y-1 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <BrainIcon className="size-3.5" aria-hidden="true" />
          <span>Reasoning</span>
          <span className="ml-auto shrink-0 font-mono text-[10px]">{time}</span>
        </div>
        <AgentText text={detail.text} compact={compact} lines={4} />
      </div>
    );
  }

  if (detail?.kind === 'tool-call' || detail?.kind === 'tool-result') {
    const payload = detail.kind === 'tool-call' ? detail.input : detail.output;
    return (
      <div className="space-y-1 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <WrenchIcon className="size-3.5" aria-hidden="true" />
          <span>{detail.kind === 'tool-call' ? 'Tool call' : 'Tool result'}</span>
          <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[10px]">
            {detail.toolName}
          </Badge>
          <span className="ml-auto shrink-0 font-mono text-[10px]">{time}</span>
        </div>
        {payload !== undefined ? <JsonCode value={payload} className="max-h-32 overflow-auto" /> : null}
      </div>
    );
  }

  if (detail?.kind === 'tool-error') {
    return (
      <div className="space-y-1 text-xs">
        <div className="flex items-center gap-2 text-destructive">
          <TriangleAlertIcon className="size-3.5" aria-hidden="true" />
          <span className="font-medium">Tool error</span>
          <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[10px]">
            {detail.toolName}
          </Badge>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">{time}</span>
        </div>
        <p className="whitespace-pre-wrap rounded-md bg-destructive/10 p-2 text-foreground">{detail.error}</p>
      </div>
    );
  }

  return item.kind === 'status' ? (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <RadioIcon className="size-3.5" aria-hidden="true" />
      <span className="font-mono">{item.eventState}</span>
      <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[10px]">
        {item.taskState}
      </Badge>
      <span className="ml-auto shrink-0 font-mono text-[10px]">{time}</span>
    </div>
  ) : null;
}

export function AgentCallTimeline({
  events,
  title = 'Step activity',
  defaultOpen = false,
  compact = false,
  className,
}: {
  readonly events: ReadonlyArray<StepActivityEvent>;
  readonly title?: string;
  readonly defaultOpen?: boolean;
  readonly compact?: boolean;
  readonly className?: string;
}) {
  const model = buildStepActivityModel(events);
  const finalText = model.streamedText.trim();

  if (events.length === 0) {
    return null;
  }

  return (
    <Disclosure defaultOpen={defaultOpen} className={cn('min-w-0', className)}>
      <DisclosureTrigger>
        <GitBranchIcon className="size-4 shrink-0" aria-hidden="true" />
        <span className="shrink-0 font-medium text-foreground">{title}</span>
        {model.state ? (
          <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[10px] uppercase">
            {model.state}
          </Badge>
        ) : null}
        {model.agentId ? <span className="truncate font-mono text-[10px]">{model.agentId}</span> : null}
        <span className="ml-auto shrink-0 text-[10px]">
          {model.items.length} shown / {model.rawEventCount} raw
        </span>
      </DisclosureTrigger>
      <DisclosureContent>
        <div className={cn('mt-3 space-y-2 rounded-lg border border-border bg-muted/30 p-3', compact && 'mt-2 p-2')}>
          {model.items.length > 0 ? (
            <div className="space-y-2 border-l border-border pl-3">
              {model.items.map((item) => (
                <AgentCallProgressItem key={item.id} item={item} compact={compact} />
              ))}
            </div>
          ) : null}
          {finalText ? (
            <div className="text-foreground">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Streamed result
              </div>
              <AgentText text={finalText} compact={compact} lines={6} />
            </div>
          ) : null}
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}
