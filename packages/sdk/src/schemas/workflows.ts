import * as Schema from 'effect/Schema';
import * as SchemaGetter from 'effect/SchemaGetter';

export * from './workflow-manifest';

import type { InputContract } from './agents';
import { Json, JsonObject } from './json';
import { manifestInputContract, WorkflowManifest } from './workflow-manifest';

export const WorkflowId = Schema.String.pipe(Schema.brand('WorkflowId'));
export const WorkflowRunId = Schema.String.pipe(Schema.brand('WorkflowRunId'));
export const WorkflowRunEventId = Schema.String.pipe(Schema.brand('WorkflowRunEventId'));
export const WorkflowPendingActionId = Schema.String.pipe(Schema.brand('WorkflowPendingActionId'));

const OptionalFromNullOr = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.NullOr(schema)).pipe(
    Schema.decodeTo(Schema.optional(schema), {
      decode: SchemaGetter.transform((value) => (value === null ? undefined : value)),
      encode: SchemaGetter.transform((value) => (value === undefined ? null : value)),
    }),
  );

/**
 * The topology of a registered workflow, captured at registration from the
 * compiled LangGraph's own drawable graph.
 *
 * Only what the graph object declares is recorded — node ids, how they connect,
 * and whether an edge is a branch. Node bodies are never inspected and the
 * artifact's source is never parsed, so the picture cannot claim more than
 * LangGraph itself knows. Workflows built with the functional
 * `entrypoint`/`task` API have no declared topology (it exists only while they
 * run) and therefore come back as a single step; see {@link workflowGraphHasTopology}.
 */
export const WorkflowGraphNodeKind = Schema.Literals([
  /** LangGraph's `START` sentinel. */
  'start',
  /** LangGraph's `END` sentinel. */
  'end',
  /** An executable node; `id` is the name the runtime reports steps under. */
  'step',
  /** An input/output schema placeholder, as the functional API produces. */
  'io',
]);

export type WorkflowGraphNodeKind = Schema.Schema.Type<typeof WorkflowGraphNodeKind>;

export const WorkflowGraphNode = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: WorkflowGraphNodeKind,
  /** Enclosing subgraph path when `xray` expanded one, `:`-separated. */
  group: Schema.NullOr(Schema.String),
});

export type WorkflowGraphNode = Schema.Schema.Type<typeof WorkflowGraphNode>;

export const WorkflowGraphEdge = Schema.Struct({
  source: Schema.String,
  target: Schema.String,
  /** True for edges added by `addConditionalEdges`, drawn as branches. */
  conditional: Schema.Boolean,
  /** The branch key, when it differs from the target node. */
  label: Schema.NullOr(Schema.String),
});

export type WorkflowGraphEdge = Schema.Schema.Type<typeof WorkflowGraphEdge>;

export const WorkflowGraph = Schema.Struct({
  nodes: Schema.Array(WorkflowGraphNode),
  edges: Schema.Array(WorkflowGraphEdge),
});

export type WorkflowGraph = Schema.Schema.Type<typeof WorkflowGraph>;

/**
 * Whether a graph is worth drawing. One step is not a topology — it is what a
 * functional-API workflow, or a workflow registered before graphs were
 * captured, looks like. Callers fall back to the step list.
 */
export const workflowGraphHasTopology = (graph: WorkflowGraph): boolean =>
  graph.nodes.filter((node) => node.kind === 'step').length > 1;

/**
 * Where a manifest's local name resolves to in this deployment: an internal or
 * external agent, a registered workflow, or an integration tool (`id` is the
 * executor tool address).
 */
/** What a manifest name is bound to; for a `model`, `id` is the platform model, `provider:model`. */
export const WorkflowBindingTarget = Schema.Struct({
  kind: Schema.Literals(['agent', 'external', 'workflow', 'tool', 'model']),
  id: Schema.String,
});

export const WorkflowBindings = Schema.Record(Schema.String, WorkflowBindingTarget);

/**
 * The registry row for a deployed artifact. `source` is the immutable,
 * content-addressed artifact folder the host installed; `manifest` is the
 * authored manifest with `input`/`output` filled in from the graph where the
 * author left them out; `bindings` map every manifest agent name to a concrete
 * target chosen at registration.
 */
