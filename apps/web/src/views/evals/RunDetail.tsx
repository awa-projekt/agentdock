import { compareEvalRuns, sumEvalUsage } from 'agentdock-sdk/evals';
import type { EvalGraderId, EvalRun, EvalTrial } from 'agentdock-sdk/schemas';
import { Ban, GitCompareArrows, RefreshCw, Trash2 } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { ConfirmButton } from '@/components/ConfirmButton';
import { DetailSkeleton } from '@/components/Loading';
import { ErrorBanner, StatusMessage } from '@/components/StatusMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { compactText, formatCost, formatDateTime, formatDuration, toErrorMessage } from '@/lib/format';
import { useCancelEvalRun, useEvalGraders, useEvalRun, useRegradeEvalRun, useRemoveEvalRun } from '@/lib/queries';
import { cn } from '@/lib/utils';
import {
  formatMetric,
  formatPercent,
  GRADER_TYPE_LABELS,
  runCost,
  runStatusVariant,
  runWarnings,
  trialStatusLabel,
  trialStatusVariant,
  triggerLabel,
  verdictLabel,
  verdictVariant,
} from '@/views/evals/eval-format';
import { GraderPicker } from '@/views/evals/GraderPicker';
import { TrialDialog } from '@/views/evals/TrialDialog';
import { PHASE_LABELS, type UsageRow, UsageTable } from '@/views/evals/UsageTable';

type TrialFilter = 'all' | 'failed' | 'errored' | 'unscored' | 'unreviewed';

const trialFilters = {
  all: () => true,
  failed: (trial) => trial.status === 'completed' && trial.passed === false,
  errored: (trial) => trial.status === 'errored',
  unscored: (trial) => trial.grades.some((grade) => grade.score === undefined),
  unreviewed: (trial) => trial.status === 'completed' && trial.review === undefined,
} satisfies Record<TrialFilter, (trial: EvalTrial) => boolean>;

