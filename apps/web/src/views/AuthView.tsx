import { type FormEvent, useState } from 'react';
import { Field } from '@/components/form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiOrigin } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { toErrorMessage } from '@/lib/format';

type AuthMode = 'sign-in' | 'sign-up';

const authErrorMessage = (cause: unknown): string => {
  const message = toErrorMessage(cause, 'Authentication failed.');
  return message === 'Failed to fetch'
    ? `Could not reach the Agentdock API at ${apiOrigin}. Make sure the API server is running with bun run api.`
    : message;
};

export function AuthView({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [mode, setMode] = useState<AuthMode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title = mode === 'sign-in' ? 'Sign in' : 'Create account';

  const setAuthMode = (value: AuthMode) => {
    setMode(value);
    setError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const result =
        mode === 'sign-in'
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({ name: email, email, password });

      if (result.error) {
        setError(result.error.message || 'Authentication failed.');
        return;
      }

      onAuthenticated();
    } catch (cause) {
      setError(authErrorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="text-sm font-medium text-muted-foreground">Agentdock</div>
          <CardTitle className="text-2xl tracking-tight">{title}</CardTitle>
          <CardDescription>The first account becomes admin. Later accounts are regular users.</CardDescription>
        </CardHeader>

        <CardContent>
          <Tabs value={mode} onValueChange={setAuthMode} className="gap-5">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="sign-in">Sign in</TabsTrigger>
              <TabsTrigger value="sign-up">Sign up</TabsTrigger>
            </TabsList>

            <form onSubmit={submit} className="space-y-4">
              <Field label="Email" htmlFor="auth-email">
                <Input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  required
                />
              </Field>
              <Field label="Password" htmlFor="auth-password">
                <Input
                  id="auth-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={8}
                  required
                />
              </Field>
              {error ? (
                <Alert variant="destructive">
                  <AlertTitle>{mode === 'sign-in' ? 'Sign in failed' : 'Sign up failed'}</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              <Button type="submit" disabled={pending} className="w-full">
                {pending ? 'Please wait...' : title}
              </Button>
            </form>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