export const CreateWorkflowInput = Schema.Struct({
  source: Schema.String,
  manifest: WorkflowManifest,
  sourceHash: Schema.String,
  graph: WorkflowGraph,
  bindings: WorkflowBindings,
});

export const Workflow = Schema.Struct({
  id: WorkflowId,
  source: Schema.String,
  manifest: WorkflowManifest,
  sourceHash: Schema.String,
  bindings: WorkflowBindings,
  revision: Schema.Number,
});

/** The workflow plus the topology read off the compiled graph, for the visualizer. */
export const RegisteredWorkflow = Schema.Struct({
  ...Workflow.fields,
  graph: WorkflowGraph,
});

export const UpdateWorkflowInput = CreateWorkflowInput;
export const WorkflowList = Schema.Array(RegisteredWorkflow);

/** One source file of an uploaded artifact; `content` is base64. */
export const WorkflowArtifactFile = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
});

/**
 * Registration payload: the artifact's source files (never `node_modules`),
 * optional explicit bindings for manifest agent names the server cannot
 * resolve by name alone, and the revision the client last saw so a push over
 * someone else's change is rejected instead of silently winning.
 */
export const RegisterWorkflowInput = Schema.Struct({
  files: Schema.Array(WorkflowArtifactFile),
  bindings: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  expectedRevision: Schema.optional(Schema.Number),
});

/** Everything the CLI needs to reconstruct the artifact folder on disk. */
export const WorkflowArtifactDownload = Schema.Struct({
  workflow: RegisteredWorkflow,
  files: Schema.Array(WorkflowArtifactFile),
});

export type WorkflowBindingTarget = Schema.Schema.Type<typeof WorkflowBindingTarget>;
export type WorkflowBindings = Schema.Schema.Type<typeof WorkflowBindings>;
export type WorkflowArtifactFile = Schema.Schema.Type<typeof WorkflowArtifactFile>;
export type RegisterWorkflowInput = Schema.Schema.Type<typeof RegisterWorkflowInput>;
export type WorkflowArtifactDownload = Schema.Schema.Type<typeof WorkflowArtifactDownload>;
export type Workflow = Schema.Schema.Type<typeof Workflow>;
export type RegisteredWorkflow = Schema.Schema.Type<typeof RegisteredWorkflow>;

export const workflowInputContract = (workflow: Workflow): InputContract | undefined =>
  manifestInputContract(workflow.manifest);

export const WorkflowRunStatus = Schema.Literals([
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
]);

export const WorkflowStepRunStatus = Schema.Literals([
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'canceled',
]);

export const WorkflowRunEventData = JsonObject;

const WorkflowRunEventBase = {
  id: WorkflowRunEventId,
  runId: WorkflowRunId,
  workflowId: WorkflowId,
  taskId: Schema.String,
  timestamp: Schema.String,
} as const;

/**
 * Step events carry the step's path in the graph (a LangGraph node or `task()`
 * name; `team:research` for the node `research` of the subgraph node `team`,
 * as the graph view draws it) plus a display label. A step runs once per
 * execution: a loop or a `Send` fan-out runs it again under the same step id,
 * each execution named by `executionId`, LangGraph's task id. There is no step
 * *type*: the runtime cannot know what a step does, and does not need to.
 */
const WorkflowStepEventBase = {
  ...WorkflowRunEventBase,
  stepId: Schema.String,
  label: Schema.String,
  executionId: Schema.optional(Schema.String),
} as const;

export const WorkflowRunStartedEvent = Schema.Struct({
  ...WorkflowRunEventBase,
  type: Schema.Literal('run-started'),
  input: Schema.String,
});

export const WorkflowRunCompletedEvent = Schema.Struct({
  ...WorkflowRunEventBase,
  type: Schema.Literal('run-completed'),
  output: Schema.String,
});

export const WorkflowRunFailedEvent = Schema.Struct({
  ...WorkflowRunEventBase,
  type: Schema.Literal('run-failed'),
  error: Schema.String,
});

