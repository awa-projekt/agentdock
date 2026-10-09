import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { Button, Card } from './ui';

export const Login = () => {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('editor@example.com');
  const [password, setPassword] = useState('demo123');

  const login = useMutation({
    mutationFn: () => api.login(email, password),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-sm p-8">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-indigo-600 text-white">
            <Sparkles className="size-5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Content Studio</h1>
            <p className="text-xs text-slate-500">an AgentDock example</p>
          </div>
        </div>

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            login.mutate();
          }}
        >
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-600">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg px-3 py-2 ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-600">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg px-3 py-2 ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </label>

          {login.isError && <p className="text-sm text-rose-600">{login.error.message}</p>}

          <Button type="submit" className="w-full" disabled={login.isPending}>
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-5 rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-500">
          Demo users: <code className="text-slate-700">editor@example.com</code> /{' '}
          <code className="text-slate-700">writer@example.com</code> — password{' '}
          <code className="text-slate-700">demo123</code>.
        </p>
      </Card>
    </div>
  );
};
