import type { Model } from 'agentdock-sdk/schemas';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ListSkeleton } from '@/components/Loading';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { validateModel } from '@/lib/api';
import { toErrorMessage } from '@/lib/format';
import { useModels, useProviderKeys } from '@/lib/queries';
import { cn } from '@/lib/utils';

const PER_PROVIDER_LIMIT = 6;
const MAX_PROVIDER_GROUPS = 12;

const matches = (model: Model, query: string): boolean => {
  if (!query) return true;
  const haystack = `${model.provider} ${model.providerName} ${model.id} ${model.name}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
};

export function ModelPicker({
  id,
  value,
  onChange,
  onAddProviderKey,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  onAddProviderKey: (provider: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [manualProvider, setManualProvider] = useState('');
  const [manualModel, setManualModel] = useState('');
  const [validating, setValidating] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const selectedRef = useRef<HTMLDivElement>(null);
  const modelsQuery = useModels();
  const models = modelsQuery.data ?? [];
  const providerKeys = useProviderKeys().data ?? [];
  const availableProviders = useMemo(
    () => new Set(providerKeys.filter((key) => key.source !== 'none').map((key) => key.provider)),
    [providerKeys],
  );
  const customProviders = useMemo(() => providerKeys.filter((key) => key.custom), [providerKeys]);
  const activeManualProvider = manualProvider || customProviders[0]?.provider || '';
  const selected = useMemo(() => models.find((model) => model.value === value), [models, value]);
  const selectedUsable = selected ? availableProviders.has(selected.provider) : false;
  const trimmedQuery = query.trim();
  const filtered = useMemo(
    () =>
      trimmedQuery
        ? models.filter((model) => matches(model, trimmedQuery))
        : models.filter((model) => model.suggested || model.value === value),
    [models, trimmedQuery, value],
  );
  const { grouped, hiddenProviders } = useMemo(() => {
    const groups = new Map<string, { provider: string; hasKey: boolean; models: Array<Model>; hidden: number }>();
    for (const model of filtered) {
      const group = groups.get(model.providerName);
      if (group) {
        if (group.models.length < PER_PROVIDER_LIMIT) group.models.push(model);
        else group.hidden += 1;
      } else {
        groups.set(model.providerName, {
          provider: model.provider,
          hasKey: availableProviders.has(model.provider),
          models: [model],
          hidden: 0,
        });
      }
    }
    const ordered = [...groups.entries()]
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => Number(b.entry[1].hasKey) - Number(a.entry[1].hasKey) || a.index - b.index)
      .map(({ entry }) => entry);
    return {
      grouped: ordered.slice(0, MAX_PROVIDER_GROUPS),
      hiddenProviders: Math.max(0, ordered.length - MAX_PROVIDER_GROUPS),
    };
  }, [availableProviders, filtered]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setManualModel('');
    setManualError(null);
    const handle = window.setTimeout(() => selectedRef.current?.scrollIntoView({ block: 'nearest' }), 0);
    return () => window.clearTimeout(handle);
  }, [open]);

  const select = (next: string) => {
    onChange(next);
    setOpen(false);
  };
  const submitManual = async () => {
    const provider = activeManualProvider;
    const modelId = manualModel.trim();
    if (!provider || !modelId) return;
    const full = `${provider}:${modelId}`;
    setValidating(true);
    setManualError(null);
    try {
      const result = await validateModel(full);
      if (result.ok) {
        setManualModel('');
        select(full);
      } else {
        setManualError(result.error ?? 'Model validation failed.');
      }
    } catch (error) {
      setManualError(toErrorMessage(error, 'Validation failed.'));
    } finally {
      setValidating(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <input type="text" value={value} required readOnly tabIndex={-1} aria-hidden className="sr-only" />
      <PopoverTrigger
        id={id}
        className={cn(
          'border-input flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none',
          'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] dark:bg-input/30',
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected && selectedUsable ? (
            <>
              <span className="truncate">{selected.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{selected.providerName}</span>
            </>
          ) : !selected && value ? (
            <span className="truncate font-mono text-xs">{value}</span>
          ) : (
            <span className="text-muted-foreground">Select a model…</span>
          )}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground opacity-70" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--anchor-width) p-0">
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder="Search models…" />
          <CommandList className="h-80 [scrollbar-gutter:stable]">
            {modelsQuery.isLoading ? (
              <div className="p-2">
                <ListSkeleton compact />
              </div>
            ) : modelsQuery.isError ? (
              <div className="px-2 py-6 text-center text-sm text-destructive">Could not load models.</div>
            ) : (
              <>
                <CommandEmpty>
                  {trimmedQuery ? `No models match “${trimmedQuery}”.` : 'No models available.'}
                </CommandEmpty>
                {grouped.map(([providerName, group]) => (
                  <CommandGroup key={providerName} heading={providerName}>
                    {group.models.map((model) => {
                      const isSelected = model.value === value;
                      const keyless = !group.hasKey;
                      return (
                        <CommandItem
                          key={model.value}
                          ref={isSelected ? selectedRef : undefined}
                          value={model.value}
                          onSelect={() => (keyless ? onAddProviderKey(model.provider) : select(model.value))}
                          aria-selected={isSelected}
                          title={keyless ? `Add an API key for ${model.providerName} to use this model` : undefined}
                          className={cn(
                            keyless && 'text-muted-foreground',
                            isSelected &&
                              !keyless &&
                              'bg-primary/10 font-medium text-primary ring-1 ring-primary/30 ring-inset',
                          )}
                        >
                          <Check className={cn('size-3.5', isSelected && !keyless ? 'opacity-100' : 'opacity-0')} />
                          <span className="truncate">{model.name}</span>
                          {keyless ? (
                            <span className="ml-auto shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                              needs key
                            </span>
                          ) : null}
                        </CommandItem>
                      );
                    })}
                    {group.hidden > 0 ? (
                      <div className="px-2 py-1 pl-8 text-[11px] text-muted-foreground">
                        +{group.hidden} more — keep typing to narrow
                      </div>
                    ) : null}
                  </CommandGroup>
                ))}
                {hiddenProviders > 0 ? (
                  <div className="px-2 py-2 text-center text-xs text-muted-foreground">
                    +{hiddenProviders} more {hiddenProviders === 1 ? 'provider' : 'providers'} — refine your search.
                  </div>
                ) : !trimmedQuery && grouped.length > 0 ? (
                  <div className="px-2 py-2 text-center text-xs text-muted-foreground">
                    Suggested models — type to search all.
                  </div>
                ) : null}
              </>
            )}
          </CommandList>
          {customProviders.length > 0 ? (
            <div className="space-y-1.5 border-t p-2">
              <div className="px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Custom model id
              </div>
              <div className="flex items-center gap-2">
                {customProviders.length > 1 ? (
                  <select
                    value={activeManualProvider}
                    onChange={(event) => setManualProvider(event.target.value)}
                    className="border-input h-8 rounded-md border bg-popover px-2 text-sm text-popover-foreground outline-none"
                  >
                    {customProviders.map((provider) => (
                      <option key={provider.provider} value={provider.provider}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <input
                  value={manualModel}
                  onChange={(event) => {
                    setManualModel(event.target.value);
                    setManualError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void submitManual();
                    }
                  }}
                  placeholder="Model / deployment name (e.g. gpt-4o)"
                  className="border-input h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
                />
                <Button
                  size="lg"
                  onClick={() => void submitManual()}
                  disabled={validating || !manualModel.trim() || !activeManualProvider}
                >
                  {validating ? 'Testing…' : 'Use'}
                </Button>
              </div>
              {manualError ? (
                <p className="px-1 text-xs text-destructive">{manualError}</p>
              ) : (
                <p className="px-1 text-[11px] text-muted-foreground">
                  For providers that don't list models (e.g. Azure), enter the model/deployment name.
                </p>
              )}
            </div>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
