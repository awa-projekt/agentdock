import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw, Settings2, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import type { Settings } from '../lib/types';
import { Button, Card, Spinner } from './ui';

const Form = ({ initial, onClose }: { initial: Settings; onClose: () => void }) => {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState(initial.agentdockUrl);
  const [workflowId, setWorkflowId] = useState(initial.workflowId);
  const [connectUrl, setConnectUrl] = useState(initial.agentdockUrl);

  const workflows = useQuery({
    queryKey: ['agentdock-workflows', connectUrl],
    queryFn: () => api.agentdockWorkflows(connectUrl),
    enabled: Boolean(connectUrl),
    retry: false,
  });

  const save = useMutation({
    mutationFn: () => api.updateSettings({ agentdockUrl: url, workflowId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['me'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      onClose();
    },
  });

  const options = workflows.data?.workflows ?? [];

  return (
    <div className="space-y-5 p-5">
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-500">AgentDock URL</label>
        <div className="flex gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://127.0.0.1:38123"
            className="w-full rounded-lg px-3 py-2 text-sm ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <Button variant="secondary" onClick={() => setConnectUrl(url.trim().replace(/\/$/, ''))}>
            <RefreshCw className="size-4" /> Load
          </Button>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-slate-500">Workflow</label>
        {workflows.isFetching ? (
          <p className="flex items-center gap-2 py-2 text-sm text-slate-500">
            <Loader2 className="size-4 animate-spin" /> Loading workflows…
          </p>
        ) : workflows.isError ? (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">
            {workflows.error.message}. You can still paste a workflow id below.
          </p>
        ) : options.length ? (
          <select
            value={workflowId}
            onChange={(e) => setWorkflowId(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-400"
          >
            <option value="">— select a workflow —</option>
            {options.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.id})
              </option>
            ))}
          </select>
        ) : (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">
            No workflows found at this AgentDock. Create one, then reload.
          </p>
        )}
        <input
          value={workflowId}
          onChange={(e) => setWorkflowId(e.target.value)}
          placeholder="…or paste a workflow id"
          className="mt-2 w-full rounded-lg px-3 py-2 font-mono text-xs ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-400"
        />
      </div>

      <p className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-500">
        Seeded from <code>AGENTDOCK_URL</code> / <code>WORKFLOW_ID</code>; changes here apply at runtime (until
        restart). <code>PORT</code>, <code>SESSION_SECRET</code> and the MCP server's <code>MCP_PORT</code> are still
        set at boot via env.
      </p>

      {save.isError && <p className="text-sm text-rose-600">{save.error.message}</p>}

      <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? <Spinner /> : null} Save
        </Button>
      </div>
    </div>
  );
};

export const SettingsPanel = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, enabled: open });
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center p-4 sm:items-center">
      <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} />
      <Card className="relative z-10 w-full max-w-lg">
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            <Settings2 className="size-4" /> Dev settings
          </h2>
          <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100">
            <X className="size-4" />
          </button>
        </header>
        {settings.data ? (
          <Form initial={settings.data} onClose={onClose} />
        ) : (
          <div className="flex justify-center p-10 text-slate-400">
            <Spinner />
          </div>
        )}
      </Card>
    </div>
  );
};
