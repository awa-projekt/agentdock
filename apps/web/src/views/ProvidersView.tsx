import type { ProviderKey } from 'agentdock-sdk/schemas';
import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ConfirmButton } from '@/components/ConfirmButton';
import { ListSkeleton } from '@/components/Loading';
import { SectionHeader } from '@/components/SectionHeader';
import { StatusMessage } from '@/components/StatusMessage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAgentDraft } from '@/hooks/use-agent-draft';
import { useProviderKeys, useRemoveProviderKey, useSetProviderKey } from '@/lib/queries';
import { cn } from '@/lib/utils';

const CUSTOM_PROVIDER = '__custom__';
const AZURE_OPENAI_PROVIDER = '__azure_openai__';

type CustomProviderKind = 'azure-openai' | 'openai-compatible';

// Azure OpenAI's data-plane v1 surface only accepts api-version=preview.
const AZURE_OPENAI_API_VERSION = 'preview';

const normalizeAzureBaseUrl = (input: string): string => {
  try {
    return `${new URL(input.trim()).origin}/openai`;
  } catch {
    return input.trim();
  }
};

function AdvancedApiVersion({
  open,
  onToggle,
  value,
  onChange,
}: {
  open: boolean;
  onToggle: () => void;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="w-full space-y-2">
      <Button variant="ghost" size="sm" className="-ml-2" aria-expanded={open} onClick={onToggle}>
        <ChevronRight className={cn('transition-transform', open && 'rotate-90')} />
        Advanced
      </Button>
      {open ? (
        <div className="space-y-1.5">
          <label className="text-muted-foreground block text-xs font-medium">api-version</label>
          <Input
            autoComplete="off"
            placeholder={AZURE_OPENAI_API_VERSION}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="w-64"
          />
        </div>
      ) : null}
    </div>
  );
}

