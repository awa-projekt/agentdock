import { ArrowDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function ScrollToBottomButton() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  return (
    <Button
      type="button"
      variant="outline"
      aria-label="Scroll to bottom"
      aria-hidden={isAtBottom}
      tabIndex={isAtBottom ? -1 : 0}
      onClick={() => void scrollToBottom()}
      className={cn(
        'absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-background/95 px-3 shadow-md backdrop-blur-sm transition-all',
        isAtBottom ? 'pointer-events-none translate-y-2 opacity-0' : 'opacity-100',
      )}
    >
      <ArrowDownIcon className="size-3.5" />
      Scroll to end
    </Button>
  );
}

/**
 * The single scroll container of a chat. Follows new content while the reader
 * is at the bottom, releases when they scroll up, and offers a way back down.
 */
export function Transcript({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <StickToBottom
      role="log"
      aria-live="polite"
      initial="instant"
      resize="smooth"
      className={cn('relative min-h-0 flex-1', className)}
    >
      <StickToBottom.Content
        scrollClassName="[scrollbar-gutter:stable] overscroll-contain"
        className="mx-auto flex w-full max-w-4xl flex-col gap-9 px-4 pt-6 pb-8 sm:px-6"
      >
        {children}
      </StickToBottom.Content>
      <ScrollToBottomButton />
    </StickToBottom>
  );
}
