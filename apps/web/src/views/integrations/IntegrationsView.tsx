import type {
  AuthMethod,
  CatalogTool,
  ConnectionView,
  IntegrationView,
  OAuthSessionView,
  ToolDecision,
} from 'agentdock-sdk/schemas';
import { ChevronDown, FileJson, Play, RefreshCw, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmButton } from '@/components/ConfirmButton';
import { EmptyState } from '@/components/EmptyState';
import { Field } from '@/components/form';
import { ListSkeleton } from '@/components/Loading';
import { MasterDetail } from '@/components/MasterDetail';
import { MarkdownPreview } from '@/components/markdown';
import { SectionHeader } from '@/components/SectionHeader';
import { ErrorBanner, type FeedbackMessage, StatusMessage } from '@/components/StatusMessage';
import { SchemaExplorer } from '@/components/schema-explorer';
import { ToolRunner } from '@/components/tool-runner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { provideOAuthClient } from '@/lib/api';
import type { AuthRole } from '@/lib/auth-client';
import { formatDateTime, toErrorMessage } from '@/lib/format';
import { authorizeInPopup } from '@/lib/oauth';
import {
  queryKeys,
  useConnectIntegration,
  useDiscoverIntegration,
  useIntegrations,
  useInvalidate,
  useRefreshConnection,
  useRemoveConnection,
  useRemoveIntegration,
  useSetToolDecision,
  useStartOAuthConnection,
} from '@/lib/queries';
import { IntegrationIcon, integrationHost } from './IntegrationIcon';
import { RegistrySearchDialog } from './RegistrySearchDialog';

type Report = (message: FeedbackMessage) => void;

const KIND_LABEL = { mcp: 'MCP', openapi: 'OpenAPI' } satisfies Record<IntegrationView['kind'], string>;

const DECISION_OPTIONS: ReadonlyArray<{
  readonly decision: ToolDecision;
  readonly label: string;
  readonly title: string;
  readonly icon: ReactNode;
}> = [
  {
    decision: 'allow',
    label: 'Allow',
    title: 'Allow: the tool runs unattended',
    icon: <ShieldCheck className="size-3.5" />,
  },
  {
    decision: 'require_approval',
    label: 'Approval',
    title: 'Require approval: every call waits for a human decision',
    icon: <ShieldAlert className="size-3.5" />,
  },
];

/** The value fields a static auth method needs, one per placement it fills. */
const valueFieldNames = (method: AuthMethod): ReadonlyArray<string> => {
  if (method.kind === 'none') return [];
  const names = method.placements?.map((placement) => placement.name) ?? [];
  return names.length > 0 ? [...new Set(names)] : ['token'];
};

const pluralTools = (count: number): string => `${count} ${count === 1 ? 'tool' : 'tools'}`;