export function ProvidersView() {
  const { focusProvider, setFocusProvider } = useAgentDraft();
  const keysQuery = useProviderKeys();
  const keys = keysQuery.data ?? [];
  const setKey = useSetProviderKey();
  const removeKey = useRemoveProviderKey();
  const pending = setKey.isPending || removeKey.isPending;
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [keyDraft, setKeyDraft] = useState('');
  const [customId, setCustomId] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customApiVersion, setCustomApiVersion] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showEditAdvanced, setShowEditAdvanced] = useState(false);
  const addInputRef = useRef<HTMLInputElement>(null);

  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [editKey, setEditKey] = useState('');
  const [editName, setEditName] = useState('');
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editApiVersion, setEditApiVersion] = useState('');

  const configured = keys.filter((key) => key.source !== 'none');
  const addable = keys.filter((key) => key.source !== 'stored' && !key.custom);
  const effectiveProvider = selectedProvider || addable[0]?.provider || CUSTOM_PROVIDER;
  const isCustom = effectiveProvider === CUSTOM_PROVIDER;
  const isAzureOpenAI = effectiveProvider === AZURE_OPENAI_PROVIDER;

  const isCustomLike = isCustom || isAzureOpenAI;

  useEffect(() => {
    if (isAzureOpenAI) setCustomApiVersion((current) => current || AZURE_OPENAI_API_VERSION);
  }, [isAzureOpenAI]);

  useEffect(() => {
    if (!focusProvider) return undefined;
    if (keysQuery.status !== 'success') return undefined;
    const isBuiltin = keys.some((key) => !key.custom && key.provider === focusProvider);
    if (isBuiltin) {
      setSelectedProvider(focusProvider);
    } else {
      setSelectedProvider(CUSTOM_PROVIDER);
      setCustomId((current) => current || focusProvider);
    }
    addInputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    addInputRef.current?.focus();
    const timeout = window.setTimeout(() => setFocusProvider(null), 2200);
    return () => window.clearTimeout(timeout);
  }, [focusProvider, keysQuery.status, keysQuery.data, setFocusProvider]);

  const canSave = isCustomLike
    ? keyDraft.trim().length > 0 && customId.trim().length > 0 && customBaseUrl.trim().length > 0
    : Boolean(effectiveProvider) && keyDraft.trim().length > 0;

  const save = () => {
    if (!canSave) return;
    const apiKey = keyDraft.trim();
    const onSuccess = () => {
      setKeyDraft('');
      setCustomId('');
      setCustomBaseUrl('');
      setCustomApiVersion('');
      setShowAdvanced(false);
      setSelectedProvider('');
    };

    if (isCustomLike) {
      const kind: CustomProviderKind = isAzureOpenAI ? 'azure-openai' : 'openai-compatible';
      const baseUrl = isAzureOpenAI ? normalizeAzureBaseUrl(customBaseUrl) : customBaseUrl.trim();
      const apiVersion = customApiVersion.trim() || (isAzureOpenAI ? AZURE_OPENAI_API_VERSION : '');
      setKey.mutate(
        {
          provider: customId.trim(),
          input: {
            apiKey,
            baseUrl,
            kind,
            queryParams: apiVersion ? { 'api-version': apiVersion } : undefined,
          },
        },
        { onSuccess },
      );
    } else {
      setKey.mutate({ provider: effectiveProvider, input: { apiKey } }, { onSuccess });
    }
  };

  const clear = (provider: string) => removeKey.mutate(provider);

  const beginEdit = (key: ProviderKey) => {
    setEditingProvider(key.provider);
    setEditKey('');
    setEditName(key.name);
    setEditBaseUrl(key.baseUrl ?? '');
    const apiVersion = key.queryParams?.['api-version'] ?? '';
    setEditApiVersion(apiVersion);
    setShowEditAdvanced(apiVersion.length > 0);
  };

  const cancelEdit = () => {
    setEditingProvider(null);
    setEditKey('');
    setEditName('');
    setEditBaseUrl('');
    setEditApiVersion('');
    setShowEditAdvanced(false);
  };

  const canSaveEdit = (key: ProviderKey) => (key.custom ? editBaseUrl.trim().length > 0 : editKey.trim().length > 0);

  const saveEdit = (key: ProviderKey) => {
    if (!canSaveEdit(key)) return;
    const apiKey = editKey.trim();
    const onSuccess = () => cancelEdit();

    if (key.custom) {
      // Preserve the provider's kind; Azure-OpenAI keeps normalizing its endpoint to "<origin>/openai".
      const isAzureOpenAIEdit = key.kind === 'azure-openai';
      const kind: CustomProviderKind = isAzureOpenAIEdit ? 'azure-openai' : 'openai-compatible';
      const baseUrl = isAzureOpenAIEdit ? normalizeAzureBaseUrl(editBaseUrl) : editBaseUrl.trim();
      const apiVersion = editApiVersion.trim() || (isAzureOpenAIEdit ? AZURE_OPENAI_API_VERSION : '');
      setKey.mutate(
        {
          provider: key.provider,
          input: {
            apiKey,
            baseUrl,
            name: editName.trim() || key.provider,
            kind,
            queryParams: apiVersion ? { 'api-version': apiVersion } : undefined,
          },
        },
        { onSuccess },
      );
    } else {
      setKey.mutate({ provider: key.provider, input: { apiKey } }, { onSuccess });
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Providers"
        description="Add an API key for a provider to use its models. Keys are shared by all agents."
      />

      {keysQuery.status === 'pending' ? (
        <ListSkeleton />
      ) : keysQuery.status === 'error' ? (
        <StatusMessage kind="error">Could not load provider keys.</StatusMessage>
      ) : (
        <>
          <div
            className={cn(
              'rounded-xl border border-border bg-card p-4 transition-shadow',
              focusProvider && 'ring-2 ring-primary/50',
            )}
          >
            <div className="mb-3 text-sm font-medium">Add an API key</div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={effectiveProvider}
                items={[
                  ...addable.map((key) => ({ value: key.provider, label: key.name })),
                  { value: AZURE_OPENAI_PROVIDER, label: 'Azure OpenAI' },
                  { value: CUSTOM_PROVIDER, label: 'Custom (OpenAI-compatible)' },
                ]}
                onValueChange={setSelectedProvider}
              >
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Provider" />
                </SelectTrigger>
                <SelectContent>
                  {addable.map((key) => (
                    <SelectItem key={key.provider} value={key.provider}>
                      {key.name}
                    </SelectItem>
                  ))}
                  <SelectItem value={AZURE_OPENAI_PROVIDER}>Azure OpenAI</SelectItem>
                  <SelectItem value={CUSTOM_PROVIDER}>Custom (OpenAI-compatible)</SelectItem>
                </SelectContent>
              </Select>

              {isCustomLike ? (
                <>
                  <Input
                    autoComplete="off"
                    placeholder={isAzureOpenAI ? 'Provider id (e.g. azure)' : 'Provider id (e.g. openrouter)'}
                    value={customId}
                    onChange={(event) => setCustomId(event.target.value)}
                    className="w-44"
                  />
                  <Input
                    autoComplete="off"
                    placeholder={
                      isAzureOpenAI ? 'Endpoint (https://<res>.openai.azure.com)' : 'Base URL (https://…/v1)'
                    }
                    value={customBaseUrl}
                    onChange={(event) => setCustomBaseUrl(event.target.value)}
                    className="w-72"
                  />
                </>
              ) : null}

              <Input
                ref={addInputRef}
                type="password"
                autoComplete="off"
                placeholder="Paste API key"
                value={keyDraft}
                onChange={(event) => setKeyDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    save();
                  }
                }}
                className="w-72"
              />
              <Button type="button" size="sm" onClick={save} disabled={pending || !canSave}>
                Save
              </Button>

              {isCustomLike ? (
                <div className="w-full space-y-2">
                  {isAzureOpenAI ? (
                    <p className="text-xs text-muted-foreground">
                      Paste your Azure OpenAI <strong>endpoint</strong> (e.g.{' '}
                      <code className="font-mono">https://&lt;res&gt;.openai.azure.com</code>). Use your{' '}
                      <strong>deployment name</strong> (e.g. <code className="font-mono">gpt-5</code>) as the model in
                      the agent's model picker. Only Azure-hosted <strong>OpenAI</strong> models work here; for other
                      models on Azure use a Custom provider.
                    </p>
                  ) : null}
                  <AdvancedApiVersion
                    open={showAdvanced}
                    onToggle={() => setShowAdvanced((value) => !value)}
                    value={customApiVersion}
                    onChange={setCustomApiVersion}
                  />
                </div>
              ) : null}
            </div>
          </div>

          {configured.length === 0 ? (
            <p className="text-sm text-muted-foreground">No provider keys yet.</p>
          ) : (
            <div className="grid gap-2">
              {configured.map((key) =>
                editingProvider === key.provider ? (
                  <div key={key.provider} className="rounded-lg border border-border bg-card px-4 py-3">
                    <div className="mb-3 flex items-center gap-2">
                      <span className="text-sm font-medium">Edit {key.name}</span>
                      <span className="rounded-full border border-success/30 bg-success/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-success">
                        {key.custom ? (key.kind === 'azure-openai' ? 'Azure OpenAI' : 'Custom') : 'Saved'}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {key.custom ? (
                        <>
                          <Input
                            autoComplete="off"
                            placeholder="Display name"
                            value={editName}
                            onChange={(event) => setEditName(event.target.value)}
                            className="w-44"
                          />
                          <Input
                            autoComplete="off"
                            placeholder={
                              key.kind === 'azure-openai'
                                ? 'Endpoint (https://<res>.openai.azure.com)'
                                : 'Base URL (https://…/v1)'
                            }
                            value={editBaseUrl}
                            onChange={(event) => setEditBaseUrl(event.target.value)}
                            className="w-72"
                          />
                          <AdvancedApiVersion
                            open={showEditAdvanced}
                            onToggle={() => setShowEditAdvanced((value) => !value)}
                            value={editApiVersion}
                            onChange={setEditApiVersion}
                          />
                        </>
                      ) : null}
                      <Input
                        type="password"
                        autoComplete="off"
                        placeholder={key.custom ? 'New API key (leave blank to keep)' : 'Enter new API key'}
                        value={editKey}
                        onChange={(event) => setEditKey(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            saveEdit(key);
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            cancelEdit();
                          }
                        }}
                        className="w-72"
                      />
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => saveEdit(key)}
                        disabled={pending || !canSaveEdit(key)}
                      >
                        Save
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={cancelEdit} disabled={pending}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div
                    key={key.provider}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="text-sm font-medium">{key.name}</span>
                      <span className="rounded-full border border-success/30 bg-success/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-success">
                        {key.custom
                          ? key.kind === 'azure-openai'
                            ? 'Azure OpenAI'
                            : 'Custom'
                          : key.source === 'env'
                            ? 'Environment'
                            : 'Saved'}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">{key.maskedKey}</span>
                      {key.custom && key.baseUrl ? (
                        <span className="truncate font-mono text-xs text-muted-foreground">· {key.baseUrl}</span>
                      ) : null}
                    </div>
                    {key.source === 'stored' ? (
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => beginEdit(key)}
                          disabled={pending}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          Edit
                        </Button>
                        <ConfirmButton
                          size="sm"
                          variant="destructiveGhost"
                          onConfirm={() => clear(key.provider)}
                          disabled={pending}
                          title={`Remove ${key.name} key?`}
                          description="Agents using this provider will no longer be able to call its models."
                          confirmLabel="Remove key"
                        >
                          Clear
                        </ConfirmButton>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">from environment</span>
                    )}
                  </div>
                ),
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
