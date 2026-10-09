import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type FeedbackMessage = { readonly kind: 'error' | 'success' | 'info'; readonly text: string };

export function StatusMessage({
  kind,
  children,
  className,
}: {
  kind: FeedbackMessage['kind'];
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border px-4 py-3 text-sm',
        kind === 'error'
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : kind === 'success'
            ? 'border-success/30 bg-success/10 text-success'
            : 'border-border bg-muted/50 text-foreground',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ErrorBanner({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <StatusMessage kind="error" className={className}>
      {children}
    </StatusMessage>
  );
}
