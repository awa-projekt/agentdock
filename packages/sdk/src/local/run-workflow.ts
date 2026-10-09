import type { Message, Part, Task, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { DefaultExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { MemorySaver } from '@langchain/langgraph';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import { AgentRunStore, type AgentRunStoreError } from '../agents/run-store';
import { randomUUIDv4 } from '../random';
import type {
  JsonObject,
  Workflow,
  WorkflowA2AHumanInputRequestEnvelope,
  WorkflowA2AHumanInputResponseEnvelope,
  WorkflowRunEvent,
} from '../schemas';
import {
  decodeJsonObjectStringOption,
  decodeWorkflowA2AEnvelopeOption,
  WorkflowId,
  workflowInputContract,
} from '../schemas';
import type { AgentRunRecord } from '../schemas/agent-runs';
import { dataFromMessage, textFromMessage } from '../workflows/agent-invoker';
import type { WorkflowAgentBinding } from '../workflows/bindings';
import { WorkflowTaskExecutor } from '../workflows/executor';
import { extractWorkflowContracts } from '../workflows/graph';
import { hostRunner } from '../workflows/host-runner';
import {
  importWorkflowGraph,
  type LoadedWorkflowManifest,
  loadWorkflowManifest,
  type WorkflowArtifactError,
} from '../workflows/load';
import type { WorkflowRuntimeServices } from '../workflows/runtime';
import { workflowInputMode } from '../workflows/task-input';

export type RunWorkflowLocallyOptions = {
  /** Path to the artifact folder, or an already loaded manifest. */
  readonly artifact: string | LoadedWorkflowManifest;
  /** Bindings for the manifest's agent and workflow names, built by the caller. */
  readonly bindings: ReadonlyArray<WorkflowAgentBinding>;
  readonly secrets?: Readonly<Record<string, string>> | undefined;
  readonly input: string;
  /** Called synchronously as each durable `WorkflowRunEvent` is emitted. */
  readonly onEvent?: (event: WorkflowRunEvent) => void;
  /**
   * Answers an `interrupt()` so the run resumes in-process. Returning `undefined`
   * leaves the run waiting and ends with status `input-required`.
   */
  readonly onInputRequired?: (request: WorkflowA2AHumanInputRequestEnvelope) => Effect.Effect<JsonObject | undefined>;
};

export type LocalWorkflowRunStatus = 'completed' | 'failed' | 'rejected' | 'canceled' | 'input-required';

export type RunWorkflowLocallyResult = {
  readonly status: LocalWorkflowRunStatus;
  readonly text: string;
  /** The unanswered interrupt when `status` is `input-required`. */
  readonly pending?: WorkflowA2AHumanInputRequestEnvelope;
  /** Every bound agent call this run made, individually inspectable. */
  readonly agentRuns: ReadonlyArray<AgentRunRecord>;
  readonly runEvents: ReadonlyArray<WorkflowRunEvent>;
};

/** The a2a user message a workflow's input contract expects: a data part for JSON input contracts, text otherwise. */
export const workflowUserMessage = (workflow: Workflow, input: string): Effect.Effect<Message> =>
  Effect.map(randomUUIDv4, (messageId) => {
    const mode = workflowInputMode(workflowInputContract(workflow));
    const data = Option.getOrElse(decodeJsonObjectStringOption(input), () => ({ input }));
    const parts: ReadonlyArray<Part> = mode === 'data' ? [{ kind: 'data', data }] : [{ kind: 'text', text: input }];
    return { kind: 'message', messageId, role: 'user', parts: [...parts] };
  });

const humanInputRequest = (event: TaskStatusUpdateEvent): WorkflowA2AHumanInputRequestEnvelope | undefined => {
  const envelope = Option.getOrUndefined(decodeWorkflowA2AEnvelopeOption(dataFromMessage(event.status.message)));
  return envelope?.type === 'workflow-human-input-request' ? envelope : undefined;
};

const statusToResult = (state: TaskStatusUpdateEvent['status']['state']): LocalWorkflowRunStatus => {
  switch (state) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'rejected':
      return 'rejected';
    case 'canceled':
      return 'canceled';
    default:
      return 'input-required';
  }
};

/**
 * A registry-shaped record for an artifact that was never registered anywhere,
 * with input/output contracts filled in from the graph the way registration does.
 */
const localWorkflowRecord = (loaded: LoadedWorkflowManifest): Effect.Effect<Workflow, WorkflowArtifactError> =>
  Effect.map(importWorkflowGraph(loaded), (compiled) => {
    const contracts = extractWorkflowContracts(compiled);
    const input = loaded.manifest.input ?? contracts.input;
    const output = loaded.manifest.output ?? contracts.output;
    return {
      id: WorkflowId.make(`local:${loaded.manifest.name}`),
      source: loaded.folder,
      manifest: { ...loaded.manifest, input, output },
      sourceHash: loaded.sourceHash,
      bindings: {},
      revision: 0,
    };
  });

/**
 * Runs an artifact in-process the way the platform would, with an in-memory
 * checkpointer and whatever bindings the caller supplies. Interrupts are answered
 * through `onInputRequired` on the same task, so the graph resumes from its
 * checkpoint exactly as a resumed a2a task does. This is what the CLI's `run`
 * command is built on.
 */
export const runWorkflowLocally = (
  options: RunWorkflowLocallyOptions,
): Effect.Effect<RunWorkflowLocallyResult, AgentRunStoreError | WorkflowArtifactError, WorkflowRuntimeServices> =>
  Effect.gen(function* () {
    const loaded = Predicate.isString(options.artifact)
      ? yield* loadWorkflowManifest(options.artifact)
      : options.artifact;
    const workflow = yield* localWorkflowRecord(loaded);
    const runEvents: Array<WorkflowRunEvent> = [];
    const statusEvents: Array<TaskStatusUpdateEvent> = [];
    const taskId = yield* randomUUIDv4;
    const contextId = yield* randomUUIDv4;

    const eventBus = new DefaultExecutionEventBus();
    eventBus.on('event', (event) => {
      if (event.kind !== 'status-update') return;
      statusEvents.push(event);
      const envelope = Option.getOrUndefined(decodeWorkflowA2AEnvelopeOption(dataFromMessage(event.status.message)));
      if (envelope?.type === 'workflow-event') {
        runEvents.push(envelope.event);
        options.onEvent?.(envelope.event);
      }
    });

    const host = yield* hostRunner<WorkflowRuntimeServices>();
    const executor = new WorkflowTaskExecutor(workflow, options.bindings, {
      checkpointer: new MemorySaver(),
      secrets: options.secrets,
      run: host.runPromise,
    });

    const execute = (userMessage: Message, task: Task | undefined) =>
      Effect.promise(() => executor.execute(new RequestContext(userMessage, taskId, contextId, task), eventBus));

    yield* execute(yield* workflowUserMessage(workflow, options.input), undefined);

    const outcome = (from: number) => {
      const events = statusEvents.slice(from);
      const last = events.findLast((event) => event.final) ?? events.at(-1) ?? statusEvents.at(-1);
      const pending = last?.status.state === 'input-required' ? humanInputRequest(last) : undefined;
      return { last, pending };
    };

    let { last, pending } = outcome(0);
    while (last !== undefined && pending !== undefined && options.onInputRequired !== undefined) {
      const response = yield* options.onInputRequired(pending);
      if (response === undefined) break;
      const waiting: Task = { kind: 'task', id: taskId, contextId, status: last.status };
      const envelope: WorkflowA2AHumanInputResponseEnvelope = {
        type: 'workflow-human-input-response',
        actionId: pending.actionId,
        response,
      };
      const answer: Message = {
        kind: 'message',
        messageId: yield* randomUUIDv4,
        role: 'user',
        taskId,
        contextId,
        parts: [{ kind: 'data', data: envelope }],
      };
      const seen = statusEvents.length;
      yield* execute(answer, waiting);
      ({ last, pending } = outcome(seen));
    }

    const status = last ? statusToResult(last.status.state) : 'failed';
    const text = last ? textFromMessage(last.status.message) : '';

    const workflowRunId = runEvents[0]?.runId;
    const agentRunStore = yield* AgentRunStore;
    const agentRuns = workflowRunId ? yield* agentRunStore.listByWorkflowRun(workflowRunId) : [];

    const result: RunWorkflowLocallyResult = { status, text, agentRuns, runEvents };
    return pending === undefined ? result : { ...result, pending };
  });
