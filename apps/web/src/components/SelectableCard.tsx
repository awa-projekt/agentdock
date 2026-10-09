import type { MouseEventHandler, ReactNode } from 'react';

import { cn } from '@/lib/utils';

export function SelectableCard({
  active = false,
  className,
  children,
  onClick,
}: {
  active?: boolean;
  className?: string;
  children: ReactNode;
  onClick: MouseEventHandler<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      className={cn(
        'w-full rounded-lg border p-3 text-left transition-colors',
        active ? 'border-primary bg-primary/5' : 'border-border bg-background hover:bg-muted/50',
        className,
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
