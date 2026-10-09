import { useQuery } from '@tanstack/react-query';
import { Login } from './components/Login';
import { Studio } from './components/Studio';
import { Spinner } from './components/ui';
import { api } from './lib/api';

export const App = () => {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });

  if (me.isLoading) {
    return (
      <div className="flex min-h-full items-center justify-center text-slate-400">
        <Spinner />
      </div>
    );
  }

  if (!me.data?.user) return <Login />;

  return <Studio user={me.data.user} workflowConfigured={me.data.workflowConfigured} />;
};
