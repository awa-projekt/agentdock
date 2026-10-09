import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import { randomUUIDv4 } from '../random';
import type { Json, JsonObject, Workflow, WorkflowPendingActionId, WorkflowRunEvent, WorkflowRunId } from '../schemas';
import { WorkflowRunEventId as WorkflowRunEventIdSchema } from '../schemas';
import { WorkflowRunStore, type WorkflowRunStoreError } from './run-store';

/**
 * Everything the runtime knows about a single run, shared by the event
 * publishers and the agent invoker. Distinct from the artifact-facing
 * `WorkflowContext`: this side holds host machinery that workflow code has no
 * business touching.
 */
export type WorkflowRunContext = {
  readonly workflow: Workflow;
  readonly runId: WorkflowRunId;
  readonly taskId: string;
  readonly contextId: string;
  readonly emit: (event: WorkflowRunEvent) => void;
  readonly consumeCancellation: (taskId: string) => boolean;
};

/** Event construction is effectful so ids and timestamps follow the active Random and Clock. */
const eventBase = (context: WorkflowRunContext) =>
  Effect.gen(function* () {
    const id = yield* randomUUIDv4;
    const time = yield* DateTime.now;
    return {
      id: WorkflowRunEventIdSchema.make(id),
      runId: context.runId,
      workflowId: context.workflow.id,
      taskId: context.taskId,
      timestamp: DateTime.formatIso(time),
    };
  });

/**
 * A step as the run knows it: its path in the graph, and the execution in
 * progress when the step runs more than once (a loop, a `Send` fan-out).
 */
export type StepRef = {
  readonly stepId: string;
  readonly executionId?: string | undefined;
};

const stepBase = (context: WorkflowRunContext, step: StepRef) =>
  Effect.map(eventBase(context), (base) => {
    const event = { ...base, stepId: step.stepId, label: step.stepId };
    return step.executionId === undefined ? event : { ...event, executionId: step.executionId };
  });

/**
 * Persist a workflow event durably, then emit the raw event to the host. The
 * durable write is awaited first, so a protocol adapter reacting to the event
 * always finds the row already persisted.
 */
export const publishWorkflowEvent = (
  context: WorkflowRunContext,
  makeEvent: Effect.Effect<WorkflowRunEvent>,
): Effect.Effect<void, WorkflowRunStoreError, WorkflowRunStore> =>
  Effect.gen(function* () {
    const event = yield* makeEvent;
    const store = yield* WorkflowRunStore;
    yield* store.append(event);
    yield* Effect.sync(() => context.emit(event));
  });

export const runStartedEvent = (context: WorkflowRunContext, input: string): Effect.Effect<WorkflowRunEvent> =>
  Effect.map(eventBase(context), (base) => ({ ...base, type: 'run-started', input }));

export const runCompletedEvent = (context: WorkflowRunContext, output: string): Effect.Effect<WorkflowRunEvent> =>
  Effect.map(eventBase(context), (base) => ({ ...base, type: 'run-completed', output }));

export const runCanceledEvent = (context: WorkflowRunContext): Effect.Effect<WorkflowRunEvent> =>
  Effect.map(eventBase(context), (base) => ({ ...base, type: 'run-canceled' }));

export const stepStartedEvent = (
  context: WorkflowRunContext,
  step: StepRef,
  input: string,
): Effect.Effect<WorkflowRunEvent> =>
  Effect.map(stepBase(context, step), (base) => ({ ...base, type: 'step-started', input }));

export const stepCompletedEvent = (
  context: WorkflowRunContext,
  step: StepRef,
  output: string,
): Effect.Effect<WorkflowRunEvent> =>
  Effect.map(stepBase(context, step), (base) => ({ ...base, type: 'step-completed', output }));

export const stepFailedEvent = (
  context: WorkflowRunContext,
  step: StepRef,
  error: string,
): Effect.Effect<WorkflowRunEvent> =>
  Effect.map(stepBase(context, step), (base) => ({ ...base, type: 'step-failed', error }));

export const stepProgressEvent = (
  context: WorkflowRunContext,
  step: StepRef,
  state: string,
  data: JsonObject,
): Effect.Effect<WorkflowRunEvent> =>
  Effect.map(stepBase(context, step), (base) => ({ ...base, type: 'step-progress', state, data }));

export const humanInputRequestedEvent = (
  context: WorkflowRunContext,
  step: StepRef,
  options: {
    readonly actionId: WorkflowPendingActionId;
    readonly title: string;
    readonly description?: string;
    readonly input?: Json;
    readonly responseSchema?: string;
    readonly interrupts?: ReadonlyArray<Json>;
  },
): Effect.Effect<WorkflowRunEvent> =>
  Effect.map(stepBase(context, step), (base) => {
    const requested = {
      ...base,
      type: 'human-input-requested',
      actionId: options.actionId,
      title: options.title,
    } as const;
    const described = options.description ? { ...requested, description: options.description } : requested;
    const withInput = options.input === undefined ? described : { ...described, input: options.input };
    const withSchema = options.responseSchema ? { ...withInput, responseSchema: options.responseSchema } : withInput;
    return options.interrupts ? { ...withSchema, interrupts: options.interrupts } : withSchema;
  });

export const humanInputResolvedEvent = (
  context: WorkflowRunContext,
  step: StepRef,
  actionId: WorkflowPendingActionId,
  response: string,
): Effect.Effect<WorkflowRunEvent> =>
  Effect.map(stepBase(context, step), (base) => ({ ...base, type: 'human-input-resolved', actionId, response }));

/** Publish a progress event inside a step. */
export const publishStepProgress = (
  context: WorkflowRunContext,
  step: StepRef,
  state: string,
  data: JsonObject,
): Effect.Effect<void, WorkflowRunStoreError, WorkflowRunStore> =>
  publishWorkflowEvent(context, stepProgressEvent(context, step, state, data));

export const consumeCancellation = (context: WorkflowRunContext): Effect.Effect<boolean> =>
  Effect.sync(() => context.consumeCancellation(context.taskId));