export function IntegrationsView({ access }: { access: AuthRole }) {
  const integrationsQuery = useIntegrations();
  const integrations = integrationsQuery.data?.integrations ?? [];
  const [message, setMessage] = useState<FeedbackMessage | null>(null);
  const [connectingSlug, setConnectingSlug] = useState<string | null>(null);
  const installedSlugs = useMemo(() => new Set(integrations.map((integration) => integration.slug)), [integrations]);

  const list = (
    <div className="space-y-3">
      {integrationsQuery.isPending ? (
        <ListSkeleton />
      ) : integrationsQuery.isError ? (
        <ErrorBanner>{toErrorMessage(integrationsQuery.error, 'Could not load integrations.')}</ErrorBanner>
      ) : integrations.length > 0 ? (
        integrations.map((integration) => (
          <IntegrationCard
            key={integration.slug}
            integration={integration}
            report={setMessage}
            connecting={connectingSlug === integration.slug}
            onToggleConnect={() =>
              setConnectingSlug((current) => (current === integration.slug ? null : integration.slug))
            }
          />
        ))
      ) : (
        <EmptyState
          title="No integrations"
          description="Add a Streamable HTTP MCP endpoint or an OpenAPI document URL to expose its tools."
        />
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Integrations"
        description="Point Agentdock at an MCP endpoint or an OpenAPI document, connect it, then decide which of its tools may run unattended."
        actions={
          access === 'admin' ? (
            <RegistrySearchDialog
              installedSlugs={installedSlugs}
              report={setMessage}
              onAdded={(integration) => setConnectingSlug(integration.requiresAuthentication ? integration.slug : null)}
            />
          ) : undefined
        }
      />

      {message ? <StatusMessage kind={message.kind}>{message.text}</StatusMessage> : null}

      {access === 'admin' ? (
        <MasterDetail
          detailSide="right"
          detailWidth="360px"
          className="lg:items-start"
          master={list}
          detail={
            <AddIntegrationForm
              report={setMessage}
              onAdded={(integration) => setConnectingSlug(integration.requiresAuthentication ? integration.slug : null)}
            />
          }
        />
      ) : (
        list
      )}
    </div>
  );
}

function AddIntegrationForm({ report, onAdded }: { report: Report; onAdded: (integration: IntegrationView) => void }) {
  const [form, setForm] = useState({ url: '', name: '', slug: '' });
  const discover = useDiscoverIntegration();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = form.url.trim();
    if (!url) {
      report({ kind: 'error', text: 'Enter an integration URL.' });
      return;
    }
    discover.mutate(
      { url, name: form.name.trim() || undefined, slug: form.slug.trim() || undefined },
      {
        onSuccess: ({ integration }) => {
          setForm({ url: '', name: '', slug: '' });
          report({
            kind: 'success',
            text: integration.requiresAuthentication
              ? `Registered ${integration.name}. Connect it to capture its tools.`
              : `Registered ${integration.name} with ${pluralTools(integration.tools.length)}.`,
          });
          onAdded(integration);
        },
        onError: (error) => report({ kind: 'error', text: toErrorMessage(error, 'Failed to add integration.') }),
      },
    );
  };

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-border bg-card p-5">
      <div>
        <h2 className="font-semibold">Add integration</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          One URL is enough: Agentdock recognises an MCP endpoint, an OpenAPI document and a Google Discovery document,
          and reports how to authenticate.
        </p>
      </div>
      <Field label="URL" htmlFor="integration-url">
        <Input
          id="integration-url"
          value={form.url}
          onChange={(event) => setForm({ ...form, url: event.target.value })}
          placeholder="https://mcp.example.com/mcp"
        />
      </Field>
      <Field label="Name" htmlFor="integration-name" description="Optional. Defaults to the name the API reports.">
        <Input
          id="integration-name"
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          placeholder="Linear"
        />
      </Field>
      <Field label="Slug" htmlFor="integration-slug" description="Optional. Prefixes the generated tool ids.">
        <Input
          id="integration-slug"
          value={form.slug}
          onChange={(event) => setForm({ ...form, slug: event.target.value })}
          placeholder="linear"
        />
      </Field>
      <Button type="submit" disabled={discover.isPending} className="w-full">
        {discover.isPending ? 'Discovering…' : 'Add integration'}
      </Button>
    </form>
  );
}

