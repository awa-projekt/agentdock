import { Plus } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { DetailSkeleton, ListSkeleton } from '@/components/Loading';
import { MasterDetail } from '@/components/MasterDetail';
import { SelectableCard } from '@/components/SelectableCard';
import { ErrorBanner } from '@/components/StatusMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toErrorMessage } from '@/lib/format';
import { useEvalGraders } from '@/lib/queries';
import { GRADER_TYPE_LABELS, graderSummary } from '@/views/evals/eval-format';
import { GraderEditor } from '@/views/evals/GraderEditor';

export function GradersTab({
  graderId,
  onSelectGrader,
}: {
  graderId: string | null;
  onSelectGrader: (graderId: string | null) => void;
}) {
  const gradersQuery = useEvalGraders();
  const graders = gradersQuery.data ?? [];
  const [creating, setCreating] = useState(false);
  const selected = creating ? null : (graders.find((grader) => grader.id === graderId) ?? graders[0] ?? null);

  return (
    <MasterDetail
      masterWidth="340px"
      master={
        <>
          <Button onClick={() => setCreating(true)} className="self-start">
            <Plus className="size-4" />
            New grader
          </Button>
          {gradersQuery.isError ? (
            <ErrorBanner>{toErrorMessage(gradersQuery.error, 'Could not load graders.')}</ErrorBanner>
          ) : gradersQuery.isPending ? (
            <ListSkeleton compact />
          ) : graders.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No graders yet. Start with a code check such as exact match, then add an LLM judge for what code cannot
              check.
            </p>
          ) : (
            <div className="space-y-2">
              {graders.map((grader) => (
                <SelectableCard
                  key={grader.id}
                  active={selected?.id === grader.id}
                  onClick={() => {
                    setCreating(false);
                    onSelectGrader(grader.id);
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="truncate text-sm font-semibold">{grader.name}</div>
                    <Badge variant={grader.config.type === 'llm-judge' ? 'warning' : 'secondary'}>
                      {GRADER_TYPE_LABELS[grader.config.type]}
                    </Badge>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {grader.description || graderSummary(grader.config)}
                  </p>
                </SelectableCard>
              ))}
            </div>
          )}
        </>
      }
      detail={
        gradersQuery.isPending ? (
          <DetailSkeleton />
        ) : creating || selected ? (
          <GraderEditor
            key={selected?.id ?? 'new'}
            grader={selected}
            onSaved={(grader) => {
              setCreating(false);
              onSelectGrader(grader.id);
            }}
            onDeleted={() => onSelectGrader(null)}
          />
        ) : (
          <EmptyState
            title="No grader selected"
            description="Graders score each trial: code checks for what can be checked exactly, LLM judges for the rest."
            action={<Button onClick={() => setCreating(true)}>New grader</Button>}
          />
        )
      }
    />
  );
}
