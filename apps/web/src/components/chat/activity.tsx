import { LayersIcon, MessageCircleQuestionIcon, OctagonXIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/chat/disclosure';
import { ActivityTimeline } from '@/components/chat/timeline/timeline';
import {
  activeSubagentChain,
  countSubagents,
  countTimelineSteps,
  describeTimelineItem,
  liveActivity,
  subagentDepth,
} from '@/lib/chat/events';
import { type AssistantMessage, humanizeTaskState, isErrorState } from '@/lib/chat/model';
import { type AgentIdentity, useAgentIdentity } from '@/lib/chat/use-agent-identity';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';

const pluralize = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

type Identify = (item: Extract<AssistantMessage['timeline'][number], { kind: 'subagent' }>) => AgentIdentity;

/** "Researcher › Summarizer · Calling search" while delegations are in flight. */
const liveHeadline = (message: AssistantMessage, identify: Identify): string => {
  const { chain, current } = activeSubagentChain(message.timeline);
  if (chain.length === 0) {
    const last = message.timeline.at(-1);
    return last ? describeTimelineItem(last) : humanizeTaskState(message.state) || 'Working';
  }
  const path = chain.map((item) => identify(item).name).join(' › ');
  const step = current ? describeTimelineItem(current) : 'Thinking';
  return `${path} · ${step}`;
};

const summaryParts = (message: AssistantMessage): ReadonlyArray<string> => {
  const steps = countTimelineSteps(message.timeline);
  const subagents = countSubagents(message.timeline);
  const depth = subagentDepth(message.timeline);
  return [
    ...(steps > 0 ? [pluralize(steps, 'step')] : []),
    ...(subagents > 0 ? [pluralize(subagents, 'subagent')] : []),
    ...(depth > 1 ? [`${depth} levels deep`] : []),
  ];
};

const headline = (message: AssistantMessage, identify: Identify): string => {
  const steps = countTimelineSteps(message.timeline);
  if (message.working) {
    switch (liveActivity(message.timeline, message.text)) {
      case 'thinking':
        return message.state === 'submitted' ? 'Starting' : 'Thinking';
      case 'writing':
        return 'Writing';
      default:
        return liveHeadline(message, identify);
    }
  }
  if (message.state === 'input-required') return 'Waiting for your input';
  if (message.state === 'canceled') return steps > 0 ? `Stopped after ${pluralize(steps, 'step')}` : 'Stopped';
  if (isErrorState(message.state)) return steps > 0 ? `Failed after ${pluralize(steps, 'step')}` : 'Failed';
  const elapsed = message.finishedAt === undefined ? undefined : message.finishedAt - message.startedAt;
  const duration = elapsed !== undefined && elapsed >= 1000 ? `Worked for ${formatDuration(elapsed)}` : 'Worked';
  return [duration, ...summaryParts(message)].join(' · ');
};

/**
 * One collapsible per assistant turn showing what the agent did: live status
 * while it runs, a one-line summary afterwards, and the step trail inside.
 */
export function Activity({ message }: { message: AssistantMessage }) {
  const identify = useAgentIdentity();
  const [open, setOpen] = useState(message.working);
  const [pinned, setPinned] = useState(false);

  // Follow the run automatically until the user takes over the toggle.
  useEffect(() => {
    if (!pinned) setOpen(message.working || message.state === 'input-required');
  }, [message.working, message.state, pinned]);

  if (message.timeline.length === 0 && !message.working) return null;

  const failed = isErrorState(message.state);
  const live = message.working ? liveActivity(message.timeline, message.text) : undefined;
  // The header keeps the stack icon throughout; the brain belongs to the thinking steps inside.
  const icon =
    live !== undefined ? (
      <LayersIcon className="size-3.5 animate-pulse" aria-hidden="true" />
    ) : message.state === 'input-required' ? (
      <MessageCircleQuestionIcon className="size-3.5 text-warning" aria-hidden="true" />
    ) : message.state === 'canceled' ? (
      <OctagonXIcon className="size-3.5" aria-hidden="true" />
    ) : failed ? (
      <TriangleAlertIcon className="size-3.5 text-destructive" aria-hidden="true" />
    ) : null;

  return (
    <Disclosure
      open={open}
      onOpenChange={(next) => {
        setPinned(true);
        setOpen(next);
      }}
      className="mb-4 border-b border-border/60 pb-3"
    >
      <DisclosureTrigger chevron="right" className="w-auto gap-1.5 py-0.5 text-[13px] [&>svg:last-child]:ml-0">
        {icon ? <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span> : null}
        <span className={cn('truncate', message.working && 'text-shimmer')}>{headline(message, identify)}</span>
      </DisclosureTrigger>
      <DisclosureContent>
        <ActivityTimeline
          items={message.timeline}
          startAt={message.startedAt}
          working={message.working}
          thinking={live === 'thinking'}
          className="mt-2 pl-0.5"
        />
      </DisclosureContent>
    </Disclosure>
  );
}
