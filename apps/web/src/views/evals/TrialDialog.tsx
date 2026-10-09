import type { AgentRunRecord, EvalRun, EvalTrial } from 'agentdock-sdk/schemas';
import { jsonString } from 'agentdock-sdk/schemas';
import { Check, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { JsonView } from '@/components/json-view';
import { Markdown } from '@/components/markdown';
import { StatusMessage } from '@/components/StatusMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { compactText, formatDateTime, formatDuration, toErrorMessage } from '@/lib/format';
import { useAgentRun, useSetEvalReview } from '@/lib/queries';
import { trialStatusLabel, trialStatusVariant } from '@/views/evals/eval-format';
import { GradeCard } from '@/views/evals/GradeCard';
import { PHASE_LABELS, UsageTable } from '@/views/evals/UsageTable';

function Block({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      {children}
    </section>
  );
}

/**
 * One trial, in full: what was asked, what came back, how it got there, and
 * what each grader made of it. Anthropic's advice is to read transcripts
 * before trusting a score, and to label trials so judges can be checked
 * against people; both happen here, with previous/next to work through a
 * filtered list.
 */
export function TrialDialog({
  run,
  trial,
  onClose,
  onPrevious,
  onNext,
}: {
  run: EvalRun;
  trial: EvalTrial | null;
  onClose: () => void;
  onPrevious: (() => void) | undefined;
  onNext: (() => void) | undefined;
}) {
  return (
    <Dialog open={trial !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        {trial ? <TrialBody key={trial.id} run={run} trial={trial} onPrevious={onPrevious} onNext={onNext} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function TrialBody({
  run,
  trial,
  onPrevious,
  onNext,
}: {
  run: EvalRun;
  trial: EvalTrial;
  onPrevious: (() => void) | undefined;
  onNext: (() => void) | undefined;
}) {
  const output = trial.output;
  return (
    <div className="space-y-4 text-sm">
      <DialogHeader>
        <div className="flex items-center justify-between gap-2 pr-8">
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <Badge variant={trialStatusVariant(trial)}>{trialStatusLabel(trial)}</Badge>
            <span className="truncate">{compactText(trial.case.input, 70)}</span>
            {run.trials > 1 ? (
              <span className="shrink-0 font-normal text-muted-foreground">
                trial {trial.index + 1} of {run.trials}
              </span>
            ) : null}
          </DialogTitle>
          <div className="flex gap-1">
            <Button variant="outline" size="icon-sm" disabled={!onPrevious} onClick={onPrevious} aria-label="Previous">
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="icon-sm" disabled={!onNext} onClick={onNext} aria-label="Next">
              <ChevronRight />
            </Button>
          </div>
        </div>
      </DialogHeader>

      <div className="grid gap-4 md:grid-cols-2">
        <Block title="Input">
          <p className="whitespace-pre-wrap rounded-md bg-muted/40 p-2.5 text-xs leading-relaxed">{trial.case.input}</p>
        </Block>
        <Block title="Reference answer">
          {trial.case.expected ? (
            <p className="whitespace-pre-wrap rounded-md bg-muted/40 p-2.5 text-xs leading-relaxed">
              {trial.case.expected}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">None</p>
          )}
        </Block>
      </div>
      {trial.case.metadata || trial.case.tags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {trial.case.tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
          {trial.case.metadata ? <JsonView value={trial.case.metadata} label="metadata" /> : null}
        </div>
      ) : null}

      {trial.error ? <StatusMessage kind="error">{trial.error}</StatusMessage> : null}

      {output ? (
        <Block title={`Output · ${output.state} · ${formatDuration(output.durationMs)}`}>
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
            {output.text ? (
              <Markdown className="text-sm leading-relaxed">{output.text}</Markdown>
            ) : output.structured ? (
              <JsonView value={output.structured} label="structured output" defaultOpen />
            ) : (
              <p className="text-xs text-muted-foreground">No text output.</p>
            )}
          </div>
        </Block>
      ) : null}

      {output && output.toolCalls.length > 0 ? (
        <Block title={`Tool calls (${output.toolCalls.length})`}>
          <ol className="space-y-2">
            {output.toolCalls.map((call, index) => (
              <li key={call.toolCallId ?? index} className="rounded-md border border-border p-2.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-muted-foreground">{index + 1}.</span>
                  <span className="font-mono text-xs font-semibold">{call.toolName}</span>
                  {call.error ? <Badge variant="destructive">error</Badge> : null}
                </div>
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  {call.input !== undefined ? <JsonView value={call.input} label="input" /> : null}
                  {call.output !== undefined ? <JsonView value={call.output} label="output" /> : null}
                  {call.error ? <div className="text-xs text-destructive">{call.error}</div> : null}
                </div>
              </li>
            ))}
          </ol>
        </Block>
      ) : null}

      {trial.usage ? (
        <Block title="Spend">
          <UsageTable
            rows={trial.usage.phases.map((entry) => ({
              key: entry.phase,
              label: PHASE_LABELS[entry.phase],
              usage: entry.usage,
            }))}
            total={trial.usage.total}
          />
        </Block>
      ) : null}

      {output?.agentRunId ? <Transcript agentRunId={output.agentRunId} /> : null}

      {trial.grades.length > 0 ? (
        <Block title="Grades">
          <div className="space-y-2">
            {trial.grades.map((grade) => (
              <GradeCard key={grade.graderId} grade={grade} />
            ))}
          </div>
        </Block>
      ) : null}

      {trial.status === 'completed' ? <ReviewForm runId={run.id} trial={trial} /> : null}
    </div>
  );
}

/** The agent run's full history, reasoning included, fetched only when opened. */
function Transcript({ agentRunId }: { agentRunId: string }) {
  const [open, setOpen] = useState(false);
  const query = useAgentRun(open ? agentRunId : null);
  return (
    <Block title="Transcript">
      {open ? (
        query.isPending ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : query.isError ? (
          <StatusMessage kind="error">{toErrorMessage(query.error, 'Could not load the transcript.')}</StatusMessage>
        ) : (
          <TranscriptMessages record={query.data} />
        )
      ) : (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Show full transcript
        </Button>
      )}
    </Block>
  );
}

function TranscriptMessages({ record }: { record: AgentRunRecord }) {
  return (
    <ol className="space-y-1.5">
      {record.history.map((message) => (
        <li key={message.messageId} className="rounded-md border border-border px-2.5 py-2">
          {message.parts.map((part, index) => {
            const key = `${message.messageId}:${index}`;
            if (part.kind === 'text') {
              return (
                <div key={key} className="text-xs">
                  <span className="mr-1.5 font-semibold">{message.role}</span>
                  <span className="whitespace-pre-wrap">{part.text}</span>
                </div>
              );
            }
            if (part.kind === 'data') {
              const type = jsonString(part.data, 'type') ?? 'data';
              return type === 'reasoning' ? (
                <div key={key} className="whitespace-pre-wrap text-xs italic text-muted-foreground">
                  {jsonString(part.data, 'text')}
                </div>
              ) : (
                <JsonView key={key} value={part.data} label={type} />
              );
            }
            return (
              <div key={key} className="text-xs text-muted-foreground">
                file
              </div>
            );
          })}
        </li>
      ))}
    </ol>
  );
}

function ReviewForm({ runId, trial }: { runId: string; trial: EvalTrial }) {
  const setReview = useSetEvalReview();
  const [note, setNote] = useState(trial.review?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = (passed: boolean | null) => {
    setError(null);
    setReview.mutate(
      { runId, trialId: trial.id, input: { review: passed === null ? null : { passed, note } } },
      { onError: (cause) => setError(toErrorMessage(cause, 'Could not save the review.')) },
    );
  };
  return (
    <Block title="Human review" className="rounded-lg border border-border bg-muted/20 p-3">
      <p className="mb-2 text-xs text-muted-foreground">
        Your verdict is the reference each grader's agreement is measured against. It carries over when the run is
        re-graded.
        {trial.review
          ? ` Reviewed ${formatDateTime(trial.review.reviewedAt)}${trial.review.reviewedBy ? ` by ${trial.review.reviewedBy}` : ''}.`
          : ''}
      </p>
      <Textarea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="What is right or wrong about this answer? (optional)"
        className="min-h-16 text-xs"
      />
      {error ? <p className="mt-1.5 text-xs text-destructive">{error}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          variant={trial.review?.passed === true ? 'default' : 'outline'}
          disabled={setReview.isPending}
          onClick={() => save(true)}
        >
          <Check className="size-4" />
          Pass
        </Button>
        <Button
          variant={trial.review?.passed === false ? 'destructive' : 'outline'}
          disabled={setReview.isPending}
          onClick={() => save(false)}
        >
          <X className="size-4" />
          Fail
        </Button>
        {trial.review ? (
          <Button variant="ghost" disabled={setReview.isPending} onClick={() => save(null)}>
            Clear review
          </Button>
        ) : null}
      </div>
    </Block>
  );
}