export const WorkflowRunCanceledEvent = Schema.Struct({
  ...WorkflowRunEventBase,
  type: Schema.Literal('run-canceled'),
});

export const WorkflowStepStartedEvent = Schema.Struct({
  ...WorkflowStepEventBase,
  type: Schema.Literal('step-started'),
  input: Schema.String,
});

export const WorkflowStepProgressEvent = Schema.Struct({
  ...WorkflowStepEventBase,
  type: Schema.Literal('step-progress'),
  state: Schema.String,
  data: WorkflowRunEventData,
});

export const WorkflowStepCompletedEvent = Schema.Struct({
  ...WorkflowStepEventBase,
  type: Schema.Literal('step-completed'),
  output: Schema.String,
});

export const WorkflowStepFailedEvent = Schema.Struct({
  ...WorkflowStepEventBase,
  type: Schema.Literal('step-failed'),
  error: Schema.String,
});

export const WorkflowHumanInputRequestedEvent = Schema.Struct({
  ...WorkflowStepEventBase,
  type: Schema.Literal('human-input-requested'),
  actionId: WorkflowPendingActionId,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  input: Schema.optional(Json),
  responseSchema: Schema.optional(Schema.String),
  interrupts: Schema.optional(Schema.Array(Json)),
});

export const WorkflowHumanInputResolvedEvent = Schema.Struct({
  ...WorkflowStepEventBase,
  type: Schema.Literal('human-input-resolved'),
  actionId: WorkflowPendingActionId,
  response: Schema.String,
});

export const WorkflowRunEvent = Schema.Union([
  WorkflowRunStartedEvent,
  WorkflowRunCompletedEvent,
  WorkflowRunFailedEvent,
  WorkflowRunCanceledEvent,
  WorkflowStepStartedEvent,
  WorkflowStepProgressEvent,
  WorkflowStepCompletedEvent,
  WorkflowStepFailedEvent,
  WorkflowHumanInputRequestedEvent,
  WorkflowHumanInputResolvedEvent,
]);

export type WorkflowRunEvent = Schema.Schema.Type<typeof WorkflowRunEvent>;

/**
 * Progress states an agent call publishes inside a step. Kept from the graph
 * runtime because the web timeline already renders them and they describe the
 * A2A exchange, not the removed node vocabulary.
 */
export const AgentCallProgressState = {
  Send: 'a2a-send',
  Artifact: 'a2a-artifact',
  Status: 'a2a-status',
  Message: 'a2a-message',
  Task: 'a2a-task',
} as const;
export const AgentCallProgressStatePrefix = 'a2a-';

export const AgentCallProgressStateSchema = Schema.Literals([
  AgentCallProgressState.Send,
  AgentCallProgressState.Artifact,
  AgentCallProgressState.Status,
  AgentCallProgressState.Message,
  AgentCallProgressState.Task,
]);

export type AgentCallProgressState = Schema.Schema.Type<typeof AgentCallProgressStateSchema>;

/** Progress states a bound integration tool publishes inside the step that called it. */
export const ToolCallProgressState = {
  Call: 'tool-call',
  Result: 'tool-result',
  Error: 'tool-error',
} as const;

export type ToolCallProgressState = (typeof ToolCallProgressState)[keyof typeof ToolCallProgressState];

/**
 * Progress states of a bound internal agent's own loop inside the step that
 * called it: each tool call it makes and its outcome, and what its `send_task`
 * subagents report (relayed as they arrive).
 */
export const AgentLoopProgressState = {
  ToolCall: 'agent-tool-call',
  ToolResult: 'agent-tool-result',
  ToolError: 'agent-tool-error',
  Delegation: 'agent-delegation',
} as const;

export type AgentLoopProgressState = (typeof AgentLoopProgressState)[keyof typeof AgentLoopProgressState];

/**
 * One model call made inside a step, by a bound agent (`agentId`) or a bound
 * model (`modelName`): the platform model (`model`), its usage and how many
 * tools it called. What a run cost is the sum of these.
 */
export const ModelCallProgressState = 'model-call';

/** The text a bound model streams, chunk by chunk, inside the step that called it. */
export const ModelTokenProgressState = 'model-token';

