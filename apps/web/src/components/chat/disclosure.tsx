import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

/** A labelled collapsible block for secondary detail (activity trails, tool payloads, run timelines). */
export function Disclosure({ className, ...props }: ComponentProps<typeof Collapsible>) {
  return <Collapsible className={cn('group/disclosure min-w-0', className)} {...props} />;
}

export function DisclosureTrigger({
  className,
  children,
  chevron = 'down',
  ...props
}: Omit<ComponentProps<typeof CollapsibleTrigger>, 'children'> & {
  readonly children: ReactNode;
  readonly chevron?: 'down' | 'right';
}) {
  const ChevronIcon = chevron === 'right' ? ChevronRightIcon : ChevronDownIcon;

  return (
    <CollapsibleTrigger
      className={cn(
        'flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md text-left text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronIcon
        className={cn(
          'ml-auto size-3.5 shrink-0 transition-transform',
          chevron === 'right'
            ? 'group-data-[panel-open]/disclosure:rotate-90'
            : 'group-data-[panel-open]/disclosure:rotate-180',
        )}
        aria-hidden="true"
      />
    </CollapsibleTrigger>
  );
}

export function DisclosureContent({ className, children, ...props }: ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      className={cn(
        'h-(--collapsible-panel-height) min-w-0 overflow-hidden transition-[height,opacity] duration-200 ease-out data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0',
        className,
      )}
      {...props}
    >
      {children}
    </CollapsibleContent>
  );
}
