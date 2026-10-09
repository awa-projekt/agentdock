import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utils';

export function MasterDetail({
  master,
  detail,
  masterWidth = '360px',
  detailWidth,
  detailSide = 'right',
  className,
}: {
  master: ReactNode;
  detail: ReactNode;
  masterWidth?: string;
  detailWidth?: string;
  detailSide?: 'left' | 'right';
  className?: string;
}) {
  const style: CSSProperties & { '--master-width': string; '--detail-width': string } = {
    '--master-width': masterWidth,
    '--detail-width': detailWidth ?? masterWidth,
  };
  const masterSection = (
    <section className="@container flex flex-col gap-3 rounded-xl border bg-card p-4 lg:min-h-0 lg:overflow-y-auto">
      {master}
    </section>
  );
  const detailSection = (
    <section className="@container flex flex-col gap-3 rounded-xl border bg-card p-4 lg:min-h-0 lg:overflow-y-auto">
      {detail}
    </section>
  );

  return (
    <div
      style={style}
      className={cn(
        'grid min-h-0 flex-1 content-start gap-4 overflow-y-auto pr-1 lg:content-stretch lg:pr-0 lg:grid-rows-[minmax(0,1fr)] lg:overflow-visible',
        detailWidth
          ? detailSide === 'right'
            ? 'lg:grid-cols-[1fr_minmax(0,var(--detail-width))]'
            : 'lg:grid-cols-[minmax(0,var(--detail-width))_1fr]'
          : detailSide === 'right'
            ? 'lg:grid-cols-[minmax(0,var(--master-width))_1fr]'
            : 'lg:grid-cols-[1fr_minmax(0,var(--master-width))]',
        className,
      )}
    >
      {detailSide === 'right' ? (
        <>
          {masterSection}
          {detailSection}
        </>
      ) : (
        <>
          {detailSection}
          {masterSection}
        </>
      )}
    </div>
  );
}
