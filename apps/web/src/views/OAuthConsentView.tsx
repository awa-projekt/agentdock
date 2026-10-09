import type { McpAuthorizationRequestView } from 'agentdock-sdk/schemas';
import { ArrowLeftRight, Bot, Command, Eye, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { toErrorMessage } from '@/lib/format';
import { useDecideMcpAuthorizationRequest, useMcpAuthorizationRequest } from '@/lib/queries';
import { IntegrationIcon } from '@/views/integrations/IntegrationIcon';

/** A client identified by its metadata document is vouched for by that document's host. */
const clientHost = (request: McpAuthorizationRequestView): string | undefined =>
  request.clientKind === 'cimd' && URL.canParse(request.clientId) ? new URL(request.clientId).hostname : undefined;

/**
 * Where an MCP client's OAuth authorization lands: the signed-in admin sees
 * which program asks to operate this instance on their behalf and approves or
 * denies it; the browser then returns to the client with a code or an error.
 */
export function OAuthConsentView({ requestId, userEmail }: { requestId: string; userEmail: string | null }) {
  const request = useMcpAuthorizationRequest(requestId);
  const decide = useDecideMcpAuthorizationRequest(requestId);

  const submit = (approve: boolean) =>
    decide.mutate(approve, { onSuccess: ({ redirect }) => window.location.assign(redirect) });

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10 text-foreground">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-6 pt-6">
          {request.isPending ? (
            <div className="space-y-4">
              <Skeleton className="mx-auto h-12 w-32" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : null}

          {request.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Authorization unavailable</AlertTitle>
              <AlertDescription>
                {toErrorMessage(request.error, 'This authorization request is unknown or has expired.')}
              </AlertDescription>
            </Alert>
          ) : null}

          {request.data ? (
            <>
              <div className="flex flex-col items-center gap-4 text-center">
                <div className="flex items-center gap-3">
                  <span className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                    <Command className="size-5" />
                  </span>
                  <ArrowLeftRight className="size-4 text-muted-foreground" />
                  <span className="flex size-12 items-center justify-center rounded-xl border border-border bg-muted/40">
                    <IntegrationIcon host={clientHost(request.data)} size={28} />
                  </span>
                </div>
                <div className="space-y-1">
                  <h1 className="text-xl font-semibold tracking-tight">Connect {request.data.clientName}</h1>
                  <p className="text-sm text-muted-foreground">
                    {request.data.clientName} wants to operate this Agentdock instance
                    {userEmail ? (
                      <>
                        {' '}
                        as <span className="text-foreground">{userEmail}</span>
                      </>
                    ) : null}
                    .
                  </p>
                </div>
              </div>

              <ul className="space-y-2 text-sm">
                <Capability icon={<Bot className="size-4" />}>
                  Create, change and remove agents, skills, integrations and workflows
                </Capability>
                <Capability icon={<Eye className="size-4" />}>Read chat sessions, evals and traces</Capability>
              </ul>

              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg bg-muted/40 px-3 py-2.5 text-xs">
                <dt className="text-muted-foreground">Verified by</dt>
                <dd className="truncate text-right" title={request.data.clientId}>
                  {clientHost(request.data) ?? 'Not verified: registered on connect'}
                </dd>
                <dt className="text-muted-foreground">Returns to</dt>
                <dd className="truncate text-right font-mono" title={request.data.redirectOrigin}>
                  {request.data.redirectOrigin}
                </dd>
              </dl>

              {decide.isError ? (
                <Alert variant="destructive">
                  <AlertTitle>Could not finish</AlertTitle>
                  <AlertDescription>
                    {toErrorMessage(decide.error, 'The decision could not be recorded.')}
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" disabled={decide.isPending} onClick={() => submit(false)}>
                    Deny
                  </Button>
                  <Button disabled={decide.isPending} onClick={() => submit(true)}>
                    {decide.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                    Approve
                  </Button>
                </div>
                <p className="text-center text-xs text-muted-foreground">
                  Only approve a connection you just started yourself.
                </p>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function Capability({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <span>{children}</span>
    </li>
  );
}
