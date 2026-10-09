import type { ApprovalStatus, ApprovalView, AuditRecordView } from 'agentdock-sdk/schemas';
import { Check, ChevronLeft, ChevronRight, Clock3, Minus, ShieldCheck, X, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { JsonView } from '@/components/json-view';
import { ListSkeleton } from '@/components/Loading';
import { SectionHeader } from '@/components/SectionHeader';
import { ErrorBanner, type FeedbackMessage, StatusMessage } from '@/components/StatusMessage';
import { PrincipalLabel, ToolIdentity } from '@/components/tool-identity';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDateTime, formatUntil, nowMillis, toErrorMessage } from '@/lib/format';
import { type ToolDirectory, useApprovals, useAudit, useDecideApproval, useToolDirectory } from '@/lib/queries';
import { cn } from '@/lib/utils';

type ApprovalFilter = ApprovalStatus | 'all';

const filters = [
  { value: 'pending', label: 'Pending' },
  { value: 'executing', label: 'Executing' },
  { value: 'approved', label: 'Approved' },
  { value: 'denied', label: 'Denied' },
  { value: 'expired', label: 'Expired' },
  { value: 'all', label: 'All' },
] as const satisfies ReadonlyArray<{ value: ApprovalFilter; label: string }>;

const statusVariant = {
  pending: 'default',
  executing: 'warning',
  approved: 'success',
  denied: 'destructive',
  expired: 'outline',
} as const satisfies Record<ApprovalStatus, 'default' | 'warning' | 'success' | 'destructive' | 'outline'>;

const outcomes = {
  succeeded: { label: 'Succeeded', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
  denied: { label: 'Denied', variant: 'destructive' },
  pending: { label: 'Approval requested', variant: 'default' },
} as const satisfies Record<
  AuditRecordView['outcome'],
  { label: string; variant: 'default' | 'success' | 'destructive' }
>;

const pageSizes = [25, 50, 100] as const;

function useExpired(approval: ApprovalView): boolean {
  const [expired, setExpired] = useState(() => approval.expiresAt <= nowMillis());
  useEffect(() => {
    if (approval.status !== 'pending') return;
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, approval.expiresAt - nowMillis()));
    return () => window.clearTimeout(timer);
  }, [approval.expiresAt, approval.status]);
  return expired;
}

function ApprovalCard({
  approval,
  directory,
  onMessage,
}: {
  approval: ApprovalView;
  directory: ToolDirectory | undefined;
  onMessage: (message: FeedbackMessage) => void;
}) {
  const decide = useDecideApproval();
  const expired = useExpired(approval);
  const pending = approval.status === 'pending';

  const answer = (action: 'approve' | 'deny') =>
    decide.mutate(
      { approvalId: approval.id, action },
      {
        onSuccess: (result) =>
          onMessage(
            result.approval.error === null
              ? {
                  kind: 'success',
                  text: `${approval.tool} was ${action === 'approve' ? 'approved and run' : 'denied'}.`,
                }
              : { kind: 'error', text: `${approval.tool} was approved but failed: ${result.approval.error}` },
          ),
        onError: (error) =>
          onMessage({ kind: 'error', text: toErrorMessage(error, `Could not decide ${approval.tool}.`) }),
      },
    );

  return (
    <div className={cn('space-y-3 rounded-xl border bg-card p-4', pending ? 'border-primary/40' : 'border-border')}>
      <div className="flex min-w-0 items-start gap-3">
        <ToolIdentity toolId={approval.toolId} directory={directory} className="flex-1" />
        <Badge variant={statusVariant[approval.status]}>{approval.status}</Badge>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <PrincipalLabel principal={approval.principal} />
        <span>· asked {formatDateTime(approval.createdAt)}</span>
        <span className={cn(pending && expired && 'text-destructive')}>
          · {pending ? `expires ${formatUntil(approval.expiresAt)}` : `expired ${formatDateTime(approval.expiresAt)}`}
        </span>
      </div>

      {approval.status === 'executing' ? (
        <p role="status" className="text-sm text-muted-foreground">
          Execution has started. If it was interrupted, the action may already have completed. Check the connected
          service before requesting it again; the gateway will not rerun this approval.
        </p>
      ) : null}

      <JsonView value={approval.arguments} label="arguments" defaultOpen={pending} />
      {approval.result === null ? null : <JsonView value={approval.result} label="result" />}
      {approval.error === null ? null : <p className="text-sm text-destructive">{approval.error}</p>}

      {pending ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={decide.isPending || expired} onClick={() => answer('approve')}>
            <Check />
            Approve and run
          </Button>
          <Button type="button" variant="outline" disabled={decide.isPending} onClick={() => answer('deny')}>
            <X />
            Deny
          </Button>
          {expired ? <span className="text-xs text-muted-foreground">Expired — the call does not happen.</span> : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {approval.decidedBy === null ? 'Settled' : `Decided by ${approval.decidedBy}`}{' '}
          {formatDateTime(approval.decidedAt)}
        </p>
      )}
    </div>
  );
}

function IconCell({ label, icon: Icon }: { label: string; icon: typeof Check }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground"
    >
      <Icon aria-hidden className="size-3.5" />
    </span>
  );
}

