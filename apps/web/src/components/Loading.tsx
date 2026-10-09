import type { ReactNode } from 'react';
import { MasterDetail } from '@/components/MasterDetail';
import { Skeleton } from '@/components/ui/skeleton';

const rows = ['first', 'second', 'third'];

function LoadingRegion({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="status" aria-label="Loading content" className={className}>
      {children}
    </div>
  );
}

export function ListSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <LoadingRegion className="space-y-3">
      {rows.map((row) => (
        <div
          key={row}
          className={compact ? 'space-y-2 rounded-lg border p-3' : 'space-y-3 rounded-xl border bg-card p-4'}
        >
          <div className="flex items-center gap-3">
            <Skeleton className={compact ? 'size-5 shrink-0' : 'size-8 shrink-0'} />
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="ml-auto h-6 w-16" />
          </div>
          <Skeleton className="h-3 w-4/5" />
          {!compact ? <Skeleton className="h-3 w-3/5" /> : null}
        </div>
      ))}
    </LoadingRegion>
  );
}

export function DetailSkeleton() {
  return (
    <LoadingRegion className="space-y-6">
      <div className="flex items-center gap-3">
        <Skeleton className="size-11 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      </div>
      <Skeleton className="h-4 w-4/5" />
      <div className="grid gap-4 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row} className="space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ))}
      </div>
      <Skeleton className="h-32 w-full" />
    </LoadingRegion>
  );
}

export function SplitSkeleton({ masterWidth = '360px' }: { masterWidth?: string }) {
  return <MasterDetail masterWidth={masterWidth} master={<ListSkeleton compact />} detail={<DetailSkeleton />} />;
}

export function ChatSkeleton() {
  return (
    <LoadingRegion className="flex h-full min-h-0 flex-col gap-4">
      <Skeleton className="h-8 w-full shrink-0 sm:w-64" />
      <div className="flex min-h-0 flex-1 flex-col rounded-xl border bg-card">
        <div className="flex h-14 shrink-0 items-center gap-3 border-b px-3">
          <Skeleton className="size-4" />
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="min-h-0 flex-1" />
        <div className="p-3">
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      </div>
    </LoadingRegion>
  );
}

export function GraphSkeleton() {
  return (
    <LoadingRegion className="flex min-h-48 flex-1 rounded-xl border bg-card p-6">
      <Skeleton className="h-24 w-48 rounded-xl" />
    </LoadingRegion>
  );
}

export function ScreenSkeleton({
  layout = 'list',
  masterWidth,
}: {
  layout?: 'list' | 'split' | 'chat' | 'graph' | 'integration' | 'workflow-registry' | 'workflow-runs';
  masterWidth?: string;
}) {
  if (layout === 'chat') return <ChatSkeleton />;
  if (layout === 'workflow-registry' || layout === 'workflow-runs') {
    return (
      <div className="flex h-full min-h-0 flex-col gap-4">
        <Skeleton className="h-8 w-40 shrink-0" />
        {layout === 'workflow-registry' ? <ListSkeleton /> : <GraphSkeleton />}
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col gap-6">
      <LoadingRegion className="shrink-0 space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-5 w-3/4" />
      </LoadingRegion>
      {layout === 'integration' ? (
        <MasterDetail
          detailWidth="360px"
          className="lg:items-start"
          master={<ListSkeleton />}
          detail={<DetailSkeleton />}
        />
      ) : layout === 'split' ? (
        <SplitSkeleton masterWidth={masterWidth} />
      ) : layout === 'graph' ? (
        <GraphSkeleton />
      ) : (
        <ListSkeleton />
      )}
    </div>
  );
}
