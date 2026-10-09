import type { EvalUsage, EvalUsagePhase } from 'agentdock-sdk/schemas';
import type { ReactNode } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCost, formatTokens } from '@/lib/format';
import { cn } from '@/lib/utils';

export const PHASE_LABELS = {
  'tool-use': 'Tool-use steps',
  answer: 'Final answer',
  subagents: 'Subagents',
} satisfies Record<EvalUsagePhase, string>;

export type UsageRow = { readonly key: string; readonly label: ReactNode; readonly usage: EvalUsage };

/** Tokens over the USD they cost; the cost is left out when the model's rates are unknown. */
function Cell({
  tokens,
  cost,
  approximate = false,
}: {
  tokens: number;
  cost: number | undefined;
  approximate?: boolean;
}) {
  return (
    <TableCell className="text-right tabular-nums">
      <div className="text-xs">
        {approximate && tokens > 0 ? '≈' : ''}
        {formatTokens(tokens)}
      </div>
      <div className="text-[11px] text-muted-foreground">{cost === undefined ? '' : formatCost(cost)}</div>
    </TableCell>
  );
}

/**
 * Spend split two ways at once: rows are where in the loop (or which model)
 * the tokens went, columns how they were billed. Input is the uncached part
 * of the prompt; thinking is the share of output spent reasoning, so it is
 * included in output, not added to it.
 */
export function UsageTable({ rows, total }: { rows: ReadonlyArray<UsageRow>; total?: EvalUsage | undefined }) {
  const estimated = [...rows.map((row) => row.usage), ...(total ? [total] : [])].some(
    (usage) => usage.reasoningEstimated,
  );
  const line = (key: string, label: ReactNode, usage: EvalUsage, emphasis: boolean) => {
    const { tokens, cost } = usage;
    return (
      <TableRow key={key} className={cn(emphasis && 'bg-muted/30 font-medium')}>
        <TableCell className="text-xs">{label}</TableCell>
        <TableCell className="text-right text-xs tabular-nums">{usage.calls}</TableCell>
        <Cell tokens={Math.max(0, tokens.input - tokens.cacheRead - tokens.cacheWrite)} cost={cost?.input} />
        <Cell tokens={tokens.cacheRead} cost={cost?.cacheRead} />
        <Cell tokens={tokens.cacheWrite} cost={cost?.cacheWrite} />
        <Cell tokens={tokens.output} cost={cost?.output} />
        <Cell tokens={tokens.reasoning} cost={cost?.reasoning} approximate={usage.reasoningEstimated} />
        <TableCell className="text-right text-xs font-semibold tabular-nums">
          {cost === undefined ? (
            <span className="font-normal text-muted-foreground">unpriced</span>
          ) : (
            formatCost(cost.total)
          )}
        </TableCell>
      </TableRow>
    );
  };
  return (
    <div className="space-y-1.5">
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Part</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right" title="Prompt tokens billed at the full input rate">
                Input
              </TableHead>
              <TableHead className="text-right">Cache read</TableHead>
              <TableHead className="text-right">Cache write</TableHead>
              <TableHead className="text-right">Output</TableHead>
              <TableHead className="text-right" title="The share of output spent on reasoning">
                of which thinking
              </TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => line(row.key, row.label, row.usage, false))}
            {total && rows.length > 1 ? line('total', 'Total', total, true) : null}
          </TableBody>
        </Table>
      </div>
      {estimated ? (
        <p className="text-[11px] text-muted-foreground">
          ≈ Thinking is estimated where the provider bills it inside output without counting it (e.g. Anthropic): the
          output beyond what the call visibly wrote.
        </p>
      ) : null}
    </div>
  );
}
