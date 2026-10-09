import { useMutation } from '@tanstack/react-query';
import type { AuthMethod, UserConnectionIntegration } from 'agentdock-sdk/schemas';
import { PlugZap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { ListSkeleton } from '@/components/Loading';
import { SectionHeader } from '@/components/SectionHeader';
import { ErrorBanner, type FeedbackMessage, StatusMessage } from '@/components/StatusMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { startUserOAuthConnection } from '@/lib/api';
import { formatDateTime, toErrorMessage } from '@/lib/format';
import { authorizeInPopup } from '@/lib/oauth';
import { queryKeys, useInvalidate, useRemoveUserConnection, useUserConnections } from '@/lib/queries';

const oauthMethod = (methods: ReadonlyArray<AuthMethod>): AuthMethod | undefined =>
  methods.find((method) => method.kind === 'oauth');

export function UserIntegrationsView() {
  const connectionsQuery = useUserConnections();
  const offered = (connectionsQuery.data?.integrations ?? []).filter((integration) => integration.offered);
  const invalidate = useInvalidate();
  const removeConnection = useRemoveUserConnection();
  const [message, setMessage] = useState<FeedbackMessage | null>(null);
  const authorization = useRef<AbortController | null>(null);

  useEffect(() => () => authorization.current?.abort(), []);

  const connect = useMutation({
    mutationFn: async (integration: UserConnectionIntegration) => {
      const controller = new AbortController();
      authorization.current = controller;
      const method = oauthMethod(integration.authMethods);
      const session = await startUserOAuthConnection(
        integration.slug,
        method === undefined ? {} : { template: method.template },
      );
      const settled = await authorizeInPopup(session, controller.signal);
      if (settled.state.status === 'failed') throw new Error(settled.state.message);
    },
    onSuccess: async (_result, integration) => {
      await invalidate(queryKeys.userConnections, queryKeys.integrations);
      setMessage({ kind: 'success', text: `Connected ${integration.name}.` });
    },
    onError: (error, integration) => {
      if (authorization.current?.signal.aborted) return;
      setMessage({ kind: 'error', text: toErrorMessage(error, `Failed to connect ${integration.name}.`) });
    },
  });

  const disconnect = (integration: UserConnectionIntegration) => {
    if (!integration.connection) return;
    removeConnection.mutate(
      { slug: integration.slug, name: integration.connection.name },
      {
        onSuccess: () => setMessage({ kind: 'success', text: `Disconnected ${integration.name}.` }),
        onError: (error) =>
          setMessage({ kind: 'error', text: toErrorMessage(error, `Failed to disconnect ${integration.name}.`) }),
      },
    );
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Your connections"
        description="Connect your own accounts for the integrations an agent reaches on your behalf."
      />

      {message ? <StatusMessage kind={message.kind}>{message.text}</StatusMessage> : null}

      {connectionsQuery.isPending ? (
        <ListSkeleton />
      ) : connectionsQuery.isError ? (
        <ErrorBanner>{toErrorMessage(connectionsQuery.error, 'Failed to load connections.')}</ErrorBanner>
      ) : offered.length === 0 ? (
        <EmptyState
          title="Nothing to connect"
          description="No agent reaches an integration through your own account yet."
        />
      ) : (
        <div className="grid gap-3">
          {offered.map((integration) => {
            const connection = integration.connection;
            const busy = connect.isPending && connect.variables?.slug === integration.slug;
            return (
              <div key={integration.slug} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-semibold">
                      <PlugZap className="size-4 text-muted-foreground" />
                      {integration.name}
                    </div>
                    <div className="mt-1 font-mono text-xs text-muted-foreground">{integration.slug}</div>
                    {integration.description ? (
                      <div className="mt-3 text-sm text-muted-foreground">{integration.description}</div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={connection ? 'default' : 'secondary'}>
                      {connection ? 'Connected' : 'Not connected'}
                    </Badge>
                    <Button type="button" onClick={() => connect.mutate(integration)} disabled={busy}>
                      {busy ? 'Authorizing…' : connection ? 'Reconnect' : 'Connect'}
                    </Button>
                    {busy ? (
                      <Button type="button" variant="outline" onClick={() => authorization.current?.abort()}>
                        Cancel
                      </Button>
                    ) : null}
                    {connection ? (
                      <Button type="button" variant="ghost" onClick={() => disconnect(integration)}>
                        Disconnect
                      </Button>
                    ) : null}
                  </div>
                </div>
                {connection ? (
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {connection.status === 'reauthorization_required' ? (
                      <Badge variant="destructive">needs reauthorization</Badge>
                    ) : null}
                    {connection.identityLabel ? <Badge variant="outline">{connection.identityLabel}</Badge> : null}
                    {connection.expiresAt ? (
                      <Badge variant="outline">expires {formatDateTime(connection.expiresAt)}</Badge>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