function IntegrationCard({
  integration,
  report,
  connecting,
  onToggleConnect,
}: {
  integration: IntegrationView;
  report: Report;
  connecting: boolean;
  onToggleConnect: () => void;
}) {
  const removeIntegration = useRemoveIntegration();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (connecting) setExpanded(true);
  }, [connecting]);

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex items-start justify-between gap-4 p-5">
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-start gap-3 text-left">
          <ChevronDown className="mt-0.5 size-4 shrink-0 -rotate-90 text-muted-foreground transition-transform group-data-[panel-open]:rotate-0" />
          <IntegrationIcon host={integrationHost(integration)} size={18} className="mt-0.5" />
          <div className="min-w-0">
            <div className="truncate font-semibold" title={integration.name}>
              {integration.name}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{integration.slug}</span>
              <Badge variant="outline">{KIND_LABEL[integration.kind]}</Badge>
              <Badge variant="secondary">{pluralTools(integration.tools.length)}</Badge>
              {integration.connections.length > 0 ? (
                <Badge variant="success">
                  {integration.connections.length} {integration.connections.length === 1 ? 'connection' : 'connections'}
                </Badge>
              ) : null}
            </div>
            {integration.displayUrl ? (
              <div className="mt-2 truncate text-sm text-muted-foreground">{integration.displayUrl}</div>
            ) : null}
          </div>
        </CollapsibleTrigger>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={connecting ? 'outline' : 'ghost'}
            onClick={() => {
              setExpanded(true);
              onToggleConnect();
            }}
          >
            Connect
          </Button>
          <ConfirmButton
            size="icon-sm"
            variant="destructiveGhost"
            disabled={removeIntegration.isPending}
            onConfirm={() =>
              removeIntegration.mutate(integration.slug, {
                onSuccess: () => report({ kind: 'success', text: `Removed ${integration.name}.` }),
                onError: (error) =>
                  report({ kind: 'error', text: toErrorMessage(error, `Failed to remove ${integration.name}.`) }),
              })
            }
            title="Remove integration"
            description={`Remove ${integration.name}, its connections and its tools from Agentdock?`}
            confirmLabel="Remove integration"
          >
            <Trash2 className="size-4" />
          </ConfirmButton>
        </div>
      </div>

      <CollapsibleContent className="px-5 pb-5">
        {integration.toolError ? <ErrorBanner className="mb-3 text-xs">{integration.toolError}</ErrorBanner> : null}

        <div className="space-y-2">
          {integration.connections.length > 0 ? (
            integration.connections.map((connection) => (
              <ConnectionRow key={connection.name} integration={integration} connection={connection} report={report} />
            ))
          ) : (
            <p className="text-xs text-muted-foreground">
              {integration.requiresAuthentication
                ? 'Not connected yet. Connect it to capture its tools.'
                : 'No connection yet. This API needs no credentials.'}
            </p>
          )}
        </div>

        {connecting ? <ConnectPanel integration={integration} report={report} onConnected={onToggleConnect} /> : null}

        {integration.tools.length > 0 ? (
          <ul className="mt-4 divide-y divide-border/70 overflow-hidden rounded-lg border border-border">
            {integration.tools.map((tool) => (
              <li key={tool.id}>
                <ToolRow tool={tool} report={report} />
              </li>
            ))}
          </ul>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ConnectionRow({
  integration,
  connection,
  report,
}: {
  integration: IntegrationView;
  connection: ConnectionView;
  report: Report;
}) {
  const removeConnection = useRemoveConnection();
  const refreshConnection = useRefreshConnection();
  const target = { slug: integration.slug, name: connection.name };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2">
      <span className="min-w-0 truncate font-mono text-xs font-semibold" title={connection.name}>
        {connection.name}
      </span>
      <Badge className="shrink-0" variant={connection.status === 'connected' ? 'default' : 'destructive'}>
        {connection.status === 'connected' ? 'connected' : 'needs reauthorization'}
      </Badge>
      {connection.identityLabel ? <Badge variant="outline">{connection.identityLabel}</Badge> : null}
      {connection.expiresAt ? <Badge variant="outline">expires {formatDateTime(connection.expiresAt)}</Badge> : null}
      {connection.error ? (
        <span className="min-w-0 break-words text-xs text-destructive">{connection.error}</span>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          title="Re-capture this connection's tools"
          disabled={refreshConnection.isPending}
          onClick={() =>
            refreshConnection.mutate(target, {
              onSuccess: ({ tools }) =>
                report({ kind: 'success', text: `Refreshed ${connection.name}: ${pluralTools(tools.length)}.` }),
              onError: (error) =>
                report({ kind: 'error', text: toErrorMessage(error, `Failed to refresh ${connection.name}.`) }),
            })
          }
        >
          <RefreshCw className="size-4" />
        </Button>
        <ConfirmButton
          size="icon-sm"
          variant="destructiveGhost"
          disabled={removeConnection.isPending}
          onConfirm={() =>
            removeConnection.mutate(target, {
              onSuccess: () => report({ kind: 'success', text: `Removed ${connection.name}.` }),
              onError: (error) =>
                report({ kind: 'error', text: toErrorMessage(error, `Failed to remove ${connection.name}.`) }),
            })
          }
          title="Remove connection"
          description={`Remove ${connection.name} and the tools it contributed?`}
          confirmLabel="Remove connection"
        >
          <Trash2 className="size-4" />
        </ConfirmButton>
      </div>
    </div>
  );
}

function ConnectPanel({
  integration,
  report,
  onConnected,
}: {
  integration: IntegrationView;
  report: Report;
  onConnected: () => void;
}) {
  const methods = integration.authMethods;
  const [methodId, setMethodId] = useState(methods[0]?.id ?? '');
  const method = methods.find((candidate) => candidate.id === methodId) ?? methods[0];

  if (!method) {
    return (
      <p className="mt-4 rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
        This integration reports no way to authenticate.
      </p>
    );
  }

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-border bg-muted/20 p-3">
      {methods.length > 1 ? (
        <div className="flex flex-wrap gap-1.5">
          {methods.map((candidate) => (
            <Button
              key={candidate.id}
              type="button"
              size="sm"
              variant={candidate.id === method.id ? 'outline' : 'ghost'}
              onClick={() => setMethodId(candidate.id)}
            >
              {candidate.label}
            </Button>
          ))}
        </div>
      ) : null}
      {method.kind === 'oauth' ? (
        <OAuthConnectForm
          key={method.id}
          integration={integration}
          method={method}
          report={report}
          onConnected={onConnected}
        />
      ) : (
        <StaticConnectForm
          key={method.id}
          integration={integration}
          method={method}
          report={report}
          onConnected={onConnected}
        />
      )}
    </div>
  );
}

function StaticConnectForm({
  integration,
  method,
  report,
  onConnected,
}: {
  integration: IntegrationView;
  method: AuthMethod;
  report: Report;
  onConnected: () => void;
}) {
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const connect = useConnectIntegration();
  const fields = valueFieldNames(method);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    connect.mutate(
      {
        slug: integration.slug,
        input: {
          name: name.trim() || undefined,
          template: method.template,
          values: fields.length > 0 ? values : undefined,
        },
      },
      {
        onSuccess: ({ connection, tools }) => {
          report({ kind: 'success', text: `Connected ${connection.name} with ${pluralTools(tools.length)}.` });
          onConnected();
        },
        onError: (error) =>
          report({ kind: 'error', text: toErrorMessage(error, `Failed to connect ${integration.name}.`) }),
      },
    );
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <ConnectionNameField integration={integration} method={method} value={name} onChange={setName} />
      {fields.map((field) => (
        <Field key={field} label={field} htmlFor={`connect-${integration.slug}-${field}`}>
          <Input
            id={`connect-${integration.slug}-${field}`}
            type="password"
            value={values[field] ?? ''}
            onChange={(event) => setValues({ ...values, [field]: event.target.value })}
            placeholder="Secret value"
          />
        </Field>
      ))}
      <Button type="submit" disabled={connect.isPending} className="w-full">
        {connect.isPending ? 'Connecting…' : 'Connect'}
      </Button>
    </form>
  );
}

function OAuthConnectForm({
  integration,
  method,
  report,
  onConnected,
}: {
  integration: IntegrationView;
  method: AuthMethod;
  report: Report;
  onConnected: () => void;
}) {
  const [name, setName] = useState('');
  const [client, setClient] = useState({ clientId: '', clientSecret: '' });
  const [needsClient, setNeedsClient] = useState<{ readonly sessionId: string; readonly guidance: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const authorization = useRef<AbortController | null>(null);
  const startOAuth = useStartOAuthConnection();
  const invalidate = useInvalidate();

  useEffect(() => () => authorization.current?.abort(), []);

  const run = async (start: () => Promise<OAuthSessionView>) => {
    const controller = new AbortController();
    authorization.current = controller;
    setBusy(true);
    try {
      const session = await authorizeInPopup(await start(), controller.signal);
      if (session.state.status === 'needs-client') {
        setNeedsClient({ sessionId: session.id, guidance: session.state.guidance });
        return;
      }
      if (session.state.status === 'failed') throw new Error(session.state.message);
      setNeedsClient(null);
      await invalidate(queryKeys.integrations);
      report({ kind: 'success', text: `Connected ${session.connection}.` });
      onConnected();
    } catch (error) {
      if (!controller.signal.aborted) {
        report({ kind: 'error', text: toErrorMessage(error, `Failed to connect ${integration.name}.`) });
      }
    } finally {
      authorization.current = null;
      setBusy(false);
    }
  };

  const cancelButton = busy ? (
    <Button type="button" variant="outline" onClick={() => authorization.current?.abort()} className="w-full">
      Cancel
    </Button>
  ) : null;

  if (needsClient) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(() =>
            provideOAuthClient(needsClient.sessionId, {
              clientId: client.clientId.trim(),
              clientSecret: client.clientSecret.trim() || undefined,
            }),
          );
        }}
        className="space-y-3"
      >
        <p className="text-xs text-muted-foreground">{needsClient.guidance}</p>
        <Field label="Client ID" htmlFor={`oauth-client-id-${integration.slug}`}>
          <Input
            id={`oauth-client-id-${integration.slug}`}
            value={client.clientId}
            onChange={(event) => setClient({ ...client, clientId: event.target.value })}
          />
        </Field>
        <Field
          label="Client secret"
          htmlFor={`oauth-client-secret-${integration.slug}`}
          description="Leave empty for a public client."
        >
          <Input
            id={`oauth-client-secret-${integration.slug}`}
            type="password"
            value={client.clientSecret}
            onChange={(event) => setClient({ ...client, clientSecret: event.target.value })}
          />
        </Field>
        <Button type="submit" disabled={busy || !client.clientId.trim()} className="w-full">
          {busy ? 'Authorizing…' : 'Continue'}
        </Button>
        {cancelButton}
      </form>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void run(() =>
          startOAuth.mutateAsync({
            slug: integration.slug,
            input: { name: name.trim() || undefined, template: method.template },
          }),
        );
      }}
      className="space-y-3"
    >
      <ConnectionNameField integration={integration} method={method} value={name} onChange={setName} />
      <Button type="submit" disabled={busy} className="w-full">
        {busy ? 'Authorizing…' : 'Authorize'}
      </Button>
      {cancelButton}
    </form>
  );
}

