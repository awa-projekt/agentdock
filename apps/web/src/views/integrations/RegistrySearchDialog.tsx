import type {
  InstallableIntegrationRegistryKind,
  IntegrationRegistryMatch,
  IntegrationRegistrySurface,
  IntegrationView,
} from 'agentdock-sdk/schemas';
import { Download, ExternalLink, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ErrorBanner, type FeedbackMessage } from '@/components/StatusMessage';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toErrorMessage } from '@/lib/format';
import { useDiscoverIntegration, useIntegrationRegistry, useIntegrationRegistrySearch } from '@/lib/queries';
import { IntegrationIcon } from './IntegrationIcon';

type KindFilter = 'all' | InstallableIntegrationRegistryKind;

const kindLabel = (kind: IntegrationRegistrySurface['kind']): string => (kind === 'mcp' ? 'MCP' : 'OpenAPI');

const catalogCardClassName = 'flex min-h-40 min-w-0 flex-col gap-3 rounded-lg border border-border p-4';
const skeletonCards = Array.from({ length: 12 }, (_, index) => `catalog-skeleton-${index}`);

const SEARCH_DEBOUNCE_MS = 300;

const matchesNeedle = (result: IntegrationRegistryMatch, needle: string): boolean =>
  `${result.name} ${result.domain} ${result.description} ${result.kinds.join(' ')}`
    .toLocaleLowerCase()
    .includes(needle);

const narrowToKind = (
  results: ReadonlyArray<IntegrationRegistryMatch>,
  kind: KindFilter,
): ReadonlyArray<IntegrationRegistryMatch> =>
  kind === 'all'
    ? results
    : results.flatMap((result) => {
        const surfaces = result.surfaces.filter((surface) => surface.kind === kind);
        return surfaces.length === 0 ? [] : [{ ...result, surfaces }];
      });

export function RegistrySearchDialog({
  installedSlugs,
  report,
  onAdded,
}: {
  readonly installedSlugs: ReadonlySet<string>;
  readonly report: (message: FeedbackMessage) => void;
  readonly onAdded: (integration: IntegrationView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [installingUrl, setInstallingUrl] = useState<string | null>(null);
  const needle = query.trim().toLocaleLowerCase();
  const [searchTerm, setSearchTerm] = useState(needle);
  const registry = useIntegrationRegistry(open);
  const search = useIntegrationRegistrySearch(open ? searchTerm : '', kind === 'all' ? undefined : kind);
  const discover = useDiscoverIntegration();

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchTerm(needle), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [needle]);

  const install = (surface: IntegrationRegistrySurface) => {
    setInstallingUrl(surface.url);
    discover.mutate(
      { url: surface.url },
      {
        onSuccess: ({ integration }) => {
          setOpen(false);
          report({
            kind: 'success',
            text: integration.requiresAuthentication
              ? `Added ${integration.name}. Connect it to capture its tools.`
              : `Added ${integration.name} with ${integration.tools.length} ${integration.tools.length === 1 ? 'tool' : 'tools'}.`,
          });
          onAdded(integration);
        },
        onError: (error) => report({ kind: 'error', text: toErrorMessage(error, 'Failed to add integration.') }),
        onSettled: () => setInstallingUrl(null),
      },
    );
  };

  const searchSettled = needle.length > 0 && searchTerm === needle;
  const results = useMemo(() => {
    const browsed = narrowToKind(
      (registry.data?.results ?? []).filter((result) => needle.length === 0 || matchesNeedle(result, needle)),
      kind,
    );
    if (!searchSettled || search.data === undefined) return browsed;
    const found = narrowToKind(search.data.results, kind);
    const domains = new Set(found.map((result) => result.domain));
    return [...found, ...browsed.filter((result) => !domains.has(result.domain))];
  }, [kind, needle, registry.data?.results, search.data, searchSettled]);
  const loading =
    registry.isPending || (needle.length > 0 && results.length === 0 && (!searchSettled || search.isPending));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Search className="size-4" />
        Find integration
      </DialogTrigger>
      <DialogContent className="flex h-[44rem] max-h-[calc(100dvh-2rem)] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Find an integration</DialogTitle>
          <DialogDescription>
            Browse popular integrations from integrations.sh or search by service, domain, or capability.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search integrations"
              className="pr-9 pl-8"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search integrations…"
            />
            {query.length > 0 ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute top-1/2 right-2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger className="w-full sm:w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="mcp">MCP</SelectItem>
              <SelectItem value="openapi">OpenAPI</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {registry.isError ? (
          <ErrorBanner>
            <div className="flex items-center justify-between gap-3">
              <span>{toErrorMessage(registry.error, 'Could not load the integration registry.')}</span>
              <Button type="button" size="sm" variant="outline" onClick={() => void registry.refetch()}>
                Retry
              </Button>
            </div>
          </ErrorBanner>
        ) : null}
        {searchSettled && search.isError ? (
          <ErrorBanner>{toErrorMessage(search.error, 'Could not search the integration registry.')}</ErrorBanner>
        ) : null}
        {discover.isError ? (
          <ErrorBanner>{toErrorMessage(discover.error, 'Could not add the integration.')}</ErrorBanner>
        ) : null}

        {registry.isError ? null : (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {loading
              ? 'Loading integrations…'
              : `Showing ${results.length} ${results.length === 1 ? 'integration' : 'integrations'}${needle.length === 0 ? ' · Search to find more' : ''}`}
          </p>
        )}

        <section
          aria-busy={loading}
          aria-label="Integration catalog"
          className="grid min-h-0 flex-1 grid-cols-1 content-start items-start gap-3 overflow-y-auto pr-1 [scrollbar-gutter:stable] sm:grid-cols-2 lg:grid-cols-3"
        >
          {loading ? (
            skeletonCards.map((key) => (
              <div key={key} className={catalogCardClassName} aria-hidden="true">
                <div className="flex h-8 items-center gap-3">
                  <Skeleton className="size-8 shrink-0" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
                <div className="h-8 space-y-2">
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
                <Skeleton className="mt-auto h-7 w-24" />
              </div>
            ))
          ) : registry.isError ? null : results.length === 0 ? (
            <div className="col-span-full rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              No matching integrations.
            </div>
          ) : (
            results.map((result) => (
              <div key={result.domain} className={catalogCardClassName}>
                <div className="flex items-center gap-3">
                  <IntegrationIcon host={result.domain} size={32} />
                  <span className="min-w-0 flex-1 truncate font-medium" title={result.name}>
                    {result.name}
                  </span>
                  <a
                    href={result.registryUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    title="View on integrations.sh"
                  >
                    <ExternalLink className="size-3.5" />
                    <span className="sr-only">View {result.name} on integrations.sh</span>
                  </a>
                </div>
                <p className="line-clamp-2 h-8 text-xs leading-4 text-muted-foreground" title={result.description}>
                  {result.description}
                </p>
                <div className="mt-auto flex flex-wrap gap-2">
                  {result.surfaces.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No endpoint available</p>
                  ) : (
                    result.surfaces.map((surface) => {
                      const installed = installedSlugs.has(surface.slug);
                      return (
                        <Button
                          key={`${surface.kind}-${surface.slug}`}
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={installed || discover.isPending}
                          onClick={() => install(surface)}
                          aria-label={`${installed ? 'Added' : 'Add'} ${result.name} via ${kindLabel(surface.kind)}`}
                        >
                          <Download className="size-3" />
                          {installed ? 'Added' : installingUrl === surface.url ? 'Adding…' : 'Add'}{' '}
                          {kindLabel(surface.kind)}
                        </Button>
                      );
                    })
                  )}
                </div>
              </div>
            ))
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
