import type { Part } from '@a2a-js/sdk';
import { useMutation } from '@tanstack/react-query';
import type {
  AgentRecord,
  InputContract,
  RegisteredWorkflow,
  WorkflowRun,
  WorkflowRunEvent,
  WorkflowRunStatus,
  WorkflowStepRun,
} from 'agentdock-sdk/schemas';
import {
  coerceJson,
  coerceJsonObject,
  decodeJsonObjectStringOption,
  isJsonObject,
  type Json,
  type JsonObject,
  jsonString,
  manifestInputContract,
  renderJson,
  workflowGraphHasTopology,
} from 'agentdock-sdk/schemas';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import { CheckCircle2, CircleDot, Clock, Loader2, Maximize2, Play, Plus, X, XCircle } from 'lucide-react';
import { type ReactNode, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { type StepRunView, WorkflowGraphCanvas } from '@/components/graph/workflow-graph';
import { initialValueForSchema, JsonSchemaForm } from '@/components/json-schema-form';
import { GraphSkeleton, ListSkeleton } from '@/components/Loading';
import { Markdown, MarkdownPreview } from '@/components/markdown';
import { SelectableCard } from '@/components/SelectableCard';
import { ErrorBanner } from '@/components/StatusMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SidePanel } from '@/components/ui/side-panel';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { AgentCallTimeline } from '@/components/workflow/agent-call-timeline';
import { usePersistedFlag } from '@/hooks/use-ui-preferences';
import { compactText, formatDateTime, formatTime, toErrorMessage } from '@/lib/format';
import { type Json as JsonSchema, jsonSchemaDocument } from '@/lib/json-schema';
import {
  queryKeys,
  useAgents,
  useInvalidate,
  useWorkflowRun,
  useWorkflowRunEvents,
  useWorkflowRuns,
  useWorkflows,
} from '@/lib/queries';
import { isTerminalStatus, mergeEvents, reduceProgress, type StepProgress } from '@/lib/run-progress';
import { cn } from '@/lib/utils';
import { resumeWorkflowRun, startWorkflowRun, streamWorkflowRun } from '@/lib/workflow-a2a';
import { buildStepActivityModel, isStepActivityEvent, type StepActivityEvent } from '@/lib/workflow-a2a-events';
import { hasLiveRunOrigin, subscribeLiveRun } from '@/lib/workflow-run-live';

const RUN_STATUSES: ReadonlyArray<WorkflowRunStatus> = [
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
];

const statusBadgeVariant = (
  status: WorkflowRunStatus,
): 'success' | 'destructive' | 'default' | 'warning' | 'secondary' | 'outline' => {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'destructive';
    case 'working':
      return 'default';
    case 'input-required':
      return 'warning';
    case 'submitted':
      return 'secondary';
    case 'canceled':
      return 'outline';
  }
};

function RunStatusBadge({ status }: { status: WorkflowRunStatus }) {
  return (
    <Badge variant={statusBadgeVariant(status)} className="gap-1">
      {status === 'working' ? <Loader2 className="size-3 animate-spin" /> : null}
      {status}
    </Badge>
  );
}

const workflowNameOf = (workflows: ReadonlyArray<RegisteredWorkflow>, workflowId: string): string =>
  workflows.find((workflow) => workflow.id === workflowId)?.manifest.name ?? workflowId;

