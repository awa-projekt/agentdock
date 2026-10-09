import { Loader2, TerminalSquare } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';
import { toErrorMessage } from '@/lib/format';

type Decision = 'approve' | 'deny';

type Outcome = { kind: 'approved' } | { kind: 'denied' } | { kind: 'error'; message: string };

export function DeviceAuthorizationView({
  initialUserCode,
  userEmail,
  onDone,
}: {
  initialUserCode: string | null;
  userEmail: string | null;
  onDone: () => void;
}) {
  const [userCode, setUserCode] = useState(initialUserCode ?? '');
  const [pending, setPending] = useState<Decision | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const code = userCode.trim();

  const decide = async (decision: Decision) => {
    if (!code || pending) return;
    setPending(decision);
    setOutcome(null);
    try {
      const result =
        decision === 'approve'
          ? await authClient.device.approve({ userCode: code })
          : await authClient.device.deny({ userCode: code });
      if (result.error) {
        setOutcome({ kind: 'error', message: result.error.error_description || 'The request could not be processed.' });
        return;
      }
      setOutcome({ kind: decision === 'approve' ? 'approved' : 'denied' });
    } catch (cause) {
      setOutcome({ kind: 'error', message: toErrorMessage(cause, 'The request could not be processed.') });
    } finally {
      setPending(null);
    }
  };

  const settled = outcome?.kind === 'approved' || outcome?.kind === 'denied';

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <TerminalSquare className="size-4" />
            Agentdock CLI
          </div>
          <CardTitle className="text-2xl tracking-tight">Authorize a device</CardTitle>
          <CardDescription>
            A command-line tool is asking to sign in{userEmail ? ` as ${userEmail}` : ' with your account'}. Confirm
            that the code below matches the one shown in your terminal before approving.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="device-user-code">Code</Label>
            <Input
              id="device-user-code"
              value={userCode}
              onChange={(event) => setUserCode(event.target.value.toUpperCase())}
              placeholder="ABCD-EFGH"
              autoComplete="off"
              spellCheck={false}
              disabled={settled || pending !== null}
              className="font-mono text-lg tracking-widest"
            />
          </div>

          {outcome?.kind === 'error' ? (
            <Alert variant="destructive">
              <AlertTitle>Could not complete the request</AlertTitle>
              <AlertDescription>{outcome.message}</AlertDescription>
            </Alert>
          ) : null}

          {outcome?.kind === 'approved' ? (
            <Alert>
              <AlertTitle>Device approved</AlertTitle>
              <AlertDescription>You can return to your terminal; the CLI is now signed in.</AlertDescription>
            </Alert>
          ) : null}

          {outcome?.kind === 'denied' ? (
            <Alert>
              <AlertTitle>Request denied</AlertTitle>
              <AlertDescription>The CLI was not signed in. You can close this page.</AlertDescription>
            </Alert>
          ) : null}

          {settled ? (
            <Button type="button" className="w-full" onClick={onDone}>
              Continue to Agentdock
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                disabled={!code || pending !== null}
                onClick={() => void decide('deny')}
              >
                {pending === 'deny' ? <Loader2 className="size-4 animate-spin" /> : 'Deny'}
              </Button>
              <Button
                type="button"
                className="flex-1"
                disabled={!code || pending !== null}
                onClick={() => void decide('approve')}
              >
                {pending === 'approve' ? <Loader2 className="size-4 animate-spin" /> : 'Approve'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