function ConnectionNameField({
  integration,
  method,
  value,
  onChange,
}: {
  integration: IntegrationView;
  method: AuthMethod;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field
      label="Connection name"
      htmlFor={`connect-${integration.slug}-name`}
      description={`Optional. Names this ${method.label} connection and prefixes its tool ids.`}
    >
      <Input
        id={`connect-${integration.slug}-name`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="default"
      />
    </Field>
  );
}

function ToolRow({ tool, report }: { tool: CatalogTool; report: Report }) {
  const [panel, setPanel] = useState<'schema' | 'test' | null>(null);
  const setDecision = useSetToolDecision();
  const togglePanel = (next: 'schema' | 'test') => setPanel((current) => (current === next ? null : next));

  return (
    <div className="px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-mono text-xs font-semibold" title={tool.name}>
              {tool.name}
            </span>
            {tool.delegated ? (
              <Badge variant="outline" className="shrink-0">
                per user
              </Badge>
            ) : null}
          </div>
          {tool.description ? (
            <MarkdownPreview lines={3} className="mt-1.5 text-sm text-muted-foreground">
              {tool.description}
            </MarkdownPreview>
          ) : null}
          <div className="mt-2 flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant={panel === 'schema' ? 'outline' : 'ghost'}
              onClick={() => togglePanel('schema')}
            >
              <FileJson className="size-3.5" />
              Schema
            </Button>
            <Button
              type="button"
              size="sm"
              variant={panel === 'test' ? 'outline' : 'ghost'}
              onClick={() => togglePanel('test')}
            >
              <Play className="size-3.5" />
              Test
            </Button>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1" role="radiogroup" aria-label="Tool decision">
          {DECISION_OPTIONS.map((option) => (
            <Button
              key={option.decision}
              type="button"
              size="sm"
              role="radio"
              aria-checked={tool.decision === option.decision}
              variant={tool.decision === option.decision ? 'outline' : 'ghost'}
              title={option.title}
              disabled={setDecision.isPending || tool.decision === option.decision}
              onClick={() =>
                setDecision.mutate(
                  { toolId: tool.id, decision: option.decision },
                  {
                    onError: (error) =>
                      report({ kind: 'error', text: toErrorMessage(error, `Failed to update ${tool.name}.`) }),
                  },
                )
              }
            >
              {option.icon}
              {option.label}
            </Button>
          ))}
        </div>
      </div>
      {panel === 'schema' ? (
        <div className="mt-3 grid gap-3 rounded-lg border border-border/70 bg-muted/20 p-3 @3xl:grid-cols-2">
          <SchemaExplorer schema={tool.inputSchema} title="Input schema" />
          <SchemaExplorer schema={tool.outputSchema} title="Output schema" />
        </div>
      ) : panel === 'test' ? (
        <div className="mt-3 rounded-lg border border-border/70 bg-muted/20 p-3">
          <ToolRunner tool={tool} />
        </div>
      ) : null}
    </div>
  );
}
