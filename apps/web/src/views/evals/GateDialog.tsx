import {
  type EvalDatasetId,
  type EvalGate,
  type EvalGraderId,
  MAX_EVAL_CONCURRENCY,
  MAX_EVAL_TRIALS,
} from 'agentdock-sdk/schemas';
import { useMemo, useState } from 'react';
import { Field, Toggle } from '@/components/form';
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
  useCreateEvalGate,
  useEvalDataset,
  useEvalDatasets,
  useEvalGraders,
  useUpdateEvalGate,
} from '@/lib/queries';
import { cn } from '@/lib/utils';
import { GraderPicker } from '@/views/evals/GraderPicker';

const clampInt = (value: string, min: number, max: number, fallback: number): number => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

/**
 * Creates or edits a regression gate. The estimate is per change: a gate
 * spends a whole run each time the agent's instructions, model, reasoning
 * effort or skills change, so the dialog says what that costs up front.
 */
export function GateDialog({
  open,
  onOpenChange,
  gate,
  initialDatasetId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gate: EvalGate | null;
  initialDatasetId?: string | undefined;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {open ? <GateForm gate={gate} initialDatasetId={initialDatasetId} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function GateForm({
  gate,
  initialDatasetId,
  onClose,
}: {
  gate: EvalGate | null;
  initialDatasetId: string | undefined;
  onClose: () => void;
}) {
  const datasets = useEvalDatasets().data ?? [];
  const agents = useAgents().data ?? [];
  const graders = useEvalGraders().data ?? [];
  const createGate = useCreateEvalGate();
  const updateGate = useUpdateEvalGate();
  const initialDataset = datasets.find((dataset) => dataset.id === (gate?.datasetId ?? initialDatasetId));
  const [datasetId, setDatasetId] = useState<string>(gate?.datasetId ?? initialDatasetId ?? '');
  const [agentId, setAgentId] = useState(gate?.agentId ?? '');
  const [graderIds, setGraderIds] = useState<ReadonlyArray<EvalGraderId>>(
    gate?.graderIds ?? initialDataset?.graderIds ?? [],
  );
  const [tags, setTags] = useState<ReadonlyArray<string>>(gate?.tags ?? []);
  const [trials, setTrials] = useState(String(gate?.trials ?? 1));
  const [concurrency, setConcurrency] = useState(String(gate?.concurrency ?? 2));
  const [limit, setLimit] = useState(gate?.limit === undefined ? '' : String(gate.limit));
  const [enabled, setEnabled] = useState(gate?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const detail = useEvalDataset(datasetId || null).data;
  const pending = createGate.isPending || updateGate.isPending;

  const trialCount = clampInt(trials, 1, MAX_EVAL_TRIALS, 1);
  const limitCount = limit.trim() ? clampInt(limit, 1, Number.MAX_SAFE_INTEGER, 1) : undefined;
  const caseCount = useMemo(() => {
    const cases = (detail?.cases ?? []).filter(
      (evalCase) => tags.length === 0 || evalCase.tags.some((tag) => tags.includes(tag)),
    );
    return limitCount === undefined ? cases.length : Math.min(limitCount, cases.length);
  }, [detail, tags, limitCount]);
  const judges = graders.filter((grader) => graderIds.includes(grader.id) && grader.config.type === 'llm-judge');
  const agentCalls = caseCount * trialCount;

  const chooseDataset = (next: string) => {
    setDatasetId(next);
    setTags([]);
    setGraderIds(datasets.find((dataset) => dataset.id === next)?.graderIds ?? []);
  };

  const save = () => {
    const dataset = datasets.find((candidate) => candidate.id === datasetId);
    if (!dataset) return;
    setError(null);
    const input = {
      datasetId: dataset.id satisfies EvalDatasetId,
      agentId,
      graderIds: [...graderIds],
      tags: [...tags],
      trials: trialCount,
      concurrency: clampInt(concurrency, 1, MAX_EVAL_CONCURRENCY, 2),
      limit: limitCount,
      enabled,
    };
    const handlers = {
      onSuccess: onClose,
      onError: (cause: Error) => setError(toErrorMessage(cause, 'Could not save the gate.')),
    };
    if (gate) updateGate.mutate({ gateId: gate.id, input }, handlers);
    else createGate.mutate(input, handlers);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{gate ? 'Edit gate' : 'Guard an agent with a regression suite'}</DialogTitle>
        <DialogDescription>
          Whenever the agent's instructions, model, reasoning effort or skills change, the suite runs again and is
          compared with its previous run. Saving the gate does not run anything; use "Run now" for a first baseline.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Dataset" htmlFor="gate-dataset">
          <Select
            value={datasetId}
            items={datasets.map((dataset) => ({ value: dataset.id, label: dataset.name }))}
            onValueChange={chooseDataset}
          >
            <SelectTrigger id="gate-dataset" className="w-full">
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
        <Field label="Agent" htmlFor="gate-agent">
          <Select
            value={agentId}
            items={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
            onValueChange={setAgentId}
          >
            <SelectTrigger id="gate-agent" className="w-full">
              <SelectValue placeholder="Select an agent…" />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Only cases tagged"
          htmlFor="gate-tags"
          description="A small regression suite keeps each change cheap."
        >
          <div id="gate-tags" className="flex min-h-7 flex-wrap gap-1.5">
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
        <Field label="Limit" htmlFor="gate-limit" description="Run only the first N matching cases.">
          <Input
            id="gate-limit"
            type="number"
            min={1}
            placeholder="All"
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
          />
        </Field>
        <Field label="Trials per case" htmlFor="gate-trials">
          <Input
            id="gate-trials"
            type="number"
            min={1}
            max={MAX_EVAL_TRIALS}
            value={trials}
            onChange={(event) => setTrials(event.target.value)}
          />
        </Field>
        <Field label="Concurrency" htmlFor="gate-concurrency">
          <Input
            id="gate-concurrency"
            type="number"
            min={1}
            max={MAX_EVAL_CONCURRENCY}
            value={concurrency}
            onChange={(event) => setConcurrency(event.target.value)}
          />
        </Field>
      </div>

      <Field label="Graders" htmlFor="gate-graders" description="Pre-selected from the dataset's defaults.">
        <GraderPicker graders={graders} selected={graderIds} onChange={setGraderIds} />
      </Field>

      <Toggle
        label="Enabled"
        description="A disabled gate ignores agent changes until it is enabled again."
        checked={enabled}
        onChange={setEnabled}
      />

      <div
        className={cn(
          'rounded-lg border px-3 py-2 text-xs',
          agentCalls > 50 ? 'border-warning/40 bg-warning/10' : 'border-border bg-muted/40',
        )}
      >
        <span className="font-medium">
          Every change runs {caseCount} case{caseCount === 1 ? '' : 's'} × {trialCount} trial
          {trialCount === 1 ? '' : 's'} = {agentCalls} agent run{agentCalls === 1 ? '' : 's'}
        </span>
        {judges.length > 0 ? <span> plus {agentCalls * judges.length} judge calls</span> : null}.
        {agentCalls > 50 ? ' Narrow it with tags or a limit to keep iterating cheap.' : null}
      </div>
      {error ? <StatusMessage kind="error">{error}</StatusMessage> : null}

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save} disabled={pending || !datasetId || !agentId || caseCount === 0}>
          {pending ? 'Saving…' : 'Save gate'}
        </Button>
      </DialogFooter>
    </>
  );
}
