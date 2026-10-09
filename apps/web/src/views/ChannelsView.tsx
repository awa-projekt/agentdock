import type {
  ChannelAccount,
  ChannelAccountStatus,
  ChannelBinding,
  ChannelBindingMatch,
  ChannelPlatform,
  CreateChannelAccountInput,
  CreateChannelBindingInput,
} from 'agentdock-sdk/schemas';
import { ExternalLink, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ConfirmButton } from '@/components/ConfirmButton';
import { EmptyState } from '@/components/EmptyState';
import { Field, FormSection, Toggle } from '@/components/form';
import { ListSkeleton } from '@/components/Loading';
import { SectionHeader } from '@/components/SectionHeader';
import { type FeedbackMessage, StatusMessage } from '@/components/StatusMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiUrl } from '@/lib/api';
import { parseList, toErrorMessage } from '@/lib/format';
import {
  useAddChannelAccount,
  useAddChannelBinding,
  useAgents,
  useChannelAccountStatuses,
  useChannelAccounts,
  useChannelBindings,
  useRemoveChannelAccount,
  useRemoveChannelBinding,
  useUpdateChannelAccount,
  useUpdateChannelBinding,
  useWorkflows,
} from '@/lib/queries';

type TargetKind = 'agent' | 'workflow';
type Scope = 'account' | 'workspace' | 'channel' | 'direct';

type AccountForm = {
  platform: ChannelPlatform;
  name: string;
  applicationId: string;
  secret: string;
  publicKey: string;
  appType: 'MultiTenant' | 'SingleTenant';
  tenantId: string;
};

type BindingForm = {
  accountId: string;
  name: string;
  targetKind: TargetKind;
  targetId: string;
  scope: Scope;
  workspaceId: string;
  peerId: string;
  requireMention: boolean;
  allowedUserIds: string;
  enabled: boolean;
};

const emptyAccountForm = (): AccountForm => ({
  platform: 'discord',
  name: '',
  applicationId: '',
  secret: '',
  publicKey: '',
  appType: 'MultiTenant',
  tenantId: '',
});

const emptyBindingForm = (accountId: string): BindingForm => ({
  accountId,
  name: '',
  targetKind: 'agent',
  targetId: '',
  scope: 'account',
  workspaceId: '',
  peerId: '',
  requireMention: true,
  allowedUserIds: '',
  enabled: true,
});

const SCOPES: ReadonlyArray<Scope> = ['account', 'workspace', 'channel', 'direct'];

const SCOPE_LABELS = {
  account: 'Everything this bot can see',
  workspace: 'One server or Team',
  channel: 'One channel (and its threads)',
  direct: 'Direct messages',
} satisfies Record<Scope, string>;

const scopeOf = (match: ChannelBindingMatch): Scope =>
  match.peerKind === 'direct'
    ? 'direct'
    : match.peerKind === 'channel'
      ? 'channel'
      : match.workspaceId
        ? 'workspace'
        : 'account';

const bindingToForm = (binding: ChannelBinding): BindingForm => ({
  accountId: binding.accountId,
  name: binding.name,
  targetKind: binding.target.kind,
  targetId: binding.target.id,
  scope: scopeOf(binding.match),
  workspaceId: binding.match.workspaceId ?? '',
  peerId: binding.match.peerId ?? '',
  requireMention: binding.requireMention,
  allowedUserIds: binding.allowedUserIds.join(', '),
  enabled: binding.enabled,
});

const buildMatch = (form: BindingForm): ChannelBindingMatch => {
  const workspaceId = form.workspaceId.trim();
  const peerId = form.peerId.trim();
  switch (form.scope) {
    case 'account':
      return {};
    case 'workspace':
      return { workspaceId };
    case 'channel':
      if (peerId && workspaceId) return { peerKind: 'channel', peerId, workspaceId };
      if (peerId) return { peerKind: 'channel', peerId };
      if (workspaceId) return { peerKind: 'channel', workspaceId };
      return { peerKind: 'channel' };
    case 'direct':
      return peerId ? { peerKind: 'direct', peerId } : { peerKind: 'direct' };
  }
};

