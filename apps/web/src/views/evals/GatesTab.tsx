import type { EvalGate, EvalGateInput } from 'agentdock-sdk/schemas';
import { Pencil, Play, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConfirmButton } from '@/components/ConfirmButton';
import { EmptyState } from '@/components/EmptyState';
import { ListSkeleton } from '@/components/Loading';
import { ErrorBanner, StatusMessage } from '@/components/StatusMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatCost, formatDateTime, toErrorMessage } from '@/lib/format';
import { useEvalGates, useEvalRuns, useRemoveEvalGate, useRunEvalGate, useUpdateEvalGate } from '@/lib/queries';
import { formatMetric, runCost, runStatusVariant, verdictLabel, verdictVariant } from '@/views/evals/eval-format';
import { GateDialog } from '@/views/evals/GateDialog';

const inputOf = (gate: EvalGate): EvalGateInput => ({
  datasetId: gate.datasetId,
  agentId: gate.agentId,
  graderIds: gate.graderIds,
  tags: gate.tags,
  trials: gate.trials,
  concurrency: gate.concurrency,
  limit: gate.limit,
  enabled: gate.enabled,
});

/**
 * Regression gates: each reruns a dataset whenever its agent's instructions,
 * model, reasoning effort or skills change, so a prompt edit is measured
 * against the previous run instead of eyeballed.
 */
export function GatesTab({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
  const gatesQuery = useEvalGates();
  const runs = useEvalRuns().data ?? [];
  const updateGate = useUpdateEvalGate();
  const removeGate = useRemoveEvalGate();
  const runGate = useRunEvalGate();
  const [editing, setEditing] = useState<EvalGate | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gates = gatesQuery.data ?? [];
  const fail = (fallback: string) => (cause: Error) => setError(toErrorMessage(cause, fallback));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-3xl text-xs text-muted-foreground">
          A gate reruns a dataset against an agent whenever the agent's instructions, model, reasoning effort or skills
          change, and compares the result with the previous run. Keep gated suites small: every change spends a run.
        </p>
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          New gate
        </Button>
      </div>
      {error ? <StatusMessage kind="error">{error}</StatusMessage> : null}

      {gatesQuery.isError ? (
        <ErrorBanner>{toErrorMessage(gatesQuery.error, 'Could not load gates.')}</ErrorBanner>
      ) : gatesQuery.isPending ? (
        <ListSkeleton />
      ) : gates.length === 0 ? (
        <EmptyState
          title="No gates yet"
          description="Guard an agent with a regression dataset, and every change to its prompt or model gets measured."
          action={<Button onClick={() => setCreating(true)}>New gate</Button>}
        />
      ) : (
        <ul className="space-y-3">
          {gates.map((gate) => {
            const lastRun = runs.find((run) => run.id === gate.lastRunId);
            const cost = lastRun ? runCost(lastRun.summary) : undefined;
            return (
              <li key={gate.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                      <ShieldCheck className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold">
                          {gate.datasetName ?? 'Deleted dataset'} → {gate.agentName ?? 'Deleted agent'}
                        </span>
                        <Badge variant={gate.enabled ? 'success' : 'outline'}>{gate.enabled ? 'on' : 'off'}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {gate.tags.length > 0 ? `Cases tagged ${gate.tags.join(', ')}` : 'All cases'}
                        {gate.limit === undefined ? '' : `, first ${gate.limit}`} · {gate.trials} trial
                        {gate.trials === 1 ? '' : 's'} · {gate.graderIds.length} grader
                        {gate.graderIds.length === 1 ? '' : 's'}
                      </p>
                      {gate.lastError ? <p className="mt-1 text-xs text-destructive">{gate.lastError}</p> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="outline"
                      disabled={updateGate.isPending}
                      onClick={() =>
                        updateGate.mutate(
                          { gateId: gate.id, input: { ...inputOf(gate), enabled: !gate.enabled } },
                          { onError: fail('Could not update the gate.') },
                        )
                      }
                    >
                      {gate.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <ConfirmButton
                      variant="outline"
                      title="Run the suite now"
                      description="Runs the gate's cases against the agent now, spending a full run's model calls. The result is the baseline the next change is compared with."
                      confirmLabel="Run"
                      disabled={runGate.isPending}
                      onConfirm={() =>
                        runGate.mutate(gate.id, {
                          onSuccess: (run) => onOpenRun(run.id),
                          onError: fail('Could not run the gate.'),
                        })
                      }
                    >
                      <Play className="size-4" />
                      Run now
                    </ConfirmButton>
                    <Button variant="ghost" size="icon" aria-label="Edit gate" onClick={() => setEditing(gate)}>
                      <Pencil className="size-4" />
                    </Button>
                    <ConfirmButton
                      variant="destructiveGhost"
                      size="icon"
                      title="Delete gate"
                      description="The agent is no longer measured on change. Past runs stay."
                      confirmLabel="Delete"
                      disabled={removeGate.isPending}
                      onConfirm={() => removeGate.mutate(gate.id, { onError: fail('Could not delete the gate.') })}
                    >
                      <Trash2 className="size-4" />
                    </ConfirmButton>
                  </div>
                </div>
                {lastRun ? (
                  <button
                    type="button"
                    onClick={() => onOpenRun(lastRun.id)}
                    className="mt-3 flex w-full flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-left text-xs hover:bg-muted/40"
                  >
                    <span className="font-medium">Last run</span>
                    <Badge variant={runStatusVariant(lastRun.status)}>{lastRun.status}</Badge>
                    <span>{lastRun.summary.passRate ? formatMetric(lastRun.summary.passRate) : '—'} pass rate</span>
                    {lastRun.baseline ? (
                      <Badge variant={verdictVariant(lastRun.baseline.verdict)}>{verdictLabel(lastRun.baseline)}</Badge>
                    ) : (
                      <span className="text-muted-foreground">first run, nothing to compare with</span>
                    )}
                    {cost === undefined ? null : <span className="text-muted-foreground">{formatCost(cost)}</span>}
                    <span className="ml-auto text-muted-foreground">{formatDateTime(lastRun.createdAt)}</span>
                  </button>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Not run yet. The next change to the agent runs it; "Run now" records a baseline first.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <GateDialog open={creating} onOpenChange={setCreating} gate={null} />
      <GateDialog
        open={editing !== null}
        onOpenChange={(open) => (open ? undefined : setEditing(null))}
        gate={editing}
      />
    </div>
  );
}