export const WorkflowA2AEventEnvelope = Schema.Struct({
  type: Schema.Literal('workflow-event'),
  event: WorkflowRunEvent,
});

export const WorkflowA2AHumanInputResponseEnvelope = Schema.Struct({
  type: Schema.Literal('workflow-human-input-response'),
  actionId: WorkflowPendingActionId,
  response: WorkflowRunEventData,
});

export const WorkflowA2AHumanInputRequestEnvelope = Schema.Struct({
  type: Schema.Literal('workflow-human-input-request'),
  actionId: WorkflowPendingActionId,
  runId: Schema.optionalKey(WorkflowRunId),
  stepId: Schema.String,
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Json),
  responseSchema: Schema.optionalKey(Schema.String),
  interrupts: Schema.optional(Schema.Array(Json)),
});

export const WorkflowA2AToolApprovalRequestEnvelope = Schema.Struct({
  type: Schema.Literal('workflow-tool-approval-request'),
  actionId: WorkflowPendingActionId,
  runId: Schema.optionalKey(WorkflowRunId),
  stepId: Schema.optionalKey(Schema.String),
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  tool: Schema.Struct({
    path: Schema.String,
    args: Json,
  }),
});

export const WorkflowA2AAgentInvocationEnvelope = Schema.Struct({
  type: Schema.Literal('workflow-agent-invocation'),
  workflowId: WorkflowId,
  runId: WorkflowRunId,
  taskId: Schema.String,
  contextId: Schema.String,
  stepId: Schema.String,
});

export const WorkflowA2AEnvelope = Schema.Union([
  WorkflowA2AEventEnvelope,
  WorkflowA2AHumanInputResponseEnvelope,
  WorkflowA2AHumanInputRequestEnvelope,
  WorkflowA2AToolApprovalRequestEnvelope,
  WorkflowA2AAgentInvocationEnvelope,
]);

export type WorkflowA2AEventEnvelope = Schema.Schema.Type<typeof WorkflowA2AEventEnvelope>;
export type WorkflowA2AHumanInputResponseEnvelope = Schema.Schema.Type<typeof WorkflowA2AHumanInputResponseEnvelope>;
export type WorkflowA2AHumanInputRequestEnvelope = Schema.Schema.Type<typeof WorkflowA2AHumanInputRequestEnvelope>;
export type WorkflowA2AToolApprovalRequestEnvelope = Schema.Schema.Type<typeof WorkflowA2AToolApprovalRequestEnvelope>;
export type WorkflowA2AAgentInvocationEnvelope = Schema.Schema.Type<typeof WorkflowA2AAgentInvocationEnvelope>;
export type WorkflowA2AEnvelope = Schema.Schema.Type<typeof WorkflowA2AEnvelope>;

export const decodeWorkflowA2AEnvelopeOption = Schema.decodeUnknownOption(WorkflowA2AEnvelope);

export const workflowA2AEventEnvelope = (event: WorkflowRunEvent): WorkflowA2AEventEnvelope => ({
  type: 'workflow-event',
  event,
});

export const workflowA2AHumanInputRequestEnvelope = (
  input: Omit<WorkflowA2AHumanInputRequestEnvelope, 'type'>,
): WorkflowA2AHumanInputRequestEnvelope => ({
  type: 'workflow-human-input-request',
  ...input,
});

export const workflowA2AToolApprovalRequestEnvelope = (
  input: Omit<WorkflowA2AToolApprovalRequestEnvelope, 'type'>,
): WorkflowA2AToolApprovalRequestEnvelope => ({
  type: 'workflow-tool-approval-request',
  ...input,
});

export const workflowA2AAgentInvocationEnvelope = (
  input: Omit<WorkflowA2AAgentInvocationEnvelope, 'type'>,
): WorkflowA2AAgentInvocationEnvelope => ({
  type: 'workflow-agent-invocation',
  ...input,
});