export function WorkflowRunsView({
  selectedRunId,
  onSelectRun,
}: {
  selectedRunId: string | null;
  onSelectRun: (runId: string | null) => void;
}) {
  const workflows = useWorkflows().data ?? [];
  const agents = useAgents().data ?? [];
  const runsQuery = useWorkflowRuns();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [statusFilter, setStatusFilter] = useState<'all' | WorkflowRunStatus>('all');
  const [workflowFilter, setWorkflowFilter] = useState<'all' | string>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [listCollapsed, setListCollapsed] = usePersistedFlag('agentdock-wf-runs-list', false);
  const [detailCollapsed, setDetailCollapsed] = usePersistedFlag('agentdock-wf-runs-detail', false);

  const runs = runsQuery.data ?? [];
  const filteredRuns = useMemo(() => {
    const search = deferredQuery.trim().toLowerCase();
    return runs.filter((run) => {
      if (statusFilter !== 'all' && run.status !== statusFilter) {
        return false;
      }

      if (workflowFilter !== 'all' && run.workflowId !== workflowFilter) {
        return false;
      }

      if (!search) {
        return true;
      }

      return [run.id, run.input, workflowNameOf(workflows, run.workflowId)].join('\n').toLowerCase().includes(search);
    });
  }, [deferredQuery, runs, statusFilter, workflowFilter, workflows]);

  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden rounded-xl border border-border bg-muted/20">
      {runsQuery.isPending ? (
        <div className="flex h-full p-6">
          <GraphSkeleton />
        </div>
      ) : selectedRun ? (
        <RunDetail
          key={selectedRun.id}
          run={selectedRun}
          workflow={workflows.find((workflow) => workflow.id === selectedRun.workflowId) ?? null}
          agents={agents}
          detailCollapsed={detailCollapsed}
          onDetailCollapsedChange={setDetailCollapsed}
        />
      ) : (
        <div className="flex h-full items-center justify-center p-6">
          <EmptyState title="Select a run" description="Choose a run to watch its progress on the workflow graph." />
        </div>
      )}

      <SidePanel
        side="left"
        title="Runs"
        collapsed={listCollapsed}
        onCollapsedChange={setListCollapsed}
        widthClassName="w-96"
        actions={
          <Button size="sm" onClick={() => setDialogOpen(true)} disabled={workflows.length === 0}>
            <Plus className="size-4" />
            New run
          </Button>
        }
      >
        <div className="space-y-3">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search id, input, or workflow"
          />
          <div className="grid grid-cols-2 gap-2">
            <Select
              value={statusFilter}
              items={[
                { value: 'all', label: 'All statuses' },
                ...RUN_STATUSES.map((status) => ({ value: status, label: status })),
              ]}
              onValueChange={setStatusFilter}
            >
              <SelectTrigger>
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {RUN_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={workflowFilter}
              items={[
                { value: 'all', label: 'All workflows' },
                ...workflows.map((workflow) => ({ value: workflow.id, label: workflow.manifest.name })),
              ]}
              onValueChange={(value) => setWorkflowFilter(value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Workflow" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All workflows</SelectItem>
                {workflows.map((workflow) => (
                  <SelectItem key={workflow.id} value={workflow.id}>
                    {workflow.manifest.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {runsQuery.status === 'error' ? (
            <ErrorBanner>{toErrorMessage(runsQuery.error, 'Could not load runs.')}</ErrorBanner>
          ) : runsQuery.status === 'pending' ? (
            <div className="space-y-2">
              <ListSkeleton compact />
            </div>
          ) : filteredRuns.length === 0 ? (
            <EmptyState title="No runs" description="Start a new run to see its progress here." />
          ) : (
            <div className="space-y-2">
              {filteredRuns.map((run) => (
                <SelectableCard key={run.id} onClick={() => onSelectRun(run.id)} active={run.id === selectedRunId}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{workflowNameOf(workflows, run.workflowId)}</div>
                      <div className="truncate font-mono text-[10px] text-muted-foreground">{run.workflowId}</div>
                    </div>
                    <RunStatusBadge status={run.status} />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">{compactText(run.input || 'No input', 120)}</p>
                  <div className="mt-2 text-[11px] text-muted-foreground">{formatDateTime(run.startedAt)}</div>
                </SelectableCard>
              ))}
            </div>
          )}
        </div>
      </SidePanel>

      {dialogOpen ? (
        <NewRunDialog
          workflows={workflows}
          onClose={() => setDialogOpen(false)}
          onStarted={(runId) => {
            setDialogOpen(false);
            onSelectRun(runId);
          }}
        />
      ) : null}
    </div>
  );
}

function RunDetail({
  run,
  workflow,
  agents,
  detailCollapsed,
  onDetailCollapsedChange,
}: {
  run: WorkflowRun;
  workflow: RegisteredWorkflow | null;
  agents: ReadonlyArray<AgentRecord>;
  detailCollapsed: boolean;
  onDetailCollapsedChange: (collapsed: boolean) => void;
}) {
  const invalidate = useInvalidate();
  const nonTerminal = !isTerminalStatus(run.status);

  const snapshotQuery = useWorkflowRun(run.id);
  const eventsQuery = useWorkflowRunEvents(run.id);

  const [liveEvents, setLiveEvents] = useState<ReadonlyArray<WorkflowRunEvent>>([]);

  // Live tail: drain + subscribe to this run's originating stream (buffered from
  // the moment it started, so no early events are missed). Only fall back to
  // resubscribing the A2A task when this run wasn't started in this tab — that
  // path can't replay history, so it's a best-effort tail for reopened runs.
  useEffect(() => {
    const unsubscribe = subscribeLiveRun(run.id, (event) => setLiveEvents((current) => [...current, event]));

    if (isTerminalStatus(run.status) || hasLiveRunOrigin(run.id)) {
      return unsubscribe;
    }

    const controller = new AbortController();
    void streamWorkflowRun(
      run.workflowId,
      run.taskId,
      (event) => setLiveEvents((current) => [...current, event]),
      controller.signal,
    ).finally(() => {
      // A terminal event likely arrived; refresh the persisted view to settle.
      void invalidate(queryKeys.workflowRun(run.id), queryKeys.workflowRuns);
    });

    return () => {
      unsubscribe();
      controller.abort();
    };
  }, [invalidate, run.id, run.status, run.taskId, run.workflowId]);

  const snapshot = snapshotQuery.data;
  const snapshotSteps: ReadonlyArray<WorkflowStepRun> = snapshot?.steps ?? [];
  const mergedEvents = useMemo(() => mergeEvents(eventsQuery.data ?? [], liveEvents), [eventsQuery.data, liveEvents]);
  const progress = useMemo(
    () => reduceProgress(snapshot?.run.status ?? run.status, snapshotSteps, mergedEvents),
    [snapshot?.run.status, run.status, snapshotSteps, mergedEvents],
  );
  const runRecord = snapshot?.run ?? run;
  const pendingHumanRequests = useMemo(() => pendingHumanInputRequests(mergedEvents), [mergedEvents]);

  return (
    <>
      <RunCanvas
        workflow={workflow}
        progress={progress.steps}
        events={mergedEvents}
        agents={agents}
        declaredSteps={(workflow?.graph.nodes ?? []).filter((node) => node.kind === 'step').map((node) => node.id)}
      />

      <SidePanel
        side="right"
        title="Run details"
        collapsed={detailCollapsed}
        onCollapsedChange={onDetailCollapsedChange}
        widthClassName="w-[26rem]"
        actions={<RunStatusBadge status={progress.runStatus} />}
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <div>
              <div className="text-sm font-semibold">{workflow?.manifest.name ?? runRecord.workflowId}</div>
              <p className="font-mono text-[10px] text-muted-foreground">{runRecord.workflowId}</p>
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">Run {runRecord.id}</p>
            <div className="mt-2 text-xs text-muted-foreground">
              <div>Started {formatDateTime(runRecord.startedAt)}</div>
              {runRecord.completedAt ? <div>Completed {formatDateTime(runRecord.completedAt)}</div> : null}
              {workflow && runRecord.sourceHash && runRecord.sourceHash !== workflow.sourceHash ? (
                <div className="mt-1 text-warning">
                  Ran a different revision of the artifact than the one now registered.
                </div>
              ) : null}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-muted/20 p-4">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Input</div>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{runRecord.input || 'No input.'}</p>
          </div>
          <div
            className={cn(
              'rounded-lg border p-4',
              runRecord.error ? 'border-destructive/30 bg-destructive/5' : 'border-primary/20 bg-primary/5',
            )}
          >
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {runRecord.error ? 'Error' : 'Output'}
            </div>
            {runRecord.error || runRecord.output ? (
              <Markdown className="mt-2 text-sm leading-relaxed">{runRecord.error || runRecord.output}</Markdown>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">{nonTerminal ? 'Running…' : 'No output captured.'}</p>
            )}
          </div>

          {pendingHumanRequests.length > 0 ? (
            <HumanInputRequestsPanel
              run={runRecord}
              requests={pendingHumanRequests}
              onEvent={(event) => setLiveEvents((current) => [...current, event])}
              onSettled={() =>
                void invalidate(
                  queryKeys.workflowRun(run.id),
                  queryKeys.workflowRunEvents(run.id),
                  queryKeys.workflowRuns,
                )
              }
            />
          ) : null}

          <RunEventTimeline events={mergedEvents} />
        </div>
      </SidePanel>
    </>
  );
}

type HumanInputRequestedEvent = Extract<WorkflowRunEvent, { type: 'human-input-requested' }>;

const pendingHumanInputRequests = (
  events: ReadonlyArray<WorkflowRunEvent>,
): ReadonlyArray<HumanInputRequestedEvent> => {
  const resolved = new Set<string>();
  const requested: HumanInputRequestedEvent[] = [];

  for (const event of events) {
    if (event.type === 'human-input-resolved') {
      resolved.add(event.actionId);
    } else if (event.type === 'human-input-requested') {
      requested.push(event);
    }
  }

  return requested.filter((event) => !resolved.has(event.actionId));
};

const initialHumanResponseValue = (request: HumanInputRequestedEvent): JsonObject => {
  const schema = parseJsonSchema(request.responseSchema);
  return schema ? coerceJsonObject(initialValueForSchema(schema, schema)) : {};
};

function HumanInputRequestsPanel({
  run,
  requests,
  onEvent,
  onSettled,
}: {
  readonly run: WorkflowRun;
  readonly requests: ReadonlyArray<HumanInputRequestedEvent>;
  readonly onEvent: (event: WorkflowRunEvent) => void;
  readonly onSettled: () => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/5 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">Human input required</h3>
          <p className="text-xs text-muted-foreground">Respond to resume the paused workflow run.</p>
        </div>
        <Badge variant="outline">{requests.length}</Badge>
      </div>
      {requests.map((request) => (
        <HumanInputRequestCard
          key={request.actionId}
          run={run}
          request={request}
          onEvent={onEvent}
          onSettled={onSettled}
        />
      ))}
    </div>
  );
}

function HumanInputRequestCard({
  run,
  request,
  onEvent,
  onSettled,
}: {
  readonly run: WorkflowRun;
  readonly request: HumanInputRequestedEvent;
  readonly onEvent: (event: WorkflowRunEvent) => void;
  readonly onSettled: () => void;
}) {
  const schema = useMemo(() => parseJsonSchema(request.responseSchema), [request.responseSchema]);
  const [response, setResponse] = useState<JsonObject>(() => initialHumanResponseValue(request));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResponse(initialHumanResponseValue(request));
    setError(null);
  }, [request]);

  const submit = async () => {
    if (submitting || !run.contextId) {
      return;
    }

    setSubmitting(true);
    setError(null);
    const controller = new AbortController();
    try {
      await resumeWorkflowRun({
        workflowId: run.workflowId,
        taskId: run.taskId,
        contextId: run.contextId,
        actionId: request.actionId,
        response,
        onEvent,
        signal: controller.signal,
      });
      onSettled();
    } catch (caught) {
      setError(toErrorMessage(caught, 'Could not submit the response.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background p-3">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{request.title}</span>
          <Badge variant="secondary" className="font-mono text-[10px]">
            {request.label}
          </Badge>
        </div>
        {request.description ? <p className="mt-1 text-xs text-muted-foreground">{request.description}</p> : null}
        <p className="mt-1 font-mono text-[10px] text-muted-foreground">{request.actionId}</p>
      </div>

      {run.contextId ? (
        <div className="space-y-2">
          <JsonSchemaForm schema={schema} value={response} onChange={(next) => setResponse(coerceJsonObject(next))} />
          {!schema && request.responseSchema?.trim() ? (
            <p className="text-[11px] text-destructive">Invalid JSON schema; edit raw JSON.</p>
          ) : null}
          {error ? <ErrorBanner>{error}</ErrorBanner> : null}
          <div className="flex justify-end">
            <Button size="sm" onClick={submit} disabled={submitting}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
              Submit response
            </Button>
          </div>
        </div>
      ) : (
        <ErrorBanner>This run is missing its A2A context id, so it cannot be resumed from the UI.</ErrorBanner>
      )}
    </div>
  );
}

/** One run of a step: a loop's round or one branch of a fan-out. */
type StepRunDetails = {
  readonly executionId: string;
  readonly status: StepProgress['status'] | undefined;
  readonly input: string | undefined;
  readonly output: string | undefined;
  readonly error: string | undefined;
  readonly events: ReadonlyArray<StepActivityEvent>;
};

type StepDetails = {
  readonly stepId: string;
  readonly label: string;
  readonly status?: StepProgress['status'] | undefined;
  readonly input?: string | undefined;
  readonly output?: string | undefined;
  readonly agentName: string | null;
  readonly runs: ReadonlyArray<StepRunDetails>;
};

const eventsForStepId = (events: ReadonlyArray<WorkflowRunEvent>, stepId: string): ReadonlyArray<WorkflowRunEvent> =>
  events.filter((event) => 'stepId' in event && event.stepId === stepId);

/**
 * A step's events split by the run they belong to, in the order the runs
 * started. An event without an execution id belongs to the latest run.
 */
const stepRuns = (
  events: ReadonlyArray<WorkflowRunEvent>,
  progress: StepProgress | undefined,
): ReadonlyArray<StepRunDetails> => {
  const runs = new Map<string, Array<WorkflowRunEvent>>();
  let latest: string | undefined;
  for (const event of events) {
    const executionId = ('executionId' in event ? event.executionId : undefined) ?? latest ?? '';
    latest = executionId;
    runs.set(executionId, [...(runs.get(executionId) ?? []), event]);
  }
  return [...runs].map(([executionId, runEvents]): StepRunDetails => {
    const activity = runEvents.filter(isStepActivityEvent);
    let input: string | undefined;
    let output: string | undefined;
    let error: string | undefined;
    for (const event of runEvents) {
      if (event.type === 'step-started') input = event.input;
      if (event.type === 'step-completed') output = event.output;
      if (event.type === 'step-failed') error = event.error;
    }
    return {
      executionId,
      status: progress?.executions.get(executionId) ?? progress?.status,
      input,
      output: output || buildStepActivityModel(activity).streamedText || undefined,
      error,
      events: activity,
    };
  });
};

const stepIcon = (status: StepProgress['status'] | undefined): ReactNode => {
  switch (status) {
    case 'running':
      return <Loader2 className="size-4 animate-spin text-primary" />;
    case 'completed':
      return <CheckCircle2 className="size-4 text-success" />;
    case 'failed':
      return <XCircle className="size-4 text-destructive" />;
    case 'waiting':
      return <CircleDot className="size-4 text-warning" />;
    default:
      return <Clock className="size-4 text-muted-foreground" />;
  }
};

const stepDetails = ({
  stepId,
  label,
  progress,
  events,
  agents,
}: {
  readonly stepId: string;
  readonly label: string;
  readonly progress: StepProgress | undefined;
  readonly events: ReadonlyArray<WorkflowRunEvent>;
  readonly agents: ReadonlyArray<AgentRecord>;
}): StepDetails => {
  const model = buildStepActivityModel(events.filter(isStepActivityEvent));
  const agent = model.agentId ? agents.find((candidate) => candidate.id === model.agentId) : undefined;
  const runs = stepRuns(events, progress);

  return {
    stepId,
    label,
    status: progress?.status,
    input: progress?.input,
    output: runs.at(-1)?.output ?? progress?.output,
    agentName: agent?.name ?? model.agentId,
    runs,
  };
};

/**
 * The run's main area: the workflow's declared graph with live status on it, or
 * the executed step list. Workflows whose topology LangGraph cannot declare —
 * the functional `entrypoint`/`task` API builds its shape while it runs — only
 * get the list, since a one-node picture would say less than the list does.
 */
function RunCanvas({
  workflow,
  progress,
  events,
  agents,
  declaredSteps,
}: {
  workflow: RegisteredWorkflow | null;
  progress: ReadonlyMap<string, StepProgress>;
  events: ReadonlyArray<WorkflowRunEvent>;
  agents: ReadonlyArray<AgentRecord>;
  declaredSteps: ReadonlyArray<string>;
}) {
  const graph = workflow?.graph;
  const hasGraph = graph !== undefined && workflowGraphHasTopology(graph);
  const [mode, setMode] = useState<'graph' | 'steps'>(hasGraph ? 'graph' : 'steps');
  const [openStep, setOpenStep] = useState<StepDetails | null>(null);

  const runs = useMemo(
    () =>
      new Map<string, StepRunView>(
        [...progress].map(([stepId, step]) => [
          stepId,
          {
            status: step.status,
            executions: step.executions.size,
            running: [...step.executions.values()].filter((status) => status === 'running').length,
          },
        ]),
      ),
    [progress],
  );

  const openStepById = (stepId: string) => {
    const stepProgress = progress.get(stepId);
    setOpenStep(
      stepDetails({
        stepId,
        label: stepProgress?.label ?? stepId,
        progress: stepProgress,
        events: eventsForStepId(events, stepId),
        agents,
      }),
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {hasGraph ? (
        <Tabs
          value={mode}
          onValueChange={(value) => setMode(value === 'graph' ? 'graph' : 'steps')}
          className="shrink-0 px-4 pt-3"
        >
          <TabsList>
            <TabsTrigger value="graph">Graph</TabsTrigger>
            <TabsTrigger value="steps">Steps</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}

      <div className="min-h-0 flex-1">
        {graph && hasGraph && mode === 'graph' ? (
          <WorkflowGraphCanvas graph={graph} progress={runs} onSelectStep={openStepById} />
        ) : (
          <WorkflowRunSteps
            progress={progress}
            events={events}
            agents={agents}
            declaredSteps={declaredSteps}
            onOpenStep={setOpenStep}
          />
        )}
      </div>

      {openStep ? <StepDetailsDialog details={openStep} onClose={() => setOpenStep(null)} /> : null}
    </div>
  );
}

/**
 * Ordered step list for a run: the steps the runtime actually observed, in the
 * order it observed them. Manifest-declared steps that have not run yet appear
 * as `pending`. This is the whole truth for a workflow without a declared
 * graph, and the detail view for one that has it.
 */
function WorkflowRunSteps({
  progress,
  events,
  agents,
  declaredSteps,
  onOpenStep,
}: {
  progress: ReadonlyMap<string, StepProgress>;
  events: ReadonlyArray<WorkflowRunEvent>;
  agents: ReadonlyArray<AgentRecord>;
  declaredSteps: ReadonlyArray<string>;
  onOpenStep: (details: StepDetails) => void;
}) {
  // Execution order, with any declared-but-unrun steps appended so the
  // inspector shows the full expected shape rather than only what has happened.
  const orderedStepIds = useMemo(() => {
    const seen: Array<string> = [];
    for (const event of events) {
      if ('stepId' in event && !seen.includes(event.stepId)) seen.push(event.stepId);
    }
    for (const declared of declaredSteps) {
      if (!seen.includes(declared)) seen.push(declared);
    }
    for (const stepId of progress.keys()) {
      if (!seen.includes(stepId)) seen.push(stepId);
    }
    return seen;
  }, [events, declaredSteps, progress]);

  if (orderedStepIds.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">No steps recorded yet.</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <ol className="space-y-2">
        {orderedStepIds.map((stepId, index) => {
          const stepProgress = progress.get(stepId);
          const details = stepDetails({
            stepId,
            label: stepProgress?.label ?? stepId,
            progress: stepProgress,
            events: eventsForStepId(events, stepId),
            agents,
          });
          const hasDetail =
            details.runs.some((run) => run.events.length > 0) ||
            details.runs.length > 1 ||
            details.input ||
            details.output;

          return (
            <li key={stepId} className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 shrink-0">{stepIcon(details.status)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[10px] text-muted-foreground">{index + 1}</span>
                    <span className="truncate text-sm font-medium">{details.label}</span>
                    {details.status ? <Badge variant="outline">{details.status}</Badge> : null}
                    {details.runs.length > 1 ? <Badge variant="outline">×{details.runs.length}</Badge> : null}
                    {details.agentName ? <Badge variant="secondary">{details.agentName}</Badge> : null}
                  </div>
                  {details.label !== stepId ? (
                    <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{stepId}</div>
                  ) : null}
                  {details.output ? (
                    <MarkdownPreview lines={2} className="mt-2 text-xs text-muted-foreground">
                      {details.output}
                    </MarkdownPreview>
                  ) : null}
                  {stepProgress?.error ? <p className="mt-2 text-xs text-destructive">{stepProgress.error}</p> : null}
                </div>
                {hasDetail ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-6 shrink-0"
                    title="Show step details"
                    onClick={() => onOpenStep(details)}
                  >
                    <Maximize2 className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function StepRunPanel({ run }: { readonly run: StepRunDetails }) {
  return (
    <div className="space-y-4">
      {run.input ? (
        <div className="rounded-lg border border-border bg-muted/20 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Input</div>
          <p className="mt-2 whitespace-pre-wrap text-sm">{run.input}</p>
        </div>
      ) : null}

      {run.events.length > 0 ? <AgentCallTimeline events={run.events} defaultOpen /> : null}

      {run.error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Error</div>
          <p className="mt-2 whitespace-pre-wrap text-sm text-destructive">{run.error}</p>
        </div>
      ) : null}

      {run.output ? (
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Result</div>
          <Markdown className="mt-2 text-sm">{run.output}</Markdown>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A step's runs, the latest open: one for most steps, a round each when a loop
 * comes back to it, a branch each when a fan-out sends to it.
 */
function StepDetailsDialog({ details, onClose }: { readonly details: StepDetails; readonly onClose: () => void }) {
  const [selected, setSelected] = useState(details.runs.length - 1);
  const run = details.runs[selected] ?? details.runs.at(-1);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
      <div
        className="flex max-h-[86vh] w-full max-w-3xl flex-col rounded-xl border border-border bg-card shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{details.label}</h2>
              {details.status ? <Badge variant="outline">{details.status}</Badge> : null}
              {details.runs.length > 1 ? <Badge variant="outline">{details.runs.length} runs</Badge> : null}
            </div>
            <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{details.stepId}</div>
            {details.agentName ? <div className="mt-1 text-xs text-muted-foreground">{details.agentName}</div> : null}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        {details.runs.length > 1 ? (
          <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2">
            {details.runs.map((candidate, index) => (
              <Button
                key={candidate.executionId}
                type="button"
                size="sm"
                variant={index === selected ? 'outline' : 'ghost'}
                className="h-7 gap-1.5 px-2 text-xs"
                onClick={() => setSelected(index)}
              >
                {stepIcon(candidate.status)}
                Run {index + 1}
              </Button>
            ))}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {run ? (
            <StepRunPanel key={run.executionId} run={run} />
          ) : (
            <p className="text-sm text-muted-foreground">This step has not run yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

const eventIcon = (type: WorkflowRunEvent['type']): ReactNode => {
  switch (type) {
    case 'run-started':
    case 'step-started':
      return <Play className="size-3.5 text-primary" />;
    case 'run-completed':
    case 'step-completed':
      return <CheckCircle2 className="size-3.5 text-success" />;
    case 'run-failed':
    case 'step-failed':
      return <XCircle className="size-3.5 text-destructive" />;
    case 'run-canceled':
      return <XCircle className="size-3.5 text-muted-foreground" />;
    case 'step-progress':
      return <CircleDot className="size-3.5 text-muted-foreground" />;
    case 'human-input-requested':
    case 'human-input-resolved':
      return <CircleDot className="size-3.5 text-warning" />;
  }
};

const eventDetail = (event: WorkflowRunEvent): string | null => {
  switch (event.type) {
    case 'run-started':
    case 'step-started':
      return event.input || null;
    case 'run-completed':
    case 'step-completed':
      return event.output || null;
    case 'run-failed':
    case 'step-failed':
      return event.error || null;
    case 'step-progress':
      return event.state;
    case 'human-input-requested':
      return event.description ?? event.title;
    case 'human-input-resolved':
      return event.response;
    default:
      return null;
  }
};

type EventTimelineRow =
  | { readonly kind: 'event'; readonly event: WorkflowRunEvent }
  | {
      readonly kind: 'activity-group';
      readonly key: string;
      readonly stepId: string;
      readonly label: string;
      readonly count: number;
      readonly lastTimestamp: string;
      readonly events: ReadonlyArray<StepActivityEvent>;
    };

const timelineRows = (events: ReadonlyArray<WorkflowRunEvent>): ReadonlyArray<EventTimelineRow> => {
  const rows: EventTimelineRow[] = [];
  const groups = new Map<string, Extract<EventTimelineRow, { kind: 'activity-group' }>>();

  for (const event of events) {
    if (!isStepActivityEvent(event)) {
      rows.push({ kind: 'event', event });
      continue;
    }

    const key = `${event.stepId}:${event.executionId ?? ''}:activity`;
    const existing = groups.get(key);
    if (existing) {
      const next = {
        ...existing,
        count: existing.count + 1,
        lastTimestamp: event.timestamp,
        events: [...existing.events, event],
      };
      groups.set(key, next);
      rows[rows.findIndex((row) => row.kind === 'activity-group' && row.key === key)] = next;
    } else {
      const row = {
        kind: 'activity-group' as const,
        key,
        stepId: event.stepId,
        label: event.label,
        count: 1,
        lastTimestamp: event.timestamp,
        events: [event],
      };
      groups.set(key, row);
      rows.push(row);
    }
  }

  return rows;
};

function RunEventTimeline({ events }: { events: ReadonlyArray<WorkflowRunEvent> }) {
  const rows = useMemo(() => timelineRows(events), [events]);
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-semibold">Events</h3>
        <Badge variant="outline">
          {rows.length} shown / {events.length} raw
        </Badge>
      </div>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">No events recorded yet.</p>
      ) : (
        <ol className="space-y-2">
          {rows.map((row) => {
            if (row.kind === 'activity-group') {
              return (
                <li
                  key={row.key}
                  className="flex items-start gap-3 rounded-md border border-border bg-background p-2.5"
                >
                  <span className="mt-0.5">
                    <CircleDot className="size-3.5 text-primary" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-semibold">step activity</span>
                      <span className="truncate text-xs text-muted-foreground">{row.label}</span>
                      <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[10px]">
                        {row.count} events
                      </Badge>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        {formatTime(row.lastTimestamp)}
                      </span>
                    </div>
                    <div className="mt-2">
                      <AgentCallTimeline events={row.events} defaultOpen />
                    </div>
                  </div>
                </li>
              );
            }

            const detail = eventDetail(row.event);
            const label = 'label' in row.event ? row.event.label : null;
            return (
              <li
                key={row.event.id}
                className="flex items-start gap-3 rounded-md border border-border bg-background p-2.5"
              >
                <span className="mt-0.5">{eventIcon(row.event.type)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold">{row.event.type}</span>
                    {label ? <span className="truncate text-xs text-muted-foreground">{label}</span> : null}
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                      {formatTime(row.event.timestamp)}
                    </span>
                  </div>
                  {detail ? (
                    <MarkdownPreview lines={3} className="mt-1 text-xs text-muted-foreground">
                      {detail}
                    </MarkdownPreview>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function NewRunDialog({
  workflows,
  onClose,
  onStarted,
}: {
  workflows: ReadonlyArray<RegisteredWorkflow>;
  onClose: () => void;
  onStarted: (runId: string) => void;
}) {
  const invalidate = useInvalidate();
  const [workflowId, setWorkflowId] = useState<string>(workflows[0]?.id ?? '');
  const selectedWorkflow = workflows.find((workflow) => workflow.id === workflowId) ?? null;
  const inputContract = selectedWorkflow ? manifestInputContract(selectedWorkflow.manifest) : undefined;
  const [input, setInput] = useState<WorkflowInputFormValue>(() => initialWorkflowInputValue(inputContract));
  const [error, setError] = useState<string | null>(null);
  const startRun = useMutation({
    mutationFn: () => startWorkflowRun(workflowId, workflowInputParts(inputContract, input)),
    onSuccess: async ({ runId }) => {
      await invalidate(queryKeys.workflowRuns);
      onStarted(runId);
    },
    onError: (caught) => setError(toErrorMessage(caught, 'Could not start the run.')),
  });
  const pending = startRun.isPending;

  const selectWorkflow = (nextWorkflowId: string) => {
    const nextWorkflow = workflows.find((workflow) => workflow.id === nextWorkflowId) ?? null;
    setWorkflowId(nextWorkflowId);
    setInput(initialWorkflowInputValue(nextWorkflow ? manifestInputContract(nextWorkflow.manifest) : undefined));
    setError(null);
  };

  const submit = () => {
    if (!workflowId || pending) return;
    setError(null);
    startRun.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg space-y-4 rounded-xl border border-border bg-card p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">New run</h2>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="space-y-2">
          <Label>Workflow</Label>
          <Select
            value={workflowId}
            items={workflows.map((workflow) => ({ value: workflow.id, label: workflow.manifest.name }))}
            onValueChange={selectWorkflow}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a workflow" />
            </SelectTrigger>
            <SelectContent>
              {workflows.map((workflow) => (
                <SelectItem key={workflow.id} value={workflow.id}>
                  {workflow.manifest.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Input</Label>
          <WorkflowInputForm contract={inputContract} value={input} onChange={setInput} />
        </div>

        {error ? <ErrorBanner>{error}</ErrorBanner> : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !workflowId}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            Run
          </Button>
        </div>
      </div>
    </div>
  );
}

type WorkflowInputFormValue = JsonObject;

const INPUT_VALUE_KEY = 'input';

/**
 * A JSON Schema document as the form surfaces read it: the shared JsonSchema
 * view plus `contentMediaType`, which marks a workflow input contract as a file.
 */
type WorkflowJsonSchema = JsonSchema & { readonly contentMediaType?: string };

const parseJsonSchema = (source: string | undefined): WorkflowJsonSchema | undefined => {
  const raw = Option.getOrUndefined(decodeJsonObjectStringOption(source?.trim() ?? ''));
  const document = raw === undefined ? undefined : jsonSchemaDocument(raw);
  if (!document) return undefined;
  const contentMediaType = jsonString(raw, 'contentMediaType')?.trim();
  return contentMediaType ? { ...document, contentMediaType } : document;
};

const schemaTypes = (schema: WorkflowJsonSchema | undefined): ReadonlyArray<string> => {
  const type = schema?.type;
  if (type === undefined) return [];
  return Predicate.isString(type) ? [type] : type;
};

const schemaContentMediaType = (schema: WorkflowJsonSchema | undefined): string | undefined => schema?.contentMediaType;

const workflowInputMode = (contract: InputContract | undefined): 'none' | 'text' | 'data' | 'file' => {
  const schema = parseJsonSchema(contract?.schema);
  if (!schema) return 'none';
  if (schemaContentMediaType(schema)) return 'file';
  const types = schemaTypes(schema);
  return types.length === 1 && types[0] === 'string' ? 'text' : 'data';
};

const initialWorkflowInputValue = (contract: InputContract | undefined): WorkflowInputFormValue => {
  const schema = parseJsonSchema(contract?.schema);
  const mode = workflowInputMode(contract);
  if (mode === 'text') return { [INPUT_VALUE_KEY]: '' };
  if (mode === 'file')
    return { [INPUT_VALUE_KEY]: { uri: '', name: '', mimeType: schemaContentMediaType(schema) ?? '' } };
  if (mode === 'data') return { [INPUT_VALUE_KEY]: schema ? coerceJson(initialValueForSchema(schema, schema)) : {} };
  return {};
};

const workflowInputParts = (
  contract: InputContract | undefined,
  value: WorkflowInputFormValue,
): ReadonlyArray<Part> => {
  const current = value[INPUT_VALUE_KEY];
  const mode = workflowInputMode(contract);
  if (mode === 'none') return [];
  if (mode === 'text') return [{ kind: 'text', text: renderJson(current) }];
  if (mode === 'data') return [{ kind: 'data', data: coerceJsonObject(current) }];

  const file = isJsonObject(current) ? current : {};
  return [
    {
      kind: 'file',
      file: {
        uri: jsonString(file, 'uri')?.trim() ?? '',
        name: jsonString(file, 'name')?.trim() || undefined,
        mimeType: jsonString(file, 'mimeType')?.trim() || undefined,
      },
    },
  ];
};

function WorkflowInputForm({
  contract,
  value,
  onChange,
}: {
  contract: InputContract | undefined;
  value: WorkflowInputFormValue;
  onChange: (value: WorkflowInputFormValue) => void;
}) {
  const setInput = (next: Json) => onChange({ ...value, [INPUT_VALUE_KEY]: next });
  const schema = parseJsonSchema(contract?.schema);
  const mode = workflowInputMode(contract);

  if (mode === 'none') {
    return (
      <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
        This workflow declares no structured input.
      </p>
    );
  }

  if (mode === 'text') {
    return (
      <Textarea
        value={jsonString(value, INPUT_VALUE_KEY) ?? ''}
        onChange={(event) => setInput(event.target.value)}
        placeholder="Text to send to the workflow"
        rows={4}
      />
    );
  }

  if (mode === 'data') {
    return (
      <div className="space-y-1.5 rounded-lg border border-border/70 p-3">
        <JsonSchemaForm
          schema={schema}
          value={value[INPUT_VALUE_KEY]}
          onChange={(next) => setInput(coerceJson(next))}
        />
        {!schema && contract?.schema.trim() ? (
          <p className="text-[11px] text-destructive">Invalid JSON schema; edit the workflow input contract.</p>
        ) : null}
      </div>
    );
  }

  const current = value[INPUT_VALUE_KEY];
  const file = isJsonObject(current) ? current : {};
  const updateFile = (field: string, next: string) => setInput({ ...file, [field]: next });

  return (
    <div className="space-y-2 rounded-lg border border-border/70 p-3">
      <Input
        value={jsonString(file, 'uri') ?? ''}
        onChange={(event) => updateFile('uri', event.target.value)}
        placeholder="File URI"
      />
      <div className="grid grid-cols-2 gap-2">
        <Input
          value={jsonString(file, 'name') ?? ''}
          onChange={(event) => updateFile('name', event.target.value)}
          placeholder="Name"
        />
        <Input
          value={jsonString(file, 'mimeType') ?? ''}
          onChange={(event) => updateFile('mimeType', event.target.value)}
          placeholder={schemaContentMediaType(schema) ?? 'MIME type'}
        />
      </div>
    </div>
  );
}
