import type { EvalGrader, EvalGraderId } from 'agentdock-sdk/schemas';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { GRADER_TYPE_LABELS, graderSummary } from '@/views/evals/eval-format';

/** A checklist of graders; judges are marked because each one costs a model call per trial. */
export function GraderPicker({
  graders,
  selected,
  onChange,
}: {
  graders: ReadonlyArray<EvalGrader>;
  selected: ReadonlyArray<EvalGraderId>;
  onChange: (graderIds: ReadonlyArray<EvalGraderId>) => void;
}) {
  if (graders.length === 0) {
    return <p className="text-xs text-muted-foreground">No graders yet. Create one in the Graders tab.</p>;
  }
  const toggle = (graderId: EvalGraderId) =>
    onChange(selected.includes(graderId) ? selected.filter((id) => id !== graderId) : [...selected, graderId]);

  return (
    <div className="max-h-56 space-y-1.5 overflow-y-auto">
      {graders.map((grader) => {
        const checked = selected.includes(grader.id);
        return (
          <label
            key={grader.id}
            className={cn(
              'flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-2.5 py-2 transition-colors',
              checked ? 'border-primary/40 bg-primary/5' : 'hover:bg-muted/40',
            )}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => toggle(grader.id)}
              className="mt-0.5 size-3.5 accent-[var(--primary)]"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium">{grader.name}</span>
                <Badge variant={grader.config.type === 'llm-judge' ? 'warning' : 'secondary'}>
                  {GRADER_TYPE_LABELS[grader.config.type]}
                </Badge>
              </div>
              <div className="truncate text-[11px] text-muted-foreground">{graderSummary(grader.config)}</div>
            </div>
          </label>
        );
      })}
    </div>
  );
}
