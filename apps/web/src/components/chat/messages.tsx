import { CheckIcon, CopyIcon, TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Activity } from '@/components/chat/activity';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCopy } from '@/hooks/use-copy';
import type { AssistantMessage as AssistantMessageModel, UserMessage as UserMessageModel } from '@/lib/chat/model';
import { formatDateTime, formatShortTime } from '@/lib/format';
import { cn } from '@/lib/utils';

function ActionButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-muted-foreground/70 hover:text-foreground"
            aria-label={label}
            onClick={onClick}
          />
        }
        delay={300}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function CopyAction({ text }: { text: string }) {
  const [copied, copy] = useCopy(text);
  return (
    <ActionButton label={copied ? 'Copied' : 'Copy'} onClick={copy}>
      {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
    </ActionButton>
  );
}

function MessageTimestamp({ at }: { at: number }) {
  return (
    <Tooltip disableHoverablePopup>
      <TooltipTrigger render={<time className="px-1 text-xs text-muted-foreground tabular-nums" />} delay={300}>
        {formatShortTime(at)}
      </TooltipTrigger>
      <TooltipContent className="pointer-events-none">{formatDateTime(at)}</TooltipContent>
    </Tooltip>
  );
}

/** Hover-revealed message actions with keyboard and touch fallbacks. */
function Actions({ align, children }: { align: 'start' | 'end'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute top-full z-10 mt-1 flex items-center gap-0.5 opacity-0 transition-opacity [&>*]:pointer-events-auto group-focus-within/message:opacity-100 group-hover/message:opacity-100 [@media(hover:none)]:opacity-100',
        align === 'end' ? 'right-0 justify-end' : 'left-0 justify-start',
      )}
    >
      {children}
    </div>
  );
}

export function UserMessage({ message }: { message: UserMessageModel }) {
  return (
    <article className="group/message relative flex flex-col items-end" aria-label="Your message">
      <div
        className="max-w-[85%] rounded-[1.4rem] bg-muted/70 px-4 py-3 text-[15px] leading-6 whitespace-pre-wrap [overflow-wrap:anywhere] sm:max-w-[80%]"
        title={formatDateTime(message.createdAt)}
      >
        {message.text}
      </div>
      <Actions align="end">
        <MessageTimestamp at={message.createdAt} />
        <CopyAction text={message.text} />
      </Actions>
    </article>
  );
}

export function AssistantMessage({ message }: { message: AssistantMessageModel }) {
  const streaming = message.working && message.text.length > 0;
  const showActions = !message.working && message.text.length > 0;

  return (
    <article
      className="group/message relative flex min-w-0 flex-col"
      aria-label="Assistant message"
      aria-busy={message.working}
    >
      <Activity message={message} />
      {message.error !== undefined ? (
        <div className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-medium text-destructive">The agent run failed</p>
            <Markdown className="mt-1 text-xs text-foreground/80">{message.error}</Markdown>
          </div>
        </div>
      ) : message.text.length > 0 ? (
        <Markdown className="text-[15px] leading-7" isAnimating={streaming} mode={streaming ? 'streaming' : 'static'}>
          {message.text}
        </Markdown>
      ) : null}
      {showActions ? (
        <Actions align="start">
          <CopyAction text={message.text} />
          <MessageTimestamp at={message.finishedAt ?? message.startedAt} />
        </Actions>
      ) : null}
    </article>
  );
}