export type WorkflowRunStepProgress = {
  /** Over the step's executions: failed if any failed, waiting on a person, running while any runs, else completed. */
  readonly status: WorkflowStepRunStatus;
  readonly label: string;
  readonly input?: string | undefined;
  readonly output?: string | undefined;
  readonly error?: string | undefined;
  /** The status of each execution, by execution id, in the order they started: the rounds of a loop, the branches of a fan-out. */
  readonly executions: ReadonlyMap<string, WorkflowStepRunStatus>;
  /** A person's input is pending on the step. */
  readonly waiting: boolean;
};

/** One status for a step that ran several times: the most pressing of its executions. */
const stepStatus = (step: WorkflowRunStepProgress, fallback: WorkflowStepRunStatus): WorkflowStepRunStatus => {
  const statuses = [...step.executions.values()];
  if (statuses.includes('failed')) return 'failed';
  if (step.waiting) return 'waiting';
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('canceled')) return 'canceled';
  return statuses.length === 0 ? fallback : 'completed';
};

/** The execution a step event belongs to; events from before executions had ids share one. */
const executionKey = (event: { readonly executionId?: string | undefined }): string => event.executionId ?? '';

/** How often a step ran, from its events: one execution per distinct execution id that started. */
export const stepExecutions = (events: ReadonlyArray<WorkflowRunEvent>, stepId: string): number =>
  new Set(
    events.flatMap((event) => (event.type === 'step-started' && event.stepId === stepId ? [executionKey(event)] : [])),
  ).size;

export type WorkflowRunProgress = {
  readonly runStatus: WorkflowRunStatus;
  readonly steps: ReadonlyMap<string, WorkflowRunStepProgress>;
};

export const applyRunEvent = (progress: WorkflowRunProgress, event: WorkflowRunEvent): WorkflowRunProgress => {
  let runStatus = progress.runStatus;
  const steps = new Map(progress.steps);

  const current = (stepEvent: Extract<WorkflowRunEvent, { stepId: string }>): WorkflowRunStepProgress =>
    steps.get(stepEvent.stepId) ?? {
      status: 'pending',
      label: stepEvent.label,
      executions: new Map(),
      waiting: false,
    };
  const patch = (
    stepEvent: Extract<WorkflowRunEvent, { stepId: string }>,
    next: Partial<WorkflowRunStepProgress>,
    execution?: WorkflowStepRunStatus,
  ) => {
    const step = { ...current(stepEvent), ...next };
    const executions =
      execution === undefined ? step.executions : new Map(step.executions).set(executionKey(stepEvent), execution);
    const updated = { ...step, executions };
    steps.set(stepEvent.stepId, { ...updated, status: stepStatus(updated, step.status) });
  };

  switch (event.type) {
    case 'run-started':
      runStatus = 'working';
      break;
    case 'run-completed':
      runStatus = 'completed';
      break;
    case 'run-failed':
      runStatus = 'failed';
      break;
    case 'run-canceled':
      runStatus = 'canceled';
      break;
    case 'step-started':
      patch(event, { input: event.input }, 'running');
      break;
    case 'step-completed':
      patch(event, { output: event.output }, 'completed');
      break;
    case 'step-failed':
      patch(event, { error: event.error }, 'failed');
      break;
    case 'human-input-requested':
      runStatus = 'input-required';
      patch(event, { waiting: true, status: 'waiting' });
      break;
    case 'human-input-resolved':
      runStatus = 'working';
      patch(event, { waiting: false, status: 'running' });
      break;
    case 'step-progress':
      break;
  }

  return { runStatus, steps };
};

export const reduceRunStatus = (
  initialRunStatus: WorkflowRunStatus,
  events: ReadonlyArray<WorkflowRunEvent>,
): WorkflowRunStatus =>
  events.reduce<WorkflowRunProgress>((progress, event) => applyRunEvent(progress, event), {
    runStatus: initialRunStatus,
    steps: new Map(),
  }).runStatus;

export const reduceRunProgress = (
  initialRunStatus: WorkflowRunStatus,
  steps: ReadonlyArray<WorkflowStepRun>,
  events: ReadonlyArray<WorkflowRunEvent>,
): WorkflowRunProgress => {
  const initialSteps = new Map<string, WorkflowRunStepProgress>();
  // The rows seed what no event covers; replaying the events counts the executions again.
  for (const step of steps) {
    initialSteps.set(step.stepId, {
      status: step.status,
      label: step.label,
      input: step.input,
      output: step.output,
      error: step.error,
      executions: new Map(),
      waiting: step.status === 'waiting',
    });
  }

  return events.reduce<WorkflowRunProgress>((progress, event) => applyRunEvent(progress, event), {
    runStatus: initialRunStatus,
    steps: initialSteps,
  });
};

