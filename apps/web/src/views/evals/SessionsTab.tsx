import type { EvalCaseInput, EvalSessionDetail, EvalSessionSummary } from 'agentdock-sdk/schemas';
import { ListPlus } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { Field } from '@/components/form';
import { JsonView } from '@/components/json-view';
import { DetailSkeleton, ListSkeleton } from '@/components/Loading';
import { MasterDetail } from '@/components/MasterDetail';
import { Markdown, MarkdownPreview } from '@/components/markdown';
import { SelectableCard } from '@/components/SelectableCard';
import { ErrorBanner, StatusMessage } from '@/components/StatusMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { compactText, formatDateTime, toErrorMessage } from '@/lib/format';
import { useAddEvalCases, useEvalDatasets, useEvalSession, useEvalSessions } from '@/lib/queries';
import { CaseDialog } from '@/views/evals/CaseDialog';

const sessionKey = (target: { id: string }, sessionId: string): string => `${target.id}\u0000${sessionId}`;

const actionLabel = (action: EvalSessionDetail['outcome']['actions'][number]): string =>
  action.toolName ? `${action.type}: ${action.toolName}` : action.type;

/**
 * Saved chat sessions with agents and workflows. Real conversations, and
 * especially real failures, are the best source of eval cases, so any
 * session can be turned into a case of a dataset.
 */
