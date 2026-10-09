import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogOut, Settings2, Sparkles, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import type { User } from '../lib/types';
import { useRuns } from '../lib/useRuns';
import { Composer } from './Composer';
import { EventDrawer } from './EventDrawer';
import { PostDetail } from './PostDetail';
import { PostList } from './PostList';
import { SettingsPanel } from './SettingsPanel';
import { Button } from './ui';

export const Studio = ({ user, workflowConfigured }: { user: User; workflowConfigured: boolean }) => {
  const queryClient = useQueryClient();
  const runs = useRuns();
  const [eventsOpen, setEventsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-indigo-600 text-white">
            <Sparkles className="size-4.5" />
          </span>
          <div>
            <h1 className="text-sm font-semibold leading-tight">Content Studio</h1>
            <p className="text-[11px] text-slate-500">human-in-the-loop publishing on AgentDock</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {!workflowConfigured && (
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200 hover:bg-amber-100"
            >
              <TriangleAlert className="size-3.5" />
              Configure workflow
            </button>
          )}
          <span className="text-sm text-slate-600">{user.name}</span>
          <Button variant="ghost" onClick={() => setSettingsOpen(true)} title="Dev settings">
            <Settings2 className="size-4" />
          </Button>
          <Button variant="ghost" onClick={() => logout.mutate()} title="Sign out">
            <LogOut className="size-4" />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col border-r border-slate-200 bg-white">
          <Composer runs={runs} disabled={!workflowConfigured} />
          <PostList runs={runs} />
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <PostDetail runs={runs} onOpenEvents={() => setEventsOpen(true)} />
        </main>
      </div>

      <EventDrawer
        open={eventsOpen}
        onClose={() => setEventsOpen(false)}
        events={runs.selectedId ? runs.eventsFor(runs.selectedId) : []}
        post={runs.selectedPost}
      />

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
};
