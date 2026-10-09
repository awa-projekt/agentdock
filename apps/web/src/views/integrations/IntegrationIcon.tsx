import { Plug } from 'lucide-react';
import { useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const hostPattern = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/i;

export const integrationHost = (integration: {
  readonly slug: string;
  readonly displayUrl?: string | undefined;
}): string | undefined => {
  if (integration.displayUrl !== undefined && URL.canParse(integration.displayUrl)) {
    return new URL(integration.displayUrl).hostname;
  }
  const slugHost = integration.slug.replaceAll('_', '.');
  return hostPattern.test(slugHost) ? slugHost : undefined;
};

export function IntegrationIcon({
  host,
  src,
  size = 20,
  className,
}: {
  readonly host?: string | undefined;
  readonly src?: string | undefined;
  readonly size?: number;
  readonly className?: string;
}) {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const iconUrl = src ?? (host === undefined ? undefined : `https://integrations.sh/logo/${host}?sz=128`);

  return (
    <div
      aria-hidden="true"
      className={cn('relative inline-flex shrink-0 rounded-sm', className)}
      style={{ width: size, height: size }}
    >
      {iconUrl === undefined || failedUrl === iconUrl ? (
        <Plug className="size-full text-muted-foreground" />
      ) : (
        <>
          {loadedUrl !== iconUrl ? <Skeleton className="absolute inset-0 rounded-sm" /> : null}
          <img
            key={iconUrl}
            src={iconUrl}
            alt=""
            aria-hidden="true"
            width={size}
            height={size}
            loading="lazy"
            decoding="async"
            onLoad={() => setLoadedUrl(iconUrl)}
            onError={() => setFailedUrl(iconUrl)}
            className={cn('size-full rounded-sm object-contain', loadedUrl !== iconUrl && 'opacity-0')}
          />
        </>
      )}
    </div>
  );
}