export const WorkflowRun = Schema.Struct({
  id: WorkflowRunId,
  workflowId: WorkflowId,
  taskId: Schema.String,
  contextId: OptionalFromNullOr(Schema.String),
  status: WorkflowRunStatus,
  input: Schema.String,
  output: OptionalFromNullOr(Schema.String),
  error: OptionalFromNullOr(Schema.String),
  /** Hash of the entrypoint module actually executed, for drift detection. */
  sourceHash: OptionalFromNullOr(Schema.String),
  startedAt: Schema.String,
  completedAt: OptionalFromNullOr(Schema.String),
});

export const WorkflowStepRun = Schema.Struct({
  runId: WorkflowRunId,
  stepId: Schema.String,
  label: Schema.String,
  status: WorkflowStepRunStatus,
  /** How often the step started in this run. */
  executions: Schema.Number,
  input: OptionalFromNullOr(Schema.String),
  output: OptionalFromNullOr(Schema.String),
  error: OptionalFromNullOr(Schema.String),
  startedAt: OptionalFromNullOr(Schema.String),
  completedAt: OptionalFromNullOr(Schema.String),
  events: Schema.Array(WorkflowRunEvent),
});

export const WorkflowPendingActionStatus = Schema.Literals(['pending', 'resolved', 'canceled', 'expired']);
export const WorkflowPendingAction = Schema.Struct({
  id: WorkflowPendingActionId,
  runId: WorkflowRunId,
  workflowId: WorkflowId,
  taskId: Schema.String,
  contextId: Schema.String,
  stepId: Schema.String,
  kind: Schema.Literal('human-input'),
  status: WorkflowPendingActionStatus,
  request: WorkflowRunEventData,
  response: OptionalFromNullOr(WorkflowRunEventData),
  createdAt: Schema.String,
  resolvedAt: OptionalFromNullOr(Schema.String),
});

export const WorkflowRunSnapshot = Schema.Struct({
  run: WorkflowRun,
  steps: Schema.Array(WorkflowStepRun),
});

export const WorkflowRunList = Schema.Array(WorkflowRun);
export const WorkflowRunEventList = Schema.Array(WorkflowRunEvent);

export const RemoveWorkflowResponse = Schema.Struct({
  removed: Schema.Boolean,
});

export type WorkflowId = Schema.Schema.Type<typeof WorkflowId>;
export type WorkflowRunId = Schema.Schema.Type<typeof WorkflowRunId>;
export type WorkflowRunEventId = Schema.Schema.Type<typeof WorkflowRunEventId>;
export type WorkflowPendingActionId = Schema.Schema.Type<typeof WorkflowPendingActionId>;
export type CreateWorkflowInput = Schema.Schema.Type<typeof CreateWorkflowInput>;
export type UpdateWorkflowInput = Schema.Schema.Type<typeof UpdateWorkflowInput>;
export type RemoveWorkflowResponse = Schema.Schema.Type<typeof RemoveWorkflowResponse>;
export type WorkflowRunStatus = Schema.Schema.Type<typeof WorkflowRunStatus>;
export type WorkflowStepRunStatus = Schema.Schema.Type<typeof WorkflowStepRunStatus>;
export type WorkflowRunEventData = Schema.Schema.Type<typeof WorkflowRunEventData>;
export type WorkflowRun = Schema.Schema.Type<typeof WorkflowRun>;
export type WorkflowStepRun = Schema.Schema.Type<typeof WorkflowStepRun>;
export type WorkflowRunSnapshot = Schema.Schema.Type<typeof WorkflowRunSnapshot>;
export type WorkflowPendingActionStatus = Schema.Schema.Type<typeof WorkflowPendingActionStatus>;
export type WorkflowPendingAction = Schema.Schema.Type<typeof WorkflowPendingAction>;