function Metric({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function RunDetail({
  runId,
  runs,
  onSelectRun,
}: {
  runId: string;
  runs: ReadonlyArray<EvalRun>;
  onSelectRun: (runId: string | null) => void;
}) {
  const detailQuery = useEvalRun(runId);
  const cancelRun = useCancelEvalRun();
  const removeRun = useRemoveEvalRun();
  const [filter, setFilter] = useState<TrialFilter>('all');
  const [openTrialId, setOpenTrialId] = useState<string | null>(null);
  // Null follows the run's own baseline (the previous run of its dataset and target); '' compares with nothing.
  const [baselineChoice, setBaselineChoice] = useState<string | null>(null);
  const [spendView, setSpendView] = useState<'phase' | 'model'>('phase');
  const [regrading, setRegrading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const baselineId = baselineChoice ?? detailQuery.data?.run.baseline?.runId ?? '';
  const baselineQuery = useEvalRun(baselineId || null);

  const trials = detailQuery.data?.trials ?? [];
  const visibleTrials = useMemo(() => trials.filter(trialFilters[filter]), [trials, filter]);
  const comparison = useMemo(
    () => (baselineQuery.data ? compareEvalRuns(baselineQuery.data.trials, trials) : null),
    [baselineQuery.data, trials],
  );

  if (detailQuery.isPending) return <DetailSkeleton />;
  if (detailQuery.isError) {
    return <ErrorBanner>{toErrorMessage(detailQuery.error, 'Could not load the run.')}</ErrorBanner>;
  }

  const { run } = detailQuery.data;
  const summary = run.summary;
  const warnings = runWarnings(run, trials);
  const judgeRow: ReadonlyArray<UsageRow> = summary.judgeUsage
    ? [{ key: 'judges', label: 'LLM judges', usage: summary.judgeUsage }]
    : [];
  const spend: ReadonlyArray<UsageRow> = [
    ...(summary.targetUsage?.phases ?? []).map((entry) => ({
      key: entry.phase,
      label: PHASE_LABELS[entry.phase],
      usage: entry.usage,
    })),
    ...judgeRow,
  ];
  const spendByModel: ReadonlyArray<UsageRow> = [
    ...(summary.targetUsage?.models ?? []).map((entry) => ({
      key: entry.model,
      label: entry.model,
      usage: entry.usage,
    })),
    ...judgeRow,
  ];
  const totalCost = runCost(summary);
  const comparable = runs.filter((candidate) => candidate.id !== run.id && candidate.dataset.id === run.dataset.id);
  const openIndex = visibleTrials.findIndex((trial) => trial.id === openTrialId);

  const fail = (fallback: string) => (cause: Error) => setError(toErrorMessage(cause, fallback));

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={runStatusVariant(run.status)}>{run.status}</Badge>
            <Badge variant="outline">{run.target.kind}</Badge>
            {triggerLabel(run.trigger) ? <Badge variant="secondary">{triggerLabel(run.trigger)}</Badge> : null}
            {run.baseline ? (
              <Badge variant={verdictVariant(run.baseline.verdict)}>{verdictLabel(run.baseline)}</Badge>
            ) : null}
            {run.sourceRunId ? (
              <button type="button" onClick={() => onSelectRun(run.sourceRunId ?? null)}>
                <Badge variant="secondary">
                  re-grade of {runs.find((r) => r.id === run.sourceRunId)?.name ?? 'a run'}
                </Badge>
              </button>
            ) : null}
          </div>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">{run.name}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {run.target.name}
            {run.target.model ? ` (${run.target.model})` : ''}
            {run.target.revision === undefined ? '' : `, revision ${run.target.revision}`} on {run.dataset.name} ·{' '}
            {run.trials} trial
            {run.trials === 1 ? '' : 's'} per case · started {formatDateTime(run.createdAt)}
            {run.completedAt ? ` · finished ${formatDateTime(run.completedAt)}` : ''}
          </p>
          {run.error ? <p className="mt-1 text-xs text-destructive">{run.error}</p> : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {run.status === 'running' ? (
            <Button
              variant="outline"
              disabled={cancelRun.isPending}
              onClick={() => cancelRun.mutate(run.id, { onError: fail('Could not cancel the run.') })}
            >
              <Ban className="size-4" />
              Cancel
            </Button>
          ) : (
            <Button variant="outline" onClick={() => setRegrading(true)} disabled={summary.completedTrials === 0}>
              <RefreshCw className="size-4" />
              Re-grade
            </Button>
          )}
          <ConfirmButton
            variant="destructiveGhost"
            size="icon"
            title="Delete run"
            description={`Delete "${run.name}" and all of its trials? Its agent run transcripts are kept.`}
            confirmLabel="Delete"
            disabled={removeRun.isPending}
            onConfirm={() =>
              removeRun.mutate(run.id, {
                onSuccess: () => onSelectRun(null),
                onError: fail('Could not delete the run.'),
              })
            }
          >
            <Trash2 className="size-4" />
          </ConfirmButton>
        </div>
      </div>

      {error ? <StatusMessage kind="error">{error}</StatusMessage> : null}
      {warnings.length > 0 ? (
        <div className="space-y-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs">
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-3 @5xl:grid-cols-5">
        <Metric
          label="Pass rate"
          value={summary.passRate ? formatMetric(summary.passRate) : '—'}
          hint={
            summary.passRate
              ? `95% CI ${formatPercent(summary.passRate.low)}–${formatPercent(summary.passRate.high)}, ${summary.passRate.n} cases`
              : 'Every grader must pass'
          }
        />
        {run.trials > 1 ? (
          <Metric
            label="pass@k / pass^k"
            value={
              summary.passAtK === undefined || summary.passAllK === undefined
                ? '—'
                : `${formatPercent(summary.passAtK)} / ${formatPercent(summary.passAllK)}`
            }
            hint={`Some / every one of ${run.trials} trials passed`}
          />
        ) : null}
        <Metric
          label="Trials"
          value={`${summary.completedTrials}/${summary.totalTrials}`}
          hint={[
            summary.erroredTrials > 0 ? `${summary.erroredTrials} errored` : '',
            summary.pendingTrials > 0 ? `${summary.pendingTrials} pending` : '',
            summary.canceledTrials > 0 ? `${summary.canceledTrials} canceled` : '',
            `${summary.reviewedTrials} reviewed`,
          ]
            .filter(Boolean)
            .join(' · ')}
        />
        <Metric
          label="Mean latency"
          value={summary.meanDurationMs === undefined ? '—' : formatDuration(summary.meanDurationMs)}
          hint="Per completed trial"
        />
        <Metric
          label="Cost"
          value={totalCost === undefined ? (spend.length === 0 ? '—' : 'unpriced') : formatCost(totalCost)}
          hint={[
            summary.meanTrialCost === undefined ? '' : `${formatCost(summary.meanTrialCost)} per trial`,
            summary.judgeUsage?.cost === undefined ? '' : `judges ${formatCost(summary.judgeUsage.cost.total)}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        />
      </div>

      {summary.graders.length > 0 ? (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Grader</TableHead>
                <TableHead>Pass rate</TableHead>
                <TableHead>Mean score</TableHead>
                <TableHead title="Grader errors and UNKNOWN verdicts">Unscored</TableHead>
                <TableHead title="Share of human-reviewed trials where the grader agreed with the reviewer">
                  Human agreement
                </TableHead>
                <TableHead>Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.graders.map((grader) => (
                <TableRow key={grader.graderId}>
                  <TableCell>
                    <div className="text-xs font-medium">{grader.graderName}</div>
                    <div className="text-[11px] text-muted-foreground">{GRADER_TYPE_LABELS[grader.graderType]}</div>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {grader.passRate ? formatMetric(grader.passRate) : '—'}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {grader.meanScore ? grader.meanScore.mean.toFixed(2) : '—'}
                  </TableCell>
                  <TableCell className={cn('tabular-nums', grader.unscored > 0 && 'text-warning')}>
                    {grader.unscored}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {grader.agreement.total === 0
                      ? '—'
                      : `${formatPercent(grader.agreement.agreed / grader.agreement.total)} (${grader.agreement.agreed}/${grader.agreement.total})`}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {grader.usage?.cost === undefined ? '—' : formatCost(grader.usage.cost.total)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {spend.length > 0 ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Spend</h3>
            <Tabs value={spendView} onValueChange={setSpendView}>
              <TabsList>
                <TabsTrigger value="phase">By loop phase</TabsTrigger>
                <TabsTrigger value="model">By model</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <UsageTable
            rows={spendView === 'phase' ? spend : spendByModel}
            total={sumEvalUsage(spend.map((row) => row.usage))}
          />
        </div>
      ) : null}

      <div className="rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <GitCompareArrows className="size-4 text-muted-foreground" />
          <span className="text-xs font-medium">Compare with</span>
          <Select
            value={baselineId}
            items={comparable.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
            onValueChange={setBaselineChoice}
          >
            <SelectTrigger className="min-w-56">
              <SelectValue
                placeholder={comparable.length === 0 ? 'No other run of this dataset' : 'Pick a baseline run…'}
              />
            </SelectTrigger>
            <SelectContent>
              {comparable.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.name} · {formatDateTime(candidate.createdAt)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {baselineId ? (
            <Button variant="ghost" size="sm" onClick={() => setBaselineChoice('')}>
              Clear
            </Button>
          ) : null}
          {run.baseline && baselineId === run.baseline.runId ? (
            <span className="text-[11px] text-muted-foreground">
              the previous run of this dataset and target
              {run.baseline.sameGraders ? '' : '; graded by other graders, so pass rates can differ for that reason'}
            </span>
          ) : null}
        </div>
        {comparison ? <ComparisonView comparison={comparison} /> : null}
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Trials</h3>
          <Tabs value={filter} onValueChange={setFilter}>
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="failed">Failed</TabsTrigger>
              <TabsTrigger value="errored">Errored</TabsTrigger>
              <TabsTrigger value="unscored">Unscored</TabsTrigger>
              <TabsTrigger value="unreviewed">Not reviewed</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Case</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Grades</TableHead>
                <TableHead>Review</TableHead>
                <TableHead className="text-right">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleTrials.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-xs text-muted-foreground">
                    No trials match this filter.
                  </TableCell>
                </TableRow>
              ) : (
                visibleTrials.map((trial) => (
                  <TableRow key={trial.id} className="cursor-pointer" onClick={() => setOpenTrialId(trial.id)}>
                    <TableCell className="max-w-72">
                      <div className="truncate text-xs">{compactText(trial.case.input, 90)}</div>
                      {run.trials > 1 ? (
                        <div className="text-[11px] text-muted-foreground">trial {trial.index + 1}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant={trialStatusVariant(trial)}>{trialStatusLabel(trial)}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {trial.grades.map((grade) => (
                          <Badge
                            key={grade.graderId}
                            variant={grade.score === undefined ? 'warning' : grade.passed ? 'success' : 'destructive'}
                            title={grade.error ?? grade.reasoning ?? ''}
                          >
                            {grade.graderName}
                            {grade.label ? `: ${grade.label}` : ''}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      {trial.review ? (
                        <Badge variant={trial.review.passed ? 'success' : 'destructive'}>
                          {trial.review.passed ? 'pass' : 'fail'}
                        </Badge>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-[11px] tabular-nums text-muted-foreground">
                      {trial.output ? formatDuration(trial.output.durationMs) : ''}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <TrialDialog
        run={run}
        trial={openIndex === -1 ? null : (visibleTrials[openIndex] ?? null)}
        onClose={() => setOpenTrialId(null)}
        onPrevious={openIndex > 0 ? () => setOpenTrialId(visibleTrials[openIndex - 1]?.id ?? null) : undefined}
        onNext={
          openIndex !== -1 && openIndex < visibleTrials.length - 1
            ? () => setOpenTrialId(visibleTrials[openIndex + 1]?.id ?? null)
            : undefined
        }
      />
      <RegradeDialog
        run={run}
        open={regrading}
        onOpenChange={setRegrading}
        onStarted={(nextRunId) => onSelectRun(nextRunId)}
      />
    </div>
  );
}

const relativeChange = (before: number, after: number): string =>
  before === 0 ? '' : ` (${after >= before ? '+' : ''}${(((after - before) / before) * 100).toFixed(0)}%)`;

function ComparisonView({ comparison }: { comparison: ReturnType<typeof compareEvalRuns> }) {
  const difference = comparison.difference;
  const signed = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}`;
  const significant = comparison.pairedCases >= 2 && (difference.low > 0 || difference.high < 0);
  return (
    <div className="mt-3 space-y-3">
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Metric
          label="Difference"
          value={`${signed(difference.mean)} pts`}
          hint={`± ${(difference.standardError * 100).toFixed(1)} SE, 95% CI ${signed(difference.low)} to ${signed(difference.high)}`}
        />
        <Metric
          label="Baseline → this run"
          value={`${formatPercent(comparison.baselinePassRate)} → ${formatPercent(comparison.candidatePassRate)}`}
          hint={`${comparison.pairedCases} paired cases`}
        />
        <Metric
          label="Correlation"
          value={comparison.correlation === undefined ? '—' : comparison.correlation.toFixed(2)}
          hint="How much case difficulty carried over"
        />
        <Metric
          label="Verdict"
          value={significant ? (difference.mean > 0 ? 'Better' : 'Worse') : 'No clear change'}
          hint={significant ? 'The 95% interval excludes zero' : 'The 95% interval includes zero'}
        />
      </div>
      {comparison.baselineMeanCost !== undefined || comparison.baselineMeanDurationMs !== undefined ? (
        <p className="text-xs text-muted-foreground">
          {comparison.baselineMeanCost !== undefined && comparison.candidateMeanCost !== undefined
            ? `Cost per trial ${formatCost(comparison.baselineMeanCost)} → ${formatCost(comparison.candidateMeanCost)}${relativeChange(comparison.baselineMeanCost, comparison.candidateMeanCost)}`
            : ''}
          {comparison.baselineMeanDurationMs !== undefined && comparison.candidateMeanDurationMs !== undefined
            ? `${comparison.baselineMeanCost !== undefined ? ' · ' : ''}latency ${formatDuration(comparison.baselineMeanDurationMs)} → ${formatDuration(comparison.candidateMeanDurationMs)}${relativeChange(comparison.baselineMeanDurationMs, comparison.candidateMeanDurationMs)}`
            : ''}
        </p>
      ) : null}
      {comparison.regressions.length > 0 || comparison.improvements.length > 0 ? (
        <div className="grid gap-3 @3xl:grid-cols-2">
          <CaseList title="Regressions" entries={comparison.regressions} tone="destructive" />
          <CaseList title="Improvements" entries={comparison.improvements} tone="success" />
        </div>
      ) : null}
    </div>
  );
}

function CaseList({
  title,
  entries,
  tone,
}: {
  title: string;
  entries: ReturnType<typeof compareEvalRuns>['regressions'];
  tone: 'destructive' | 'success';
}) {
  return (
    <div className="rounded-md border border-border p-2.5">
      <div className="mb-1.5 text-xs font-medium">
        {title} ({entries.length})
      </div>
      <ul className="max-h-48 space-y-1 overflow-y-auto">
        {entries.map((entry) => (
          <li key={entry.caseId} className="flex items-center justify-between gap-2 text-[11px]">
            <span className="truncate">{compactText(entry.input, 80)}</span>
            <Badge variant={tone}>
              {formatPercent(entry.baseline)} → {formatPercent(entry.candidate)}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RegradeDialog({
  run,
  open,
  onOpenChange,
  onStarted,
}: {
  run: EvalRun;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (runId: string) => void;
}) {
  const graders = useEvalGraders().data ?? [];
  const regrade = useRegradeEvalRun();
  const [graderIds, setGraderIds] = useState<ReadonlyArray<EvalGraderId>>(() =>
    run.graders.map((grader) => grader.id).filter((id) => graders.some((grader) => grader.id === id)),
  );
  const [error, setError] = useState<string | null>(null);
  const judges = graders.filter((grader) => graderIds.includes(grader.id) && grader.config.type === 'llm-judge');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Re-grade this run</DialogTitle>
          <DialogDescription>
            Grades the {run.summary.completedTrials} completed outputs again with the graders' current definitions, as a
            new run. The target is not called again; human reviews carry over.
          </DialogDescription>
        </DialogHeader>
        <GraderPicker graders={graders} selected={graderIds} onChange={setGraderIds} />
        {judges.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {run.summary.completedTrials * judges.length} judge call
            {run.summary.completedTrials * judges.length === 1 ? '' : 's'}.
          </p>
        ) : null}
        {error ? <StatusMessage kind="error">{error}</StatusMessage> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={regrade.isPending || graderIds.length === 0}
            onClick={() =>
              regrade.mutate(
                { runId: run.id, input: { graderIds: [...graderIds] } },
                {
                  onSuccess: (next) => {
                    onOpenChange(false);
                    onStarted(next.id);
                  },
                  onError: (cause) => setError(toErrorMessage(cause, 'Could not re-grade the run.')),
                },
              )
            }
          >
            {regrade.isPending ? 'Starting…' : 'Re-grade'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
