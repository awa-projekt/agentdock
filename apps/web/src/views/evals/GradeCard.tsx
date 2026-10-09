import type { EvalGrade } from 'agentdock-sdk/schemas';
import { Badge } from '@/components/ui/badge';
import { formatCost, formatTokens } from '@/lib/format';
import { GRADER_TYPE_LABELS } from '@/views/evals/eval-format';

/** One grader's verdict with its reasoning, as a trial or a grader test shows it. */
export function GradeCard({ grade }: { grade: EvalGrade }) {
  return (
    <div className="rounded-md border border-border p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={grade.score === undefined ? 'warning' : grade.passed ? 'success' : 'destructive'}>
          {grade.score === undefined ? 'unscored' : grade.passed ? 'pass' : 'fail'}
        </Badge>
        <span className="text-xs font-medium">{grade.graderName}</span>
        <span className="text-[11px] text-muted-foreground">{GRADER_TYPE_LABELS[grade.graderType]}</span>
        {grade.label ? <Badge variant="outline">{grade.label}</Badge> : null}
        {grade.score !== undefined ? (
          <span className="text-[11px] tabular-nums text-muted-foreground">score {grade.score.toFixed(2)}</span>
        ) : null}
        {grade.usage ? (
          <span
            className="text-[11px] text-muted-foreground"
            title={
              grade.usage.cost
                ? `Input ${formatCost(grade.usage.cost.input)}, cache read ${formatCost(grade.usage.cost.cacheRead)}, cache write ${formatCost(grade.usage.cost.cacheWrite)}, output ${formatCost(grade.usage.cost.output)} (thinking ${formatCost(grade.usage.cost.reasoning)})`
                : 'No rates known for this model'
            }
          >
            {formatTokens(grade.usage.tokens.total)} tokens
            {grade.usage.cost ? ` · ${formatCost(grade.usage.cost.total)}` : ''}
          </span>
        ) : null}
      </div>
      {grade.error ? <p className="mt-1.5 text-xs text-destructive">{grade.error}</p> : null}
      {grade.reasoning ? (
        <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{grade.reasoning}</p>
      ) : null}
    </div>
  );
}