const buildBindingInput = (form: BindingForm): CreateChannelBindingInput => ({
  // SAFETY: the account id comes from an account the server returned; the brand is a server-side invariant.
  accountId: form.accountId as CreateChannelBindingInput['accountId'],
  name: form.name.trim(),
  enabled: form.enabled,
  target: { kind: form.targetKind, id: form.targetId },
  match: buildMatch(form),
  requireMention: form.requireMention,
  allowedUserIds: parseList(form.allowedUserIds),
});

const bindingInput = (binding: ChannelBinding): CreateChannelBindingInput => ({
  accountId: binding.accountId,
  name: binding.name,
  enabled: binding.enabled,
  target: binding.target,
  match: binding.match,
  requireMention: binding.requireMention,
  allowedUserIds: binding.allowedUserIds,
});

const inviteUrl = (applicationId: string): string =>
  `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&scope=bot%20applications.commands&permissions=397284673600`;

const webhookUrl = (accountId: string): string => apiUrl(`/channels/${encodeURIComponent(accountId)}/webhook`);

const describeMatch = (match: ChannelBindingMatch): string => {
  switch (scopeOf(match)) {
    case 'account':
      return 'all conversations';
    case 'workspace':
      return `workspace ${match.workspaceId}`;
    case 'channel':
      return match.peerId ? `channel ${match.peerId}` : 'any channel';
    case 'direct':
      return match.peerId ? `DMs from ${match.peerId}` : 'all DMs';
  }
};

const statusVariant = (status: ChannelAccountStatus['state']): 'success' | 'warning' | 'outline' | 'destructive' => {
  switch (status) {
    case 'connected':
      return 'success';
    case 'connecting':
      return 'warning';
    case 'disconnected':
      return 'outline';
    case 'error':
      return 'destructive';
  }
};