export function SessionsTab() {
  const sessionsQuery = useEvalSessions();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [targetKind, setTargetKind] = useState<'all' | EvalSessionSummary['target']['kind']>('all');

  const sessions = sessionsQuery.data ?? [];
  const filteredSessions = useMemo(() => {
    const search = deferredQuery.trim().toLowerCase();
    return sessions.filter((session) => {
      if (targetKind !== 'all' && session.target.kind !== targetKind) {
        return false;
      }

      if (!search) {
        return true;
      }

      return [session.title, session.target.name, session.initialMessage, session.outcome.text]
        .join('\n')
        .toLowerCase()
        .includes(search);
    });
  }, [deferredQuery, sessions, targetKind]);

  const selectedSession =
    filteredSessions.find((session) => sessionKey(session.target, session.id) === selectedKey) ??
    filteredSessions[0] ??
    null;

  const detailQuery = useEvalSession(
    selectedSession ? { targetId: selectedSession.target.id, sessionId: selectedSession.id } : null,
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <MasterDetail
        masterWidth="420px"
        master={
          <>
            <div className="space-y-3 border-b border-border pb-4">
              <div className="flex gap-2">
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search task, outcome, or target"
                />
                <Button
                  variant="outline"
                  onClick={() => void sessionsQuery.refetch()}
                  disabled={sessionsQuery.isFetching}
                >
                  {sessionsQuery.isFetching ? 'Refreshing…' : 'Refresh'}
                </Button>
              </div>
              <Select
                value={targetKind}
                items={{ all: 'All targets', agent: 'Agents', workflow: 'Workflows', unknown: 'Unknown' }}
                onValueChange={setTargetKind}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Filter target" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All targets</SelectItem>
                  <SelectItem value="agent">Agents</SelectItem>
                  <SelectItem value="workflow">Workflows</SelectItem>
                  <SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {sessionsQuery.isError ? (
                <ErrorBanner>{toErrorMessage(sessionsQuery.error, 'Could not load eval sessions.')}</ErrorBanner>
              ) : sessionsQuery.isPending ? (
                <div className="space-y-2 p-2">
                  <ListSkeleton compact />
                </div>
              ) : filteredSessions.length === 0 ? (
                <EmptyState
                  title="No sessions found"
                  description="Run a chat with an agent or workflow, then come back here."
                />
              ) : (
                <div className="space-y-2">
                  {filteredSessions.map((session) => {
                    const key = sessionKey(session.target, session.id);
                    const active =
                      selectedSession?.id === session.id && selectedSession.target.id === session.target.id;
                    return (
                      <SelectableCard key={key} onClick={() => setSelectedKey(key)} active={active}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold">{session.title}</div>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                              <Badge variant={session.target.kind === 'workflow' ? 'outline' : 'secondary'}>
                                {session.target.kind}
                              </Badge>
                              <span className="truncate">{session.target.name}</span>
                            </div>
                          </div>
                          <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                            {formatDateTime(session.updatedAt)}
                          </div>
                        </div>
                        <p className="mt-3 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground/80">Task:</span>{' '}
                          {compactText(session.initialMessage || 'No initial message')}
                        </p>
                        <div className="mt-2 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground/80">Outcome:</span>{' '}
                          {session.outcome.text ? (
                            <MarkdownPreview lines={4} className="mt-0.5">
                              {session.outcome.text}
                            </MarkdownPreview>
                          ) : (
                            'No final response'
                          )}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                          <Badge variant="outline">{session.messageCount} messages</Badge>
                          <Badge variant="outline">{session.actionCount} actions</Badge>
                          {session.outcome.state ? <Badge variant="outline">{session.outcome.state}</Badge> : null}
                        </div>
                      </SelectableCard>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        }
        detail={
          sessionsQuery.isPending ? (
            <DetailSkeleton />
          ) : detailQuery.isError ? (
            <ErrorBanner>{toErrorMessage(detailQuery.error, 'Could not load session details.')}</ErrorBanner>
          ) : selectedSession && detailQuery.isPending ? (
            <div className="space-y-4">
              <DetailSkeleton />
            </div>
          ) : detailQuery.data ? (
            <EvalSessionDetailView session={detailQuery.data} />
          ) : (
            <EmptyState
              title="Select a session"
              description="Choose a saved session to inspect messages, tool calls, and outcome."
            />
          )
        }
      />
    </div>
  );
}

/** Files a session as a case: its first message is the input, its answer the proposed reference. */
function AddToDataset({ session }: { session: EvalSessionDetail }) {
  const datasets = useEvalDatasets().data ?? [];
  const addCases = useAddEvalCases();
  const [open, setOpen] = useState(false);
  const [datasetId, setDatasetId] = useState('');
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const activeDatasetId = datasetId || datasets[0]?.id || '';

  const save = (input: EvalCaseInput) => {
    setMessage(null);
    addCases.mutate(
      { datasetId: activeDatasetId, input: { cases: [input] } },
      {
        onSuccess: () => {
          setOpen(false);
          const name = datasets.find((dataset) => dataset.id === activeDatasetId)?.name ?? 'the dataset';
          setMessage({ kind: 'success', text: `Added to ${name}.` });
        },
        onError: (cause) => setMessage({ kind: 'error', text: toErrorMessage(cause, 'Could not add the case.') }),
      },
    );
  };

  return (
    <div className="space-y-2">
      <Button variant="outline" onClick={() => setOpen(true)} disabled={datasets.length === 0}>
        <ListPlus className="size-4" />
        {datasets.length === 0 ? 'Create a dataset to add cases' : 'Add to dataset'}
      </Button>
      {message ? <StatusMessage kind={message.kind}>{message.text}</StatusMessage> : null}
      <CaseDialog
        open={open}
        onOpenChange={setOpen}
        evalCase={null}
        draft={{ input: session.initialMessage, expected: session.outcome.text }}
        pending={addCases.isPending}
        onSave={save}
        header={
          <Field
            label="Dataset"
            htmlFor="session-dataset"
            description="Check the reference answer: the agent's reply is only a starting point."
          >
            <Select
              value={activeDatasetId}
              items={datasets.map((dataset) => ({ value: dataset.id, label: dataset.name }))}
              onValueChange={setDatasetId}
            >
              <SelectTrigger id="session-dataset" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {datasets.map((dataset) => (
                  <SelectItem key={dataset.id} value={dataset.id}>
                    {dataset.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        }
      />
    </div>
  );
}

function EvalSessionDetailView({ session }: { session: EvalSessionDetail }) {
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 border-b border-border pb-5 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={session.target.kind === 'workflow' ? 'outline' : 'secondary'}>{session.target.kind}</Badge>
            <span className="text-sm text-muted-foreground">{session.target.name}</span>
          </div>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">{session.title}</h2>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {session.target.id} / {session.id}
          </p>
        </div>
        <div className="space-y-2 text-xs text-muted-foreground lg:text-right">
          <div>Created {formatDateTime(session.createdAt)}</div>
          <div>Updated {formatDateTime(session.updatedAt)}</div>
          <AddToDataset session={session} />
        </div>
      </div>

      <div className="grid gap-4 @3xl:grid-cols-2">
        <div className="rounded-lg border border-border bg-muted/20 p-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Initial task</div>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">
            {session.initialMessage || 'No initial message captured.'}
          </p>
        </div>
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Outcome</div>
            {session.outcome.state ? <Badge variant="outline">{session.outcome.state}</Badge> : null}
          </div>
          {session.outcome.text ? (
            <Markdown className="mt-2 text-sm leading-relaxed">{session.outcome.text}</Markdown>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">No final response captured.</p>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-border p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="font-semibold">Actions taken</h3>
          <Badge variant="outline">{session.outcome.actions.length}</Badge>
        </div>
        {session.outcome.actions.length > 0 ? (
          <div className="space-y-3">
            {session.outcome.actions.map((action) => (
              <div key={action.id} className="rounded-md border border-border bg-background p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={action.type === 'tool-error' ? 'destructive' : 'secondary'}>{action.type}</Badge>
                  <span className="font-mono text-xs font-semibold">{actionLabel(action)}</span>
                </div>
                {action.toolCallId ? (
                  <div className="mt-1 font-mono text-[11px] text-muted-foreground">{action.toolCallId}</div>
                ) : null}
                <div className="mt-3 grid gap-3 @3xl:grid-cols-2">
                  {'input' in action && action.input != null ? (
                    <JsonView value={action.input} label="input" defaultOpen />
                  ) : null}
                  {'output' in action && action.output != null ? (
                    <JsonView value={action.output} label="output" defaultOpen />
                  ) : null}
                  {action.error ? (
                    <div className="rounded bg-destructive/10 p-2 text-xs text-destructive">{action.error}</div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No tool calls or tool results captured for this session.</p>
        )}
      </div>

      <div className="rounded-lg border border-border p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="font-semibold">Message timeline</h3>
          <Badge variant="outline">{session.messages.length}</Badge>
        </div>
        <div className="space-y-3">
          {session.messages.map((message) => (
            <div key={message.id} className="rounded-md border border-border bg-background p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant={message.role === 'user' ? 'secondary' : 'outline'}>{message.role}</Badge>
                  <span className="font-mono text-[11px] text-muted-foreground">{message.id}</span>
                </div>
                {message.createdAt ? (
                  <span className="text-[11px] text-muted-foreground">{formatDateTime(message.createdAt)}</span>
                ) : null}
              </div>
              {!message.text ? null : message.role === 'user' ? (
                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{message.text}</p>
              ) : (
                <Markdown className="mt-3 text-sm leading-relaxed">{message.text}</Markdown>
              )}
              <JsonView value={message.parts} label="raw parts" className="mt-3" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
