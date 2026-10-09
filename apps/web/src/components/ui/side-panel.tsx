import * as Predicate from 'effect/Predicate';
import { PanelLeft, PanelLeftClose, PanelRight, PanelRightClose } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * A collapsible panel that floats over a full-height view. When collapsed it
 * shrinks to a single toggle button pinned to its edge so the canvas keeps the
 * maximum amount of room.
 */
export function SidePanel({
  side,
  title,
  actions,
  collapsed,
  onCollapsedChange,
  widthClassName = 'w-80',
  children,
}: {
  side: 'left' | 'right';
  title: ReactNode;
  actions?: ReactNode;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  widthClassName?: string;
  children: ReactNode;
}) {
  const OpenIcon = side === 'left' ? PanelLeft : PanelRight;
  const CloseIcon = side === 'left' ? PanelLeftClose : PanelRightClose;
  const label = Predicate.isString(title) ? title : 'panel';

  if (collapsed) {
    return (
      <Button
        variant="outline"
        size="icon-sm"
        onClick={() => onCollapsedChange(false)}
        title={`Show ${label}`}
        aria-label={`Show ${label}`}
        className={cn('absolute top-3 z-20 shadow-md', side === 'left' ? 'left-3' : 'right-3')}
      >
        <OpenIcon className="size-4" />
      </Button>
    );
  }

  return (
    <div
      className={cn(
        'absolute bottom-3 top-3 z-20 flex flex-col overflow-hidden rounded-xl border border-border bg-card/95 shadow-xl backdrop-blur-sm',
        widthClassName,
        side === 'left' ? 'left-3' : 'right-3',
      )}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="mr-auto truncate text-sm font-semibold">{title}</h2>
        {actions}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onCollapsedChange(true)}
          title={`Collapse ${label}`}
          aria-label={`Collapse ${label}`}
        >
          <CloseIcon className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </div>
  );
}
