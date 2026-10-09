import { type EvalGraderId, MAX_EVAL_CONCURRENCY, MAX_EVAL_TRIALS } from 'agentdock-sdk/schemas';
import { useMemo, useState } from 'react';
import { Field } from '@/components/form';
import { StatusMessage } from '@/components/StatusMessage';
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
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toErrorMessage } from '@/lib/format';
import {
  useAgents,
  useEvalDataset,
  useEvalDatasets,
  useEvalGraders,
  useStartEvalRun,
  useWorkflows,
} from '@/lib/queries';
import { cn } from '@/lib/utils';
import { GraderPicker } from '@/views/evals/GraderPicker';

type TargetKind = 'agent' | 'workflow';

const clampInt = (value: string, min: number, max: number, fallback: number): number => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

/**
 * Starts a run. The estimate shows how many target and judge calls it will
 * make before anything is spent; a small `limit` is the cheap way to check a
 * new grader or dataset first.
 */
export function NewRunDialog({
  open,
  onOpenChange,
  initialDatasetId,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialDatasetId: string | null;
  onStarted: (runId: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {open ? (
          <NewRunForm initialDatasetId={initialDatasetId} onClose={() => onOpenChange(false)} onStarted={onStarted} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function NewRunForm({
  initialDatasetId,
  onClose,
  onStarted,
}: {
  initialDatasetId: string | null;
  onClose: () => void;
  onStarted: (runId: string) => void;
}) {
  const datasets = useEvalDatasets().data ?? [];
  const graders = useEvalGraders().data ?? [];
  const agents = useAgents().data ?? [];
  const workflows = useWorkflows().data ?? [];
  const startRun = useStartEvalRun();
  const initialDataset = datasets.find((dataset) => dataset.id === initialDatasetId);
  const [datasetId, setDatasetId] = useState(initialDatasetId ?? '');
  const [graderIds, setGraderIds] = useState<ReadonlyArray<EvalGraderId>>(initialDataset?.graderIds ?? []);
  const [targetKind, setTargetKind] = useState<TargetKind>('agent');
  const [targetId, setTargetId] = useState('');
  const [trials, setTrials] = useState('1');
  const [concurrency, setConcurrency] = useState('2');
  const [tags, setTags] = useState<ReadonlyArray<string>>([]);
  const [limit, setLimit] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const detail = useEvalDataset(datasetId || null).data;

  const targets =
    targetKind === 'agent'
      ? agents.map((agent) => ({ id: agent.id, name: agent.name, model: agent.model }))
      : workflows.map((workflow) => ({ id: workflow.id, name: workflow.manifest.name, model: undefined }));
  const target = targets.find((candidate) => candidate.id === targetId);
  const trialCount = clampInt(trials, 1, MAX_EVAL_TRIALS, 1);
  const limitCount = limit.trim() ? clampInt(limit, 1, Number.MAX_SAFE_INTEGER, 1) : undefined;

  const caseCount = useMemo(() => {
    const cases = (detail?.cases ?? []).filter(
      (evalCase) => tags.length === 0 || evalCase.tags.some((tag) => tags.includes(tag)),
    );
    return limitCount === undefined ? cases.length : Math.min(limitCount, cases.length);
  }, [detail, tags, limitCount]);

  const selectedGraders = graders.filter((grader) => graderIds.includes(grader.id));
  const judges = selectedGraders.filter((grader) => grader.config.type === 'llm-judge');
  const sameModelJudges = judges.filter(
    (grader) =>
      grader.config.type === 'llm-judge' && target?.model !== undefined && grader.config.model === target.model,
  );
  const targetCalls = caseCount * trialCount;

  const chooseDataset = (next: string) => {
    setDatasetId(next);
    setTags([]);
    setGraderIds(datasets.find((dataset) => dataset.id === next)?.graderIds ?? []);
  };

  const submit = () => {
    const dataset = datasets.find((candidate) => candidate.id === datasetId);
    if (!dataset) return;
    setError(null);
    startRun.mutate(
      {
        name: name.trim() || undefined,
        datasetId: dataset.id,
        target: { kind: targetKind, id: targetId },
        graderIds: [...graderIds],
        trials: trialCount,
        concurrency: clampInt(concurrency, 1, MAX_EVAL_CONCURRENCY, 2),
        tags: tags.length > 0 ? [...tags] : undefined,
        limit: limitCount,
      },
      {
        onSuccess: (run) => {
          onClose();
          onStarted(run.id);
        },
        onError: (cause) => setError(toErrorMessage(cause, 'Could not start the run.')),
      },
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>New eval run</DialogTitle>
        <DialogDescription>
          Every selected case goes to the target once per trial, in a fresh conversation, and every grader scores the
          answer.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Dataset" htmlFor="run-dataset">
          <Select
            value={datasetId}
            items={datasets.map((dataset) => ({ value: dataset.id, label: dataset.name }))}
            onValueChange={chooseDataset}
          >
            <SelectTrigger id="run-dataset" className="w-full">
              <SelectValue placeholder="Select a dataset…" />
            </SelectTrigger>
            <SelectContent>
              {datasets.map((dataset) => (
                <SelectItem key={dataset.id} value={dataset.id}>
                  {dataset.name} ({dataset.caseCount})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Run name" htmlFor="run-name" description="Optional; defaults to target · dataset.">
          <Input id="run-name" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>

        <Field label="Target type" htmlFor="run-target-kind">
          <Select
            value={targetKind}
            items={{ agent: 'Agent', workflow: 'Workflow' }}
            onValueChange={(value) => {
              setTargetKind(value);
              setTargetId('');
            }}
          >
            <SelectTrigger id="run-target-kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="agent">Agent</SelectItem>
              <SelectItem value="workflow">Workflow</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Target" htmlFor="run-target">
          <Select
            value={targetId}
            items={targets.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
            onValueChange={setTargetId}
          >
            <SelectTrigger id="run-target" className="w-full">
              <SelectValue placeholder={`Select ${targetKind}…`} />
            </SelectTrigger>
            <SelectContent>
              {targets.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          label="Trials per case"
          htmlFor="run-trials"
          description="Several trials measure consistency: pass@k and pass^k."
        >
          <Input
            id="run-trials"
            type="number"
            min={1}
            max={MAX_EVAL_TRIALS}
            value={trials}
            onChange={(event) => setTrials(event.target.value)}
          />
        </Field>
        <Field label="Concurrency" htmlFor="run-concurrency" description="Trials in flight at once.">
          <Input
            id="run-concurrency"
            type="number"
            min={1}
            max={MAX_EVAL_CONCURRENCY}
            value={concurrency}
            onChange={(event) => setConcurrency(event.target.value)}
          />
        </Field>

        <Field label="Only cases tagged" htmlFor="run-tags" description="Any of these; none selected runs all cases.">
          <div id="run-tags" className="flex min-h-7 flex-wrap gap-1.5">
            {(detail?.dataset.tags ?? []).length === 0 ? (
              <span className="text-xs text-muted-foreground">No tags in this dataset.</span>
            ) : (
              detail?.dataset.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setTags(tags.includes(tag) ? tags.filter((entry) => entry !== tag) : [...tags, tag])}
                >
                  <Badge variant={tags.includes(tag) ? 'default' : 'outline'}>{tag}</Badge>
                </button>
              ))
            )}
          </div>
        </Field>
        <Field label="Limit" htmlFor="run-limit" description="Run only the first N matching cases.">
          <Input
            id="run-limit"
            type="number"
            min={1}
            placeholder="All"
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
          />
        </Field>
      </div>

      <Field label="Graders" htmlFor="run-graders" description="Pre-selected from the dataset's defaults.">
        <GraderPicker graders={graders} selected={graderIds} onChange={setGraderIds} />
      </Field>

      <div
        className={cn(
          'rounded-lg border px-3 py-2 text-xs',
          targetCalls > 100 ? 'border-warning/40 bg-warning/10' : 'border-border bg-muted/40',
        )}
      >
        <span className="font-medium">
          {caseCount} case{caseCount === 1 ? '' : 's'} × {trialCount} trial{trialCount === 1 ? '' : 's'} = {targetCalls}{' '}
          target call{targetCalls === 1 ? '' : 's'}
        </span>
        {judges.length > 0 ? (
          <span>
            {' '}
            plus {targetCalls * judges.length} judge call{targetCalls * judges.length === 1 ? '' : 's'}
          </span>
        ) : null}
        . Each call is billed by its provider.
        {targetCalls > 100 ? ' Consider a limit first to check the setup cheaply.' : null}
      </div>
      {sameModelJudges.length > 0 ? (
        <StatusMessage kind="info">
          {sameModelJudges.map((grader) => grader.name).join(', ')} uses the same model as the target. A model tends to
          favor its own answers; prefer a different judge model.
        </StatusMessage>
      ) : null}
      {error ? <StatusMessage kind="error">{error}</StatusMessage> : null}

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={startRun.isPending || !datasetId || !targetId || caseCount === 0}>
          {startRun.isPending ? 'Starting…' : 'Start run'}
        </Button>
      </DialogFooter>
    </>
  );
}
