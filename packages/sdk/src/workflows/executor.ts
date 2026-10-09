import type { AgentExecutionEvent, AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { BaseCheckpointSaver, BaseStore } from '@langchain/langgraph';
import * as Cause from 'effect/Cause';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import {
  agentDataMessage,
  canceledStatusEvent,
  completedStatusEvent,
  failedStatusEvent,
  inputRequiredStatusEvent,
  messageStatusEvent,
  rejectedStatusEvent,
  responseArtifactEvent,
  submittedTaskEvent,
  workingStatusEvent,
} from '../a2a/events';
import { integrationOverridesOf } from '../a2a/message-parts';
import { randomUUIDv4 } from '../random';
import type { JsonObject, Workflow, WorkflowPendingActionId, WorkflowRun, WorkflowRunEvent } from '../schemas';
import {
  coerceJson,
  decodeJsonStringOption,
  decodeWorkflowA2AEnvelopeOption,
  isJsonObject,
  WorkflowRunEventId,
  workflowA2AEventEnvelope,
  workflowA2AHumanInputRequestEnvelope,
  workflowInputContract,
} from '../schemas';
import type { WorkflowAgentBinding } from './bindings';
import { WorkflowRunStore, type WorkflowRunStoreError } from './run-store';
import { type WorkflowRunError, WorkflowRuntime, WorkflowRuntimeLayer, type WorkflowRuntimeServices } from './runtime';
import { validateTaskInput, workflowInputFromParts } from './task-input';

export type WorkflowTaskExecutorOptions = {
  readonly deployment?: import('../runtime/types').GraphDeployment;
  /**
   * Discharge a run program: provide the {@link WorkflowRunStore} layer and run it
   * on the host's Effect runtime. Bound by the API so the SDK stays free of any
   * persistence/runtime dependency.
   */
  readonly run: <A>(effect: Effect.Effect<A, never, WorkflowRuntimeServices>) => Promise<A>;
  /** Durable checkpointer injected into the graph at invoke time. */
  readonly checkpointer: BaseCheckpointSaver;
  /** Values for the manifest's declared secret names. */
  readonly secrets?: Readonly<Record<string, string>> | undefined;
  /** Long-term store the artifact may compile in. */
  readonly store?: BaseStore | undefined;
  readonly recursionLimit?: number | undefined;
  readonly recover?: boolean;
};

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const causeMessage = (cause: Cause.Cause<unknown>): string => errorMessage(Cause.squash(cause));

const humanInputResponse = (
  requestContext: RequestContext,
): { readonly actionId: WorkflowPendingActionId; readonly response: JsonObject } | undefined => {
  for (const part of requestContext.userMessage.parts) {
    if (part.kind !== 'data') {
      continue;
    }
    const envelope = decodeWorkflowA2AEnvelopeOption(part.data);
    if (Option.isNone(envelope) || envelope.value.type !== 'workflow-human-input-response') {
      continue;
    }
    return { actionId: envelope.value.actionId, response: envelope.value.response };
  }
  return undefined;
};

/**
 * Adapts a code workflow artifact to the a2a `AgentExecutor` interface: input
 * contract validation, durable run creation, then handing off to
 * {@link WorkflowRuntime} which imports and drives the artifact's graph.
 */
export class WorkflowTaskExecutor implements AgentExecutor {
  private readonly canceledTaskIds = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly workflow: Workflow,
    private readonly agents: ReadonlyArray<WorkflowAgentBinding>,
    private readonly options: WorkflowTaskExecutorOptions,
  ) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    this.controllers.set(requestContext.taskId, new AbortController());
    try {
      await this.options.run(this.program(requestContext, eventBus));
    } finally {
      this.controllers.delete(requestContext.taskId);
    }
  }

  async cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    this.canceledTaskIds.add(taskId);
    this.controllers.get(taskId)?.abort();
  }

  private consumeCancellation(taskId: string): boolean {
    if (!this.canceledTaskIds.has(taskId)) {
      return false;
    }

    this.canceledTaskIds.delete(taskId);
    return true;
  }

  /**
   * The whole run as a single Effect: create the run, drive the artifact, and emit
   * a2a status events. Because every event write is sequenced inside this program
   * and `eventBus.finished()` runs via `Effect.ensuring`, the durable run reaches
   * its terminal state before the task is reported complete.
   */
  private program(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Effect.Effect<void, never, WorkflowRuntimeServices> {
    const workflow = this.workflow;
    const agents = this.agents;
    const recovering = this.options.recover;
    const consumeCancellation = (taskId: string): boolean => this.consumeCancellation(taskId);
    const build = <A>(event: Effect.Effect<A>): A => Effect.runSync(event);
    /** Build a status/task event (timestamped off the Clock) and put it on the bus. */
    const publish = <A extends AgentExecutionEvent>(event: Effect.Effect<A>): Effect.Effect<void> =>
      Effect.flatMap(event, (resolved) => Effect.sync(() => eventBus.publish(resolved)));

    const succeed = (
      run: WorkflowRun,
      resume?: {
        readonly actionId: WorkflowPendingActionId;
        readonly stepId: string;
        readonly response: JsonObject;
      },
    ): Effect.Effect<void, WorkflowRunError, WorkflowRuntimeServices> => {
      const runtimeLayer = WorkflowRuntimeLayer({
        workflow,
        runId: run.id,
        agents,
        checkpointer: this.options.checkpointer,
        secrets: this.options.secrets,
        consumeCancellation,
        deployment: this.options.deployment,
        recover: this.options.recover,
        signal: this.controllers.get(requestContext.taskId)?.signal,
        store: this.options.store,
        recursionLimit: this.options.recursionLimit,
        integrations: integrationOverridesOf(requestContext),
      });

      return Effect.gen(function* () {
        const runtime = yield* WorkflowRuntime;
        return yield* runtime.execute({
          request: {
            taskId: requestContext.taskId,
            contextId: requestContext.contextId,
            messageId: requestContext.userMessage.messageId,
          },
          input: run.input,
          onEvent: (event) =>
            eventBus.publish(
              build(
                Effect.flatMap(agentDataMessage(requestContext, workflowA2AEventEnvelope(event)), (message) =>
                  messageStatusEvent(requestContext, message),
                ),
              ),
            ),
          resume,
        });
      }).pipe(
        Effect.provide(runtimeLayer),
        Effect.flatMap((result) =>
          Effect.gen(function* () {
            if (result.status === 'canceled') {
              yield* publish(canceledStatusEvent(requestContext.taskId, requestContext.contextId));
              return;
            }
            if (result.status === 'input-required') {
              const message = yield* agentDataMessage(
                requestContext,
                workflowA2AHumanInputRequestEnvelope(result.inputRequired),
              );
              yield* publish(inputRequiredStatusEvent(requestContext, message));
              return;
            }

            yield* Effect.sync(() =>
              eventBus.publish(responseArtifactEvent(requestContext, workflow.manifest.name, result.text, false, true)),
            );
            yield* publish(completedStatusEvent(requestContext, result.text));
          }),
        ),
      );
    };

    const fail = (run: WorkflowRun, error: string): Effect.Effect<void, WorkflowRunStoreError, WorkflowRunStore> =>
      Effect.gen(function* () {
        const store = yield* WorkflowRunStore;
        const failedEvent: WorkflowRunEvent = {
          id: WorkflowRunEventId.make(yield* randomUUIDv4),
          runId: run.id,
          workflowId: workflow.id,
          taskId: requestContext.taskId,
          timestamp: DateTime.formatIso(yield* DateTime.now),
          type: 'run-failed',
          error,
        };
        yield* store.append(failedEvent);
        const message = yield* agentDataMessage(requestContext, workflowA2AEventEnvelope(failedEvent));
        yield* publish(messageStatusEvent(requestContext, message));
        yield* publish(failedStatusEvent(requestContext, error));
      });

    return Effect.gen(function* () {
      const store = yield* WorkflowRunStore;
      if (!requestContext.task) {
        yield* publish(submittedTaskEvent(requestContext));
      }

      const inputContract = workflowInputContract(workflow);
      const inputParts = requestContext.userMessage.parts.map((part) =>
        part.kind === 'data' ? { kind: 'data' as const, data: coerceJson(part.data) } : part,
      );

      if (recovering) {
        const runs = yield* store.list();
        const existing = runs.find((run) => run.workflowId === workflow.id && run.taskId === requestContext.taskId);
        const hasResponse =
          humanInputResponse(requestContext) !== undefined ||
          requestContext.userMessage.parts.some(
            (part) => part.kind === 'data' && part.data.type === 'input-required-response',
          );
        if (existing && (existing.status !== 'input-required' || !hasResponse)) {
          const events = yield* store.listEvents(existing.id);
          const resolved = events?.findLast((event) => event.type === 'human-input-resolved');
          const responseValue =
            resolved?.type === 'human-input-resolved'
              ? Option.getOrUndefined(decodeJsonStringOption(resolved.response))
              : undefined;
          const continuation =
            resolved?.type === 'human-input-resolved' && isJsonObject(responseValue)
              ? { actionId: resolved.actionId, stepId: resolved.stepId, response: responseValue }
              : undefined;
          yield* succeed(existing, continuation).pipe(
            Effect.catchCause((cause) => fail(existing, causeMessage(cause))),
          );
          return;
        }
      }
      let response = humanInputResponse(requestContext);
      const genericResponse = requestContext.userMessage.parts.find(
        (part) => part.kind === 'data' && part.data.type === 'input-required-response',
      );
      if (!response && genericResponse?.kind === 'data') {
        const waiting = yield* store.getWaitingByTask({
          workflowId: workflow.id,
          taskId: requestContext.taskId,
          contextId: requestContext.contextId,
        });
        if (waiting) {
          const events = yield* store.listEvents(waiting.id);
          const pending = events?.findLast((event) => event.type === 'human-input-requested');
          const value = coerceJson(genericResponse.data.response);
          if (pending?.type === 'human-input-requested')
            response = { actionId: pending.actionId, response: isJsonObject(value) ? value : { value } };
        }
      }
      if (response) {
        const run = yield* store.getWaitingByTask({
          workflowId: workflow.id,
          taskId: requestContext.taskId,
          contextId: requestContext.contextId,
        });
        if (!run) {
          yield* publish(rejectedStatusEvent(requestContext, 'No workflow is waiting for input on this task.'));
          return;
        }
        const history = yield* store.listEvents(run.id);
        const pending = history?.findLast((event) => event.type === 'human-input-requested');
        if (pending?.type !== 'human-input-requested' || pending.actionId !== response.actionId) {
          yield* publish(rejectedStatusEvent(requestContext, 'The input action belongs to another run.'));
          return;
        }
        const resolved = yield* store.resolvePendingAction(response);
        const action = resolved ?? (recovering ? { runId: run.id, stepId: pending.stepId } : null);
        if (!action || action.runId !== run.id) {
          yield* publish(rejectedStatusEvent(requestContext, 'The workflow input action is not pending.'));
          return;
        }
        yield* publish(workingStatusEvent(requestContext));
        yield* succeed(run, { ...response, stepId: action.stepId }).pipe(
          Effect.catchCause((cause) => fail(run, causeMessage(cause))),
        );
        return;
      }

      const issues = validateTaskInput(inputContract, inputParts);
      if (issues.length > 0) {
        yield* publish(
          rejectedStatusEvent(
            requestContext,
            `Task does not match this workflow's input contract: ${issues.join('; ')}`,
          ),
        );
        return;
      }

      yield* publish(workingStatusEvent(requestContext));
      const input = workflowInputFromParts(inputContract, inputParts);
      const run = yield* store.create({
        workflow,
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        input,
      });
      yield* succeed(run).pipe(Effect.catchCause((cause) => fail(run, causeMessage(cause))));
    }).pipe(
      // A run-store write that fails is a recoverable transport failure, not a
      // defect: report it on the task the same way any other run failure is
      // reported rather than letting it escape as a defect from `run`.
      Effect.catchTag('WorkflowRunStoreError', (error) =>
        publish(failedStatusEvent(requestContext, `Workflow run storage failed: ${errorMessage(error)}`)),
      ),
      Effect.ensuring(Effect.sync(() => eventBus.finished())),
    );
  }
}
