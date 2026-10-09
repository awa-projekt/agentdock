import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn('max-w-full rounded bg-muted motion-safe:animate-pulse', className)}
      {...props}
    />
  );
}