function AuditStrategy({ decision }: { decision: AuditRecordView['decision'] }) {
  return decision === 'allow' ? (
    <IconCell label="Runs immediately" icon={Zap} />
  ) : decision === 'require_approval' ? (
    <IconCell label="Requires approval" icon={ShieldCheck} />
  ) : (
    <IconCell label="No policy applied" icon={Minus} />
  );
}

function AuditDecision({ record }: { record: AuditRecordView }) {
  if (record.outcome === 'pending') return <IconCell label="Waiting for a decision" icon={Clock3} />;
  if (record.outcome === 'denied') return <IconCell label="Denied" icon={X} />;
  if (record.decision === null) return <IconCell label="No decision recorded" icon={Minus} />;
  return <IconCell label={record.decision === 'require_approval' ? 'Approved' : 'Allowed immediately'} icon={Check} />;
}

function Activity({ directory }: { directory: ToolDirectory | undefined }) {
  const [limit, setLimit] = useState<number>(pageSizes[0]);
  const [offset, setOffset] = useState(0);
  const audit = useAudit({ limit, offset });
  const records = audit.data?.records ?? [];
  const total = audit.data?.total ?? 0;

  if (audit.isPending) return <ListSkeleton />;
  if (audit.isError) return <ErrorBanner>{toErrorMessage(audit.error, 'Failed to load the audit log.')}</ErrorBanner>;
  if (total === 0) return <EmptyState title="No calls yet" description="Tool calls appear here as agents make them." />;

  return (
    <div className="@container overflow-hidden rounded-xl border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Call</TableHead>
            <TableHead>Tool and connection</TableHead>
            <TableHead className="hidden @2xl:table-cell">Caller</TableHead>
            <TableHead className="text-right">Policy</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((record) => (
            <TableRow key={record.id}>
              <TableCell className="w-0 align-top">
                <div className="flex flex-col items-start gap-1.5">
                  <Badge variant={outcomes[record.outcome].variant}>{outcomes[record.outcome].label}</Badge>
                  <span className="text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">
                    {formatDateTime(record.createdAt)}
                  </span>
                  <span className="@2xl:hidden">
                    <PrincipalLabel principal={record.principal} />
                  </span>
                </div>
              </TableCell>
              <TableCell className="align-top">
                <ToolIdentity toolId={record.toolId} directory={directory} />
                {record.message ? (
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground" title={record.message}>
                    {record.message}
                  </p>
                ) : null}
              </TableCell>
              <TableCell className="hidden max-w-48 align-top @2xl:table-cell">
                <PrincipalLabel principal={record.principal} />
                {record.subject ? (
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">for {record.subject}</div>
                ) : null}
              </TableCell>
              <TableCell className="w-0 align-top">
                <div className="flex justify-end gap-1">
                  <AuditStrategy decision={record.decision} />
                  <AuditDecision record={record} />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2">
        <span className="text-xs text-muted-foreground tabular-nums">
          {offset + 1}–{offset + records.length} of {total}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Rows</span>
          <Tabs
            value={String(limit)}
            onValueChange={(next) => {
              setLimit(Number(next));
              setOffset(0);
            }}
            className="gap-0"
          >
            <TabsList className="h-7 p-0.5">
              {pageSizes.map((size) => (
                <TabsTrigger key={size} value={String(size)} className="h-6 px-2">
                  {size}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            <ChevronLeft />
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={offset + records.length >= total}
            onClick={() => setOffset(offset + limit)}
          >
            Next
            <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ApprovalsView() {
  const [filter, setFilter] = useState<ApprovalFilter>('pending');
  const approvalsQuery = useApprovals(filter);
  const directory = useToolDirectory();
  const [message, setMessage] = useState<FeedbackMessage | null>(null);
  const approvals = approvalsQuery.data?.approvals ?? [];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Approvals"
        description="Tool calls an agent froze because they change something. Approving one runs it and hands the result back."
      />

      {message ? <StatusMessage kind={message.kind}>{message.text}</StatusMessage> : null}

      <Tabs value={filter} onValueChange={setFilter}>
        <TabsList>
          {filters.map((entry) => (
            <TabsTrigger key={entry.value} value={entry.value}>
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {approvalsQuery.isPending ? (
        <ListSkeleton />
      ) : approvalsQuery.isError ? (
        <ErrorBanner>{toErrorMessage(approvalsQuery.error, 'Failed to load approvals.')}</ErrorBanner>
      ) : approvals.length === 0 ? (
        <EmptyState
          title={filter === 'pending' ? 'Nothing waiting' : 'Nothing here'}
          description={
            filter === 'pending'
              ? 'No tool call is frozen for a decision right now.'
              : `No ${filter === 'all' ? '' : `${filter} `}approvals recorded.`
          }
        />
      ) : (
        <div className="grid gap-3">
          {approvals.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} directory={directory.data} onMessage={setMessage} />
          ))}
        </div>
      )}

      <SectionHeader title="Activity" description="Every tool call the gateway ran, denied, or froze." />
      <Activity directory={directory.data} />
    </div>
  );
}
