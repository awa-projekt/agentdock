import { Plus } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { DetailSkeleton, ListSkeleton } from '@/components/Loading';
import { MasterDetail } from '@/components/MasterDetail';
import { SelectableCard } from '@/components/SelectableCard';
import { ErrorBanner } from '@/components/StatusMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatCost, formatDateTime, toErrorMessage } from '@/lib/format';
import { useEvalRuns } from '@/lib/queries';
import {
  formatMetric,
  runCost,
  runStatusVariant,
  triggerLabel,
  verdictLabel,
  verdictVariant,
} from '@/views/evals/eval-format';
import { NewRunDialog } from '@/views/evals/NewRunDialog';
import { RunDetail } from '@/views/evals/RunDetail';

export function RunsTab({ runId, onSelectRun }: { runId: string | null; onSelectRun: (runId: string | null) => void }) {
  const runsQuery = useEvalRuns();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [creating, setCreating] = useState(false);
  const runs = runsQuery.data ?? [];
  const filtered = useMemo(() => {
    const search = deferredQuery.trim().toLowerCase();
    if (!search) return runs;
    return runs.filter((run) =>
      [run.name, run.dataset.name, run.target.name].join('\n').toLowerCase().includes(search),
    );
  }, [deferredQuery, runs]);
  const selected = runs.find((run) => run.id === runId) ?? filtered[0] ?? null;

  return (
    <>
      <MasterDetail
        masterWidth="380px"
        master={
          <>
            <div className="flex gap-2">
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search runs" />
              <Button onClick={() => setCreating(true)}>
                <Plus className="size-4" />
                New run
              </Button>
            </div>
            {runsQuery.isError ? (
              <ErrorBanner>{toErrorMessage(runsQuery.error, 'Could not load eval runs.')}</ErrorBanner>
            ) : runsQuery.isPending ? (
              <ListSkeleton compact />
            ) : filtered.length === 0 ? (
              <EmptyState
                title="No runs yet"
                description="Create a dataset and a grader, then run the dataset against an agent or workflow."
                action={<Button onClick={() => setCreating(true)}>New run</Button>}
              />
            ) : (
              <div className="space-y-2">
                {filtered.map((run) => {
                  const summary = run.summary;
                  const done = summary.completedTrials + summary.erroredTrials + summary.canceledTrials;
                  const cost = runCost(summary);
                  const trigger = triggerLabel(run.trigger);
                  return (
                    <SelectableCard key={run.id} active={selected?.id === run.id} onClick={() => onSelectRun(run.id)}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold">{run.name}</div>
                          <div className="mt-0.5 truncate text-xs text-muted-foreground">
                            {run.target.name} · {run.dataset.name}
                          </div>
                        </div>
                        <Badge variant={runStatusVariant(run.status)}>{run.status}</Badge>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                        <span className="font-medium">
                          {summary.passRate ? formatMetric(summary.passRate) : '—'}
                          <span className="ml-1 font-normal text-muted-foreground">pass rate</span>
                        </span>
                        <span className="text-[11px] text-muted-foreground">{formatDateTime(run.createdAt)}</span>
                      </div>
                      {trigger || run.baseline || cost !== undefined ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {cost === undefined ? null : <Badge variant="outline">{formatCost(cost)}</Badge>}
                          {trigger ? <Badge variant="secondary">{trigger}</Badge> : null}
                          {run.baseline ? (
                            <Badge variant={verdictVariant(run.baseline.verdict)}>{verdictLabel(run.baseline)}</Badge>
                          ) : null}
                        </div>
                      ) : null}
                      {run.status === 'running' ? (
                        <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full bg-primary transition-all"
                            style={{ width: `${(done / Math.max(summary.totalTrials, 1)) * 100}%` }}
                          />
                        </div>
                      ) : null}
                    </SelectableCard>
                  );
                })}
              </div>
            )}
          </>
        }
        detail={
          runsQuery.isPending ? (
            <DetailSkeleton />
          ) : selected ? (
            <RunDetail key={selected.id} runId={selected.id} runs={runs} onSelectRun={onSelectRun} />
          ) : (
            <EmptyState title="Select a run" description="Pick a run to see its scores, trials and transcripts." />
          )
        }
      />
      <NewRunDialog open={creating} onOpenChange={setCreating} initialDatasetId={null} onStarted={onSelectRun} />
    </>
  );
}
