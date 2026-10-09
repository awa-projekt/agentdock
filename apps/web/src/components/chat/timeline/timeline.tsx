import { isJsonObject, type JsonObject, jsonProperty, jsonString } from 'agentdock-sdk/schemas';
import {
  BrainIcon,
  CheckIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  MessageCircleQuestionIcon,
  MessageSquareTextIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/chat/disclosure';
import { ToolCallCard, ToolResultCard } from '@/components/chat/timeline/tool-cards';
import { Markdown, MarkdownPreview } from '@/components/markdown';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { countTimelineSteps, isSubagentSettled, liveActivity } from '@/lib/chat/events';
import { isErrorState, type TimelineItem } from '@/lib/chat/model';
import { useAgentIdentity } from '@/lib/chat/use-agent-identity';
import { useChat } from '@/lib/chat/use-chat';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Time since the previous step; that gap is where the model was thinking. */
function Elapsed({ millis }: { millis: number }) {
  if (millis < 500) return null;
  return (
    <span
      className="absolute top-0.5 right-0 font-mono text-[10px] text-muted-foreground tabular-nums"
      title="Time since the previous step"
    >
      +{formatDuration(millis)}
    </span>
  );
}

function Step({
  icon,
  tone = 'default',
  elapsed,
  children,
}: {
  icon: ReactNode;
  tone?: 'default' | 'error';
  elapsed: number;
  children: ReactNode;
}) {
  return (
    <li className="relative flex min-w-0 gap-3">
      <span
        className={cn(
          'relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border bg-background',
          tone === 'error' ? 'border-destructive/40 text-destructive' : 'border-border text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <div className={cn('relative min-w-0 flex-1 pb-3', elapsed >= 500 && 'pr-14')}>
        <Elapsed millis={elapsed} />
        {children}
      </div>
    </li>
  );
}

/** Placeholder step while the model reasons and nothing has streamed yet; replaced by real steps as they arrive. */
function ThinkingStep() {
  return (
    <li className="relative flex min-w-0 gap-3" aria-live="polite">
      <span className="relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
        <BrainIcon className="size-3 animate-pulse" aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-2 pt-0.5 text-xs">
        <span className="text-shimmer">Thinking</span>
        <span className="flex items-center gap-0.5" aria-hidden="true">
          <span className="size-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
          <span className="size-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
          <span className="size-1 animate-bounce rounded-full bg-muted-foreground" />
        </span>
      </div>
    </li>
  );
}

function TextStep({ item, elapsed }: { item: Extract<TimelineItem, { kind: 'text' }>; elapsed: number }) {
  return (
    <Step icon={<MessageSquareTextIcon className="size-3" aria-hidden="true" />} elapsed={elapsed}>
      <Markdown className="text-xs text-foreground/90">{item.text}</Markdown>
    </Step>
  );
}

/** First line of a thought with markdown emphasis stripped, for the collapsed header. */
const reasoningPreview = (text: string): string =>
  (text.split('\n').find((line) => line.trim().length > 0) ?? '').replace(/[*_`#]+/g, '').trim();

function ReasoningStep({ item, elapsed }: { item: Extract<TimelineItem, { kind: 'reasoning' }>; elapsed: number }) {
  return (
    <Step icon={<BrainIcon className="size-3" aria-hidden="true" />} elapsed={elapsed}>
      <Disclosure defaultOpen={false}>
        <DisclosureTrigger>
          <span className="font-medium text-foreground">Thought</span>
          <span className="truncate">{reasoningPreview(item.text)}</span>
        </DisclosureTrigger>
        <DisclosureContent>
          <Markdown className="mt-1.5 text-xs text-muted-foreground">{item.text}</Markdown>
        </DisclosureContent>
      </Disclosure>
    </Step>
  );
}

/** A clamped markdown block that expands on click, for the prompt and answer of a delegation. */
function ClampedText({ label, text, className }: { label: string; text: string; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={cn('rounded-md px-2 py-1.5', className)}>
      <div className="mb-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      {expanded ? (
        <>
          <Markdown className="text-xs text-foreground/90">{text}</Markdown>
          <button
            type="button"
            className="mt-1 cursor-pointer text-[10px] text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded(false)}
          >
            Show less
          </button>
        </>
      ) : (
        <button type="button" className="block w-full cursor-pointer text-left" onClick={() => setExpanded(true)}>
          <MarkdownPreview lines={3} className="text-xs text-foreground/90">
            {text}
          </MarkdownPreview>
        </button>
      )}
    </div>
  );
}

function SubagentStep({
  item,
  depth,
  elapsed,
}: {
  item: Extract<TimelineItem, { kind: 'subagent' }>;
  depth: number;
  elapsed: number;
}) {
  const identify = useAgentIdentity();
  const { name, color } = identify(item);
  const settled = isSubagentSettled(item);
  const failed = item.error !== undefined || isErrorState(item.state);
  const level = depth + 1;

  return (
    <Step
      elapsed={elapsed}
      tone={failed ? 'error' : 'default'}
      icon={
        !settled ? (
          <Spinner className="size-2.5 border-[1.5px]" />
        ) : (
          <GitBranchIcon className="size-3" aria-hidden="true" />
        )
      }
    >
      <Disclosure
        defaultOpen={depth === 0 || !settled}
        className={cn(
          'rounded-lg border border-l-2 px-2.5 py-2',
          failed ? 'border-destructive/30 bg-destructive/5' : 'border-border/70 bg-muted/20',
        )}
        style={color === undefined ? undefined : { borderLeftColor: color }}
      >
        <DisclosureTrigger>
          <span
            className="size-2 shrink-0 rounded-full bg-muted-foreground/60"
            style={color === undefined ? undefined : { backgroundColor: color }}
            aria-hidden="true"
          />
          <span className="truncate font-medium text-foreground">{name}</span>
          <span
            className="shrink-0 rounded-sm bg-background/80 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide"
            title={`Delegation level ${level}`}
          >
            L{level}
          </span>
          <span
            className={cn(
              'shrink-0 rounded-full px-1.5 py-px font-mono text-[10px] uppercase',
              failed ? 'bg-destructive/10 text-destructive' : settled ? 'bg-muted' : 'bg-primary/10 text-primary',
            )}
          >
            {item.state}
          </span>
          {item.items.length > 0 ? (
            <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
              {countTimelineSteps(item.items)} steps
            </span>
          ) : null}
        </DisclosureTrigger>
        <DisclosureContent>
          <div className="mt-2 grid gap-2">
            {item.prompt ? <ClampedText label="Task" text={item.prompt} className="bg-background/70" /> : null}
            {item.items.length > 0 || !settled ? (
              <ActivityTimeline
                items={item.items}
                startAt={item.at}
                depth={level}
                working={!settled}
                thinking={!settled && liveActivity(item.items, '') === 'thinking'}
                className="pl-0.5"
              />
            ) : null}
            {item.error ? (
              <p className="whitespace-pre-wrap rounded-md bg-destructive/10 p-2 text-[11px] text-destructive">
                {item.error}
              </p>
            ) : item.text && settled ? (
              <ClampedText label="Answer" text={item.text} className="bg-success/5" />
            ) : null}
          </div>
        </DisclosureContent>
      </Disclosure>
    </Step>
  );
}

function InputRequiredStep({ request, elapsed }: { request: JsonObject; elapsed: number }) {
  const { send, isStreaming } = useChat();
  const [content, setContent] = useState<Readonly<Record<string, string>>>({});
  const properties = jsonProperty(request.requestedSchema, 'properties');
  const fields = isJsonObject(properties) ? Object.entries(properties) : [];
  const message = jsonString(request, 'message') ?? 'The agent needs your input to continue.';
  const url = jsonString(request, 'url');

  const respond = (action: 'accept' | 'decline' | 'cancel') => {
    send(JSON.stringify(action === 'accept' ? { action, content } : { action }));
  };

  return (
    <Step icon={<MessageCircleQuestionIcon className="size-3" aria-hidden="true" />} elapsed={elapsed}>
      <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs">
        <p className="font-medium text-foreground">Input required</p>
        <p className="mt-1 text-muted-foreground">{message}</p>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-2')}
          >
            Open authorization page <ExternalLinkIcon />
          </a>
        ) : null}
        {fields.map(([name, definition]) => {
          const inputId = `input-required-${name}`;
          return (
            <label key={name} htmlFor={inputId} className="mt-2 block space-y-1">
              <span className="font-medium text-foreground">{jsonString(definition, 'title') ?? name}</span>
              <Input
                id={inputId}
                className="h-8 text-xs"
                value={content[name] ?? ''}
                placeholder={jsonString(definition, 'description')}
                disabled={isStreaming}
                onChange={(event) => setContent((current) => ({ ...current, [name]: event.target.value }))}
              />
            </label>
          );
        })}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" disabled={isStreaming} onClick={() => respond('accept')}>
            {fields.length > 0 ? 'Submit' : 'Approve'}
          </Button>
          <Button size="sm" variant="outline" disabled={isStreaming} onClick={() => respond('decline')}>
            Decline
          </Button>
          <Button size="sm" variant="ghost" disabled={isStreaming} onClick={() => respond('cancel')}>
            Cancel
          </Button>
        </div>
      </div>
    </Step>
  );
}

function TimelineStep({
  item,
  depth,
  isLast,
  working,
  elapsed,
}: {
  item: TimelineItem;
  depth: number;
  isLast: boolean;
  working: boolean;
  elapsed: number;
}) {
  const expanded = depth === 0;
  switch (item.kind) {
    case 'text':
      return <TextStep item={item} elapsed={elapsed} />;
    case 'reasoning':
      return <ReasoningStep item={item} elapsed={elapsed} />;
    case 'tool-call':
      return (
        <Step
          elapsed={elapsed}
          icon={
            isLast && working ? (
              <Spinner className="size-2.5 border-[1.5px]" />
            ) : (
              <WrenchIcon className="size-3" aria-hidden="true" />
            )
          }
        >
          <ToolCallCard toolName={item.toolName} input={item.input} defaultOpen={expanded} />
        </Step>
      );
    case 'tool-result':
      return (
        <Step
          elapsed={elapsed}
          tone={item.error ? 'error' : 'default'}
          icon={
            item.error ? (
              <TriangleAlertIcon className="size-3" aria-hidden="true" />
            ) : (
              <CheckIcon className="size-3" aria-hidden="true" />
            )
          }
        >
          <ToolResultCard toolName={item.toolName} output={item.output} error={item.error} defaultOpen={expanded} />
        </Step>
      );
    case 'subagent':
      return <SubagentStep item={item} depth={depth} elapsed={elapsed} />;
    case 'input-required':
      return <InputRequiredStep request={item.request} elapsed={elapsed} />;
  }
}

/** The ordered steps of one assistant turn (or of a nested subagent run). */
export function ActivityTimeline({
  items,
  startAt,
  depth = 0,
  working = false,
  thinking = false,
  className,
}: {
  items: ReadonlyArray<TimelineItem>;
  /** When the run (or nested subagent run) began; the first step's gap is measured from here. */
  startAt: number;
  /** 0 for the top-level agent, 1 for its subagents, and so on. Deeper trails start collapsed. */
  depth?: number;
  working?: boolean;
  /** Append a live "Thinking" step while the model reasons without emitting anything. */
  thinking?: boolean;
  className?: string;
}) {
  return (
    <ol className={cn('relative min-w-0 [&>li:last-child>div]:pb-0', className)}>
      <span className="absolute top-2 bottom-2 left-2.5 w-px bg-border" aria-hidden="true" />
      {items.map((item, index) => (
        <TimelineStep
          key={item.id}
          item={item}
          depth={depth}
          isLast={index === items.length - 1}
          working={working}
          elapsed={Math.max(0, item.at - (index === 0 ? startAt : (items[index - 1]?.at ?? startAt)))}
        />
      ))}
      {thinking ? <ThinkingStep /> : null}
    </ol>
  );
}