export function ChannelsView() {
  const accountsQuery = useChannelAccounts();
  const bindingsQuery = useChannelBindings();
  const statusQuery = useChannelAccountStatuses();
  const agents = useAgents().data ?? [];
  const workflows = useWorkflows().data ?? [];
  const accounts = accountsQuery.data ?? [];
  const bindings = bindingsQuery.data ?? [];
  const statusById = useMemo(
    () => new Map((statusQuery.data ?? []).map((status) => [status.accountId, status])),
    [statusQuery.data],
  );

  const addAccount = useAddChannelAccount();
  const updateAccount = useUpdateChannelAccount();
  const removeAccount = useRemoveChannelAccount();
  const addBinding = useAddChannelBinding();
  const updateBinding = useUpdateChannelBinding();
  const removeBinding = useRemoveChannelBinding();
  const pending =
    addAccount.isPending ||
    updateAccount.isPending ||
    removeAccount.isPending ||
    addBinding.isPending ||
    updateBinding.isPending ||
    removeBinding.isPending;

  const [accountForm, setAccountForm] = useState<AccountForm>(emptyAccountForm);
  const [bindingForm, setBindingForm] = useState<BindingForm>(() => emptyBindingForm(''));
  const [editingBindingId, setEditingBindingId] = useState<string | null>(null);
  const [message, setMessage] = useState<FeedbackMessage | null>(null);

  const report = (text: string, onDone?: () => void) => ({
    onSuccess: () => {
      setMessage({ kind: 'success' as const, text });
      onDone?.();
    },
    onError: (error: Error) => setMessage({ kind: 'error' as const, text: toErrorMessage(error, 'Request failed.') }),
  });

  const targetOptions =
    bindingForm.targetKind === 'agent'
      ? agents.map((agent) => ({ id: agent.id, name: agent.name }))
      : workflows.map((workflow) => ({ id: workflow.id, name: workflow.manifest.name }));
  const targetName = useMemo(() => {
    const lookup = new Map<string, string>();
    for (const agent of agents) lookup.set(`agent:${agent.id}`, agent.name);
    for (const workflow of workflows) lookup.set(`workflow:${workflow.id}`, workflow.manifest.name);
    return (target: ChannelBinding['target']) => lookup.get(`${target.kind}:${target.id}`) ?? target.id;
  }, [agents, workflows]);
  const accountName = (accountId: string) => accounts.find((account) => account.id === accountId)?.name ?? accountId;

  const patchBinding = (next: Partial<BindingForm>) => setBindingForm((current) => ({ ...current, ...next }));
  const effectiveAccountId = bindingForm.accountId || accounts[0]?.id || '';

  const canCreateAccount =
    accountForm.name.trim().length > 0 &&
    accountForm.applicationId.trim().length > 0 &&
    accountForm.secret.trim().length > 0 &&
    (accountForm.platform !== 'teams' ||
      accountForm.appType !== 'SingleTenant' ||
      accountForm.tenantId.trim().length > 0);
  const canSaveBinding =
    effectiveAccountId.length > 0 &&
    bindingForm.name.trim().length > 0 &&
    bindingForm.targetId.length > 0 &&
    (bindingForm.scope !== 'workspace' || bindingForm.workspaceId.trim().length > 0);

  const submitAccount = () => {
    setMessage(null);
    const name = accountForm.name.trim();
    const applicationId = accountForm.applicationId.trim();
    const secret = accountForm.secret.trim();
    const publicKey = accountForm.publicKey.trim();
    const discordBase = { botToken: secret, applicationId };
    const teamsBase = { appId: applicationId, appPassword: secret };
    const input: CreateChannelAccountInput =
      accountForm.platform === 'discord'
        ? {
            name,
            platform: 'discord',
            enabled: true,
            credentials: publicKey ? { ...discordBase, publicKey } : discordBase,
          }
        : {
            name,
            platform: 'teams',
            enabled: true,
            credentials:
              accountForm.appType === 'SingleTenant'
                ? { ...teamsBase, appType: 'SingleTenant', tenantId: accountForm.tenantId.trim() }
                : { ...teamsBase, appType: 'MultiTenant' },
          };
    const platformName = accountForm.platform === 'discord' ? 'Discord' : 'Microsoft Teams';
    addAccount.mutate(
      input,
      report(`${platformName} bot added. It connects within a few seconds.`, () => setAccountForm(emptyAccountForm())),
    );
  };

  const toggleAccount = (account: ChannelAccount) => {
    setMessage(null);
    updateAccount.mutate(
      { accountId: account.id, input: { name: account.name, enabled: !account.enabled, platform: account.platform } },
      report(account.enabled ? 'Bot disabled.' : 'Bot enabled.'),
    );
  };

  const deleteAccount = (account: ChannelAccount) => {
    setMessage(null);
    removeAccount.mutate(account.id, report('Bot removed.'));
  };

  const submitBinding = () => {
    setMessage(null);
    const input = buildBindingInput({ ...bindingForm, accountId: effectiveAccountId });
    const done = report(editingBindingId ? 'Binding updated.' : 'Binding created.', () => {
      setBindingForm(emptyBindingForm(effectiveAccountId));
      setEditingBindingId(null);
    });
    if (editingBindingId) updateBinding.mutate({ bindingId: editingBindingId, input }, done);
    else addBinding.mutate(input, done);
  };

  const startEditBinding = (binding: ChannelBinding) => {
    setBindingForm(bindingToForm(binding));
    setEditingBindingId(binding.id);
    setMessage(null);
  };

  const toggleBinding = (binding: ChannelBinding) => {
    setMessage(null);
    updateBinding.mutate(
      { bindingId: binding.id, input: { ...bindingInput(binding), enabled: !binding.enabled } },
      report(binding.enabled ? 'Binding disabled.' : 'Binding enabled.'),
    );
  };

  const deleteBinding = (binding: ChannelBinding) => {
    setMessage(null);
    removeBinding.mutate(
      binding.id,
      report('Binding removed.', () => {
        if (editingBindingId === binding.id) {
          setEditingBindingId(null);
          setBindingForm(emptyBindingForm(effectiveAccountId));
        }
      }),
    );
  };

  const loadError = accountsQuery.error ?? bindingsQuery.error;

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Channels"
        description="Connect chat platforms and decide which agent or workflow answers in each conversation."
      />
      {message ? <StatusMessage kind={message.kind}>{message.text}</StatusMessage> : null}
      {loadError ? (
        <StatusMessage kind="error">{toErrorMessage(loadError, 'Could not load channels.')}</StatusMessage>
      ) : null}

      <FormSection
        title="Channel bots"
        description="Connect a Discord or Microsoft Teams bot. Bot secrets are encrypted before they are stored."
      >
        <div className="grid gap-4">
          {accountsQuery.isPending ? <ListSkeleton /> : null}
          {accounts.map((account) => {
            const status = statusById.get(account.id);
            return (
              <div key={account.id} className="rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold">{account.name}</h3>
                      <Badge variant="secondary">
                        {account.platform === 'discord' ? 'Discord' : 'Microsoft Teams'}
                      </Badge>
                      {account.enabled ? (
                        <Badge variant={status ? statusVariant(status.state) : 'secondary'}>
                          {status ? status.state : 'starting'}
                        </Badge>
                      ) : (
                        <Badge variant="outline">Disabled</Badge>
                      )}
                    </div>
                    {account.platform === 'discord' ? (
                      <p className="mt-1 text-sm text-muted-foreground">
                        Application <span className="font-mono">{account.applicationId}</span> · token{' '}
                        <span className="font-mono">{account.botTokenMask}</span>
                        {status?.botUserName ? ` · @${status.botUserName}` : null}
                      </p>
                    ) : (
                      <div className="mt-1 space-y-1 text-sm text-muted-foreground">
                        <p>
                          App <span className="font-mono">{account.appId}</span> · password{' '}
                          <span className="font-mono">{account.appPasswordMask}</span> · {account.appType}
                        </p>
                        <p>
                          Messaging endpoint <span className="break-all font-mono">{webhookUrl(account.id)}</span>
                        </p>
                      </div>
                    )}
                    {status?.error ? <p className="mt-1 text-xs text-destructive">{status.error}</p> : null}
                    {account.platform === 'discord' ? (
                      <a
                        href={inviteUrl(account.applicationId)}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
                      >
                        <ExternalLink className="size-3" /> Invite this bot to a server
                      </a>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => void toggleAccount(account)}
                    >
                      {account.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <ConfirmButton
                      size="icon-sm"
                      variant="destructiveGhost"
                      disabled={pending}
                      onConfirm={() => deleteAccount(account)}
                      title="Remove bot"
                      description={`Remove ${account.name} and all of its channel bindings?`}
                    >
                      <Trash2 className="size-4" />
                    </ConfirmButton>
                  </div>
                </div>
              </div>
            );
          })}
          {accounts.length === 0 && accountsQuery.status === 'success' ? (
            <EmptyState title="No bots yet" description="Add a channel bot below to start receiving messages." />
          ) : null}
        </div>

        <div className="space-y-4 rounded-lg border border-border p-4">
          <div className="text-sm font-medium">Add a channel bot</div>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Platform" htmlFor="channel-account-platform">
              <Select
                value={accountForm.platform}
                items={{ discord: 'Discord', teams: 'Microsoft Teams' }}
                onValueChange={(value) =>
                  setAccountForm({ ...emptyAccountForm(), platform: value === 'teams' ? 'teams' : 'discord' })
                }
              >
                <SelectTrigger id="channel-account-platform" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="discord">Discord</SelectItem>
                  <SelectItem value="teams">Microsoft Teams</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Name" htmlFor="channel-account-name">
              <Input
                id="channel-account-name"
                value={accountForm.name}
                onChange={(event) => setAccountForm({ ...accountForm, name: event.target.value })}
                placeholder="Support bot"
              />
            </Field>
            <Field
              label={accountForm.platform === 'discord' ? 'Application ID' : 'Microsoft App ID'}
              htmlFor="channel-account-app"
              description={
                accountForm.platform === 'discord'
                  ? 'General Information → Application ID.'
                  : 'The client ID of the Azure bot registration.'
              }
            >
              <Input
                id="channel-account-app"
                value={accountForm.applicationId}
                onChange={(event) => setAccountForm({ ...accountForm, applicationId: event.target.value })}
                className="font-mono"
              />
            </Field>
          </div>
          <Field
            label={accountForm.platform === 'discord' ? 'Bot token' : 'Microsoft App password'}
            htmlFor="channel-account-token"
            description={
              accountForm.platform === 'discord'
                ? 'Bot → Reset Token. Shown once by Discord.'
                : 'The client secret value for the Azure bot registration.'
            }
          >
            <Input
              id="channel-account-token"
              type="password"
              value={accountForm.secret}
              onChange={(event) => setAccountForm({ ...accountForm, secret: event.target.value })}
              className="font-mono"
            />
          </Field>
          {accountForm.platform === 'discord' ? (
            <Field
              label="Public key"
              htmlFor="channel-account-key"
              description="Optional. Only needed later for HTTP interactions; the gateway connection works without it."
            >
              <Input
                id="channel-account-key"
                value={accountForm.publicKey}
                onChange={(event) => setAccountForm({ ...accountForm, publicKey: event.target.value })}
                className="font-mono"
              />
            </Field>
          ) : (
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="App type" htmlFor="channel-account-app-type">
                <Select
                  value={accountForm.appType}
                  items={{ MultiTenant: 'Multi-tenant', SingleTenant: 'Single-tenant' }}
                  onValueChange={(value) =>
                    setAccountForm({
                      ...accountForm,
                      appType: value === 'SingleTenant' ? 'SingleTenant' : 'MultiTenant',
                    })
                  }
                >
                  <SelectTrigger id="channel-account-app-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MultiTenant">Multi-tenant</SelectItem>
                    <SelectItem value="SingleTenant">Single-tenant</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {accountForm.appType === 'SingleTenant' ? (
                <Field label="Tenant ID" htmlFor="channel-account-tenant">
                  <Input
                    id="channel-account-tenant"
                    value={accountForm.tenantId}
                    onChange={(event) => setAccountForm({ ...accountForm, tenantId: event.target.value })}
                    className="font-mono"
                  />
                </Field>
              ) : null}
            </div>
          )}
          <Button type="button" onClick={submitAccount} disabled={pending || !canCreateAccount}>
            Add bot
          </Button>
        </div>
      </FormSection>

      <FormSection
        title="Bindings"
        description="A binding picks the agent or workflow for a slice of a bot's traffic. The most specific match wins; each platform thread or DM keeps its own conversation."
      >
        <div className="space-y-4 rounded-lg border border-border p-4">
          <div className="text-sm font-medium">{editingBindingId ? 'Edit binding' : 'New binding'}</div>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Bot" htmlFor="binding-account">
              <Select
                value={effectiveAccountId}
                items={accounts.map((account) => ({ value: account.id, label: account.name }))}
                onValueChange={(value) => patchBinding({ accountId: value })}
              >
                <SelectTrigger id="binding-account" className="w-full">
                  <SelectValue placeholder="Select bot…" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Name" htmlFor="binding-name">
              <Input
                id="binding-name"
                value={bindingForm.name}
                onChange={(event) => patchBinding({ name: event.target.value })}
                placeholder="#support → support agent"
              />
            </Field>
            <Field label="Target type" htmlFor="binding-target-kind">
              <Select
                value={bindingForm.targetKind}
                items={{ agent: 'Agent', workflow: 'Workflow' }}
                onValueChange={(value) =>
                  patchBinding({ targetKind: value === 'workflow' ? 'workflow' : 'agent', targetId: '' })
                }
              >
                <SelectTrigger id="binding-target-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="agent">Agent</SelectItem>
                  <SelectItem value="workflow">Workflow</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Target" htmlFor="binding-target-id">
              <Select
                value={bindingForm.targetId}
                items={targetOptions.map((option) => ({ value: option.id, label: option.name }))}
                onValueChange={(value) => patchBinding({ targetId: value })}
              >
                <SelectTrigger id="binding-target-id" className="w-full">
                  <SelectValue placeholder={`Select ${bindingForm.targetKind}…`} />
                </SelectTrigger>
                <SelectContent>
                  {targetOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field label="Applies to" htmlFor="binding-scope">
            <Select
              value={bindingForm.scope}
              items={SCOPE_LABELS}
              onValueChange={(value) =>
                patchBinding({
                  scope: value === 'workspace' || value === 'channel' || value === 'direct' ? value : 'account',
                })
              }
            >
              <SelectTrigger id="binding-scope" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCOPES.map((scope) => (
                  <SelectItem key={scope} value={scope}>
                    {SCOPE_LABELS[scope]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {bindingForm.scope === 'workspace' || bindingForm.scope === 'channel' ? (
            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Server / Team ID"
                htmlFor="binding-workspace"
                description="The Discord server ID or Microsoft Teams team ID."
              >
                <Input
                  id="binding-workspace"
                  value={bindingForm.workspaceId}
                  onChange={(event) => patchBinding({ workspaceId: event.target.value })}
                  className="font-mono"
                />
              </Field>
              {bindingForm.scope === 'channel' ? (
                <Field
                  label="Channel ID"
                  htmlFor="binding-peer"
                  description="Leave empty to match any channel in the server or Team."
                >
                  <Input
                    id="binding-peer"
                    value={bindingForm.peerId}
                    onChange={(event) => patchBinding({ peerId: event.target.value })}
                    className="font-mono"
                  />
                </Field>
              ) : null}
            </div>
          ) : null}
          {bindingForm.scope === 'direct' ? (
            <Field label="User ID" htmlFor="binding-peer" description="Leave empty to match DMs from anyone.">
              <Input
                id="binding-peer"
                value={bindingForm.peerId}
                onChange={(event) => patchBinding({ peerId: event.target.value })}
                className="font-mono"
              />
            </Field>
          ) : null}

          <Field
            label="Allowed users"
            htmlFor="binding-allowed"
            description="Comma-separated platform user IDs. Empty allows everyone the scope admits."
          >
            <Input
              id="binding-allowed"
              value={bindingForm.allowedUserIds}
              onChange={(event) => patchBinding({ allowedUserIds: event.target.value })}
              className="font-mono"
            />
          </Field>
          <Toggle
            label="Require @mention in channels"
            description="Only answer channel messages that mention the bot. DMs and follow-ups inside a thread the bot opened always get through."
            checked={bindingForm.requireMention}
            onChange={(checked) => patchBinding({ requireMention: checked })}
          />
          <Toggle
            label="Enabled"
            description="Disabled bindings stay configured but never match."
            checked={bindingForm.enabled}
            onChange={(checked) => patchBinding({ enabled: checked })}
          />
          <div className="flex gap-2">
            <Button type="button" onClick={submitBinding} disabled={pending || !canSaveBinding}>
              {editingBindingId ? 'Save changes' : 'Create binding'}
            </Button>
            {editingBindingId ? (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setEditingBindingId(null);
                  setBindingForm(emptyBindingForm(effectiveAccountId));
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </div>

        <div className="grid gap-4">
          {bindingsQuery.isPending ? <ListSkeleton /> : null}
          {bindings.map((binding) => (
            <div key={binding.id} className="rounded-xl border border-border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{binding.name}</h3>
                    {binding.enabled ? <Badge>Enabled</Badge> : <Badge variant="outline">Disabled</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {accountName(binding.accountId)} · {describeMatch(binding.match)} →{' '}
                    {binding.target.kind === 'agent' ? 'agent' : 'workflow'} {targetName(binding.target)}
                    {binding.requireMention ? ' · mention required' : ''}
                    {binding.allowedUserIds.length > 0 ? ` · ${binding.allowedUserIds.length} allowed user(s)` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => void toggleBinding(binding)}
                  >
                    {binding.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => startEditBinding(binding)}
                  >
                    Edit
                  </Button>
                  <ConfirmButton
                    size="icon-sm"
                    variant="destructiveGhost"
                    disabled={pending}
                    onConfirm={() => deleteBinding(binding)}
                    title="Delete binding"
                    description={`Stop routing ${describeMatch(binding.match)} through this binding?`}
                  >
                    <Trash2 className="size-4" />
                  </ConfirmButton>
                </div>
              </div>
            </div>
          ))}
          {bindings.length === 0 && bindingsQuery.status === 'success' ? (
            <EmptyState
              title="No bindings yet"
              description="Without a binding the bot ignores every message. Create one above to route conversations to an agent or workflow."
            />
          ) : null}
        </div>
      </FormSection>
    </div>
  );
}
