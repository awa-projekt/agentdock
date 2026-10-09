import { type BaseCheckpointSaver, type BaseStore, Command, getConfig } from '@langchain/langgraph';
import * as Context from 'effect/Context';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import type * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import type { AgentLoopFactory } from '../agents/loop';
import type { ModelProvider } from '../agents/model-provider';
import type { AgentRunStore } from '../agents/run-store';
import type { AgentToolResolver } from '../agents/tool-resolver';
import { randomUUIDv4 } from '../random';
import { graphThreadId } from '../runtime/types';
import type {
  IntegrationOverrides,
  Json,
  JsonObject,
  Workflow,
  WorkflowPendingActionId,
  WorkflowRunId,
} from '../schemas';
import {
  coerceJson,
  decodeJsonStringOption,
  isJsonObject,
  isJsonString,
  jsonProperty,
  jsonString,
  renderJson,
  WorkflowPendingActionId as WorkflowPendingActionIdSchema,
} from '../schemas';
import type { AgentInvokerServices } from './agent-invoker';
import { buildWorkflowContext, resolveBoundModels, type WorkflowAgentBinding } from './bindings';
import {
  CHECKPOINTER_CONFIG_KEY,
  INTERRUPT_CHUNK_KEY,
  type WorkflowStreamChunk,
  type WorkflowStreamOptions,
} from './context';
import {
  consumeCancellation,
  humanInputRequestedEvent,
  humanInputResolvedEvent,
  publishWorkflowEvent,
  runCanceledEvent,
  runCompletedEvent,
  runStartedEvent,
  type StepRef,
  stepCompletedEvent,
  stepFailedEvent,
  stepProgressEvent,
  stepStartedEvent,
  type WorkflowRunContext,
} from './events';
import { extractWorkflowGraph } from './graph';
import { hostRunner } from './host-runner';
import { importWorkflowGraph, loadWorkflowManifest } from './load';
import { WorkflowRunStore, type WorkflowRunStoreError } from './run-store';
import { checkpointSegments, enclosingSteps, namespaceSegments, stepOfSegments, stepPath } from './step-paths';
import type { WorkflowToolInvoker } from './tool-invoker';

export type WorkflowInputRequired = {
  readonly actionId: WorkflowPendingActionId;
  readonly runId: WorkflowRunId;
  readonly stepId: string;
  readonly title: string;
  readonly description?: string;
  readonly input?: Json;
  readonly responseSchema?: string;
  readonly interrupts: ReadonlyArray<Json>;
};

export type WorkflowRunResult =
  | { readonly status: 'completed'; readonly text: string }
  | { readonly status: 'canceled'; readonly text: '' }
  | { readonly status: 'input-required'; readonly text: ''; readonly inputRequired: WorkflowInputRequired };

export class WorkflowExecutionError extends Schema.TaggedError<WorkflowExecutionError>()('WorkflowExecutionError', {
  message: Schema.String,
  error: Schema.Defect(),
}) {}

export type WorkflowRuntimeOptions = {
  readonly deployment?: import('../runtime/types').GraphDeployment | undefined;
  readonly workflow: Workflow;
  readonly runId: WorkflowRunId;
  /** Resolved bindings for the manifest's agent and workflow names. */
  readonly agents: ReadonlyArray<WorkflowAgentBinding>;
  /** Values for the manifest's declared secret names. */
  readonly secrets?: Readonly<Record<string, string>> | undefined;
  /** Durable checkpointer injected into the graph at invoke time. */
  readonly checkpointer: BaseCheckpointSaver;
  readonly store?: BaseStore | undefined;
  readonly consumeCancellation: (taskId: string) => boolean;
  /** Recursion ceiling for the driven graph; guards runaway loops. */
  readonly recursionLimit?: number | undefined;
  readonly recover?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Isolates checkpoints owned by independent protocol adapters. */
  readonly threadNamespace?: string | undefined;
  /** Integrations the run reaches somewhere else than registered, for its bound agents and tools. */
  readonly integrations?: IntegrationOverrides | undefined;
};

export type WorkflowResume = {
  readonly actionId: WorkflowPendingActionId;
  readonly stepId: string;
  readonly response: JsonObject;
};

export type ExecuteWorkflowOptions = {
  readonly request: {
    readonly taskId: string;
    readonly contextId: string;
    readonly messageId: string;
  };
  readonly input: string;
  readonly onEvent?: ((event: import('../schemas').WorkflowRunEvent) => void) | undefined;
  readonly resume?: WorkflowResume | undefined;
};

type WorkflowRuntimeService = {
  readonly execute: (
    options: ExecuteWorkflowOptions,
  ) => Effect.Effect<WorkflowRunResult, WorkflowRunError, WorkflowRuntimeServices>;
};

/** Everything that can end a workflow run short of a defect. */
export type WorkflowRunError = WorkflowExecutionError | WorkflowRunStoreError;

export type WorkflowRuntimeServices =
  | HttpClient.HttpClient
  | WorkflowRunStore
  | AgentLoopFactory
  | ModelProvider
  | AgentToolResolver
  | AgentRunStore
  | WorkflowToolInvoker;

export const WorkflowRuntime = Context.Service<WorkflowRuntimeService>('@agentdock/sdk/workflows/WorkflowRuntime');

const DEFAULT_RECURSION_LIMIT = 100;

/** Task input reaches the graph as parsed JSON when it is JSON, else as text. */
const parseInput = (input: string): Json => (input ? Option.getOrElse(decodeJsonStringOption(input), () => input) : '');

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** The namespace of the task running the calling code, read from LangGraph's own runnable config. */
const checkpointNamespaceOfCaller = (): string | undefined => {
  try {
    const namespace = getConfig()?.metadata?.checkpoint_ns;
    return Predicate.isString(namespace) ? namespace : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A `tasks`-mode chunk is either a task creation (`input`/`triggers` present) or
 * a task result (`result` present). Distinguishing them is what gives steps a
 * start and an end without the artifact reporting anything itself.
 */
const taskChunkKind = (payload: Json | undefined): 'create' | 'result' | 'unknown' => {
  if (!isJsonObject(payload)) return 'unknown';
  if ('result' in payload) return 'result';
  if ('triggers' in payload || 'input' in payload) return 'create';
  return 'unknown';
};

const interruptRequest = (payload: Json | undefined): JsonObject | undefined => {
  const interrupts = jsonProperty(payload, INTERRUPT_CHUNK_KEY) ?? jsonProperty(payload, 'interrupts');
  const first = Array.isArray(interrupts) ? interrupts[0] : undefined;
  if (!first) return undefined;
  const value = jsonProperty(first, 'value');
  return {
    ...(isJsonObject(value) ? value : { title: String(value ?? 'Input required') }),
    interrupts: interrupts ?? [],
  };
};

/**
 * `values` mode yields the whole graph state; the declared output schema says
 * which keys the workflow actually returns.
 */
const renderOutput = (outputSchema: JsonObject | undefined, value: Json): string => {
  if (isJsonString(value)) return value;
  const properties = outputSchema ? jsonProperty(outputSchema, 'properties') : undefined;
  if (!isJsonObject(value) || !isJsonObject(properties)) return renderJson(value);
  const output: Record<string, Json> = {};
  for (const key of Object.keys(properties)) {
    const field = value[key];
    if (field !== undefined) output[key] = field;
  }
  return renderJson(output);
};

export const WorkflowRuntimeLayer = (
  options: WorkflowRuntimeOptions,
): Layer.Layer<Context.Service.Identifier<typeof WorkflowRuntime>> =>
  Layer.succeed(
    WorkflowRuntime,
    WorkflowRuntime.of({
      execute: (executeOptions) => executeWorkflow(options, executeOptions),
    }),
  );

const executeWorkflow = (
  options: WorkflowRuntimeOptions,
  { request, input, resume, onEvent }: ExecuteWorkflowOptions,
): Effect.Effect<WorkflowRunResult, WorkflowRunError, WorkflowRuntimeServices> =>
  Effect.gen(function* () {
    const context: WorkflowRunContext = {
      workflow: options.workflow,
      runId: options.runId,
      taskId: request.taskId,
      contextId: request.contextId,
      emit: onEvent ?? (() => {}),
      consumeCancellation: options.consumeCancellation,
    };

    const store = yield* WorkflowRunStore;
    // Captured so the plain-promise runnables handed to the graph can discharge
    // Effects on the host runtime without the artifact knowing Effect exists.
    const host = yield* hostRunner<AgentInvokerServices>();
    const runEffect = host.runPromise;

    const loaded = yield* loadWorkflowManifest(options.workflow.source).pipe(
      Effect.mapError((error) => new WorkflowExecutionError({ message: error.message, error })),
    );
    if (loaded.sourceHash !== options.workflow.sourceHash)
      return yield* new WorkflowExecutionError({
        message: 'Workflow artifact digest mismatch. Redeploy changed sources before executing.',
        error: null,
      });

    // A step is a node the graph view draws (its id is the step's path, so a
    // node inside a subgraph node is a step of its own), a subgraph node it
    // draws as the frame around its nodes, or, for graphs that draw nothing
    // (the functional API), a node the run executed at the top.
    let drawnSteps: ReadonlySet<string> = new Set();
    const topLevelSteps = new Set<string>();
    const isStep = (path: string): boolean => drawnSteps.has(path) || topLevelSteps.has(path);

    // The functional API schedules its tasks at the top: code in a task runs
    // under `<entrypoint>:…|<task>:…`, and the task is the step.
    let functional = false;

    // Fallback attribution for calls made outside any task, and for the
    // interrupt handling below which runs after the stream has moved on.
    let lastObservedStep: StepRef = { stepId: 'workflow' };
    // A bound agent or tool call belongs to the step whose code made it, read
    // from LangGraph's runnable config rather than off the event stream,
    // because the stream lags execution: only what is known before the run
    // (the drawn steps) can be consulted here.
    const stepOfNamespace = (namespace: string | undefined): StepRef => {
      if (namespace === undefined) return lastObservedStep;
      const segments = checkpointSegments(namespace);
      if (functional) {
        const task = segments[1] ?? segments[0];
        return task === undefined ? lastObservedStep : { stepId: task.name, executionId: task.taskId };
      }
      return stepOfSegments(segments, (path) => drawnSteps.has(path)) ?? lastObservedStep;
    };
    const currentStep = (): StepRef => stepOfNamespace(checkpointNamespaceOfCaller());

    const abortController = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, abortController.signal]) : abortController.signal;

    const models = yield* resolveBoundModels(options.agents).pipe(
      Effect.mapError(
        (error) => new WorkflowExecutionError({ message: `A bound model is unavailable: ${error.message}`, error }),
      ),
    );
    const workflowContext = buildWorkflowContext({
      bindings: options.agents,
      models,
      run: {
        workflowId: options.workflow.id,
        runId: options.runId,
        taskId: request.taskId,
        contextId: request.contextId,
      },
      secrets: options.secrets ?? {},
      runContext: context,
      requestMessageId: request.messageId,
      deployment: options.deployment,
      integrations: options.integrations,
      currentStep,
      stepOfNamespace,
      runEffect,
    });

    const compiled = yield* importWorkflowGraph(loaded, { context: workflowContext }).pipe(
      Effect.mapError((error) => new WorkflowExecutionError({ message: error.message, error })),
    );
    // The same topology registration stored for the graph view; a graph that
    // cannot describe itself still runs, with its top-level nodes as steps.
    functional = compiled.builder === undefined;
    const topology = yield* Effect.option(extractWorkflowGraph(compiled, options.workflow.manifest.name));
    drawnSteps = new Set(
      Option.match(topology, {
        onNone: () => [],
        onSome: (graph) =>
          graph.nodes.flatMap((node) => [...(node.kind === 'step' ? [node.id] : []), ...enclosingSteps(node.group)]),
      }),
    );

    if (resume) {
      yield* publishWorkflowEvent(
        context,
        humanInputResolvedEvent(context, { stepId: resume.stepId }, resume.actionId, renderJson(resume.response)),
      );
    } else {
      yield* publishWorkflowEvent(context, runStartedEvent(context, input));
    }

    const threadId = graphThreadId(options.threadNamespace ?? `workflow:${options.workflow.id}`, request.taskId);
    const checkpoint = options.recover
      ? yield* Effect.promise(() => options.checkpointer.getTuple({ configurable: { thread_id: threadId } }))
      : undefined;
    const requestInput =
      checkpoint && jsonProperty(coerceJson(checkpoint.metadata), 'request_id') === request.messageId
        ? null
        : resume
          ? new Command({ resume: resume.response })
          : parseInput(input);

    // One thread per runtime task, so a resumed task rejoins its own checkpoint.
    const streamOptions: WorkflowStreamOptions = {
      configurable: { thread_id: threadId, [CHECKPOINTER_CONFIG_KEY]: options.checkpointer },
      context: workflowContext,
      streamMode: ['tasks', 'updates', 'custom', 'values'],
      subgraphs: true,
      metadata: { request_id: request.messageId },
      durability: 'sync' as const,
      recursionLimit: options.recursionLimit ?? DEFAULT_RECURSION_LIMIT,
      signal,
    };

    type DriveOutcome =
      | { readonly kind: 'completed'; readonly text: string }
      | { readonly kind: 'canceled' }
      | { readonly kind: 'interrupted'; readonly step: StepRef; readonly request: JsonObject }
      | { readonly kind: 'failed'; readonly step: StepRef; readonly error: string };

    const drive = Effect.tryPromise({
      try: async (): Promise<DriveOutcome> => {
        let lastOutput: Json = '';
        // Steps whose result arrived; a step the `updates` stream names that
        // never showed up in `tasks` (some functional-API shapes) is backfilled.
        const finishedSteps = new Set<string>();
        // The innermost step whose result carried the interrupt: the step the person answers for.
        let interruptedStep: StepRef | undefined;
        let pendingRequest: JsonObject | undefined;
        const pendingInterrupts = new Map<string, Json>();
        const rememberInterrupts = (request: JsonObject) => {
          for (const item of Array.isArray(request.interrupts) ? request.interrupts : []) {
            pendingInterrupts.set(jsonString(item, 'id') ?? JSON.stringify(item), item);
          }
          pendingRequest = { ...request, interrupts: [...pendingInterrupts.values()] };
        };

        const finishStep = async (step: StepRef, output: Json): Promise<void> => {
          finishedSteps.add(step.stepId);
          await runEffect(publishWorkflowEvent(context, stepCompletedEvent(context, step, renderJson(output))));
        };
        const progress = async (step: StepRef, data: JsonObject): Promise<void> => {
          await runEffect(publishWorkflowEvent(context, stepProgressEvent(context, step, 'progress', data)));
        };

        let stream: AsyncIterable<WorkflowStreamChunk>;
        try {
          // SAFETY: `CompiledWorkflow.stream` is the structural subset of
          // LangGraph's `Pregel#stream` the runtime drives; the cast narrows
          // the library's heavily-generic overloads to that subset.
          stream = (await compiled.stream(
            requestInput as never,
            streamOptions as never,
          )) as AsyncIterable<WorkflowStreamChunk>;
        } catch (error) {
          if (signal.aborted) return { kind: 'canceled' };
          return { kind: 'failed', step: lastObservedStep, error: errorMessage(error) };
        }

        try {
          for await (const chunk of stream) {
            if (await runEffect(consumeCancellation(context))) {
              abortController.abort();
              return { kind: 'canceled' };
            }

            const namespace = chunk.length === 3 ? chunk[0] : [];
            const mode = chunk.length === 3 ? chunk[1] : chunk[0];
            const rawPayload = chunk.length === 3 ? chunk[2] : chunk[1];
            const segments = namespaceSegments(namespace);

            // LangGraph chunks carry whatever the artifact's graph produced, so a
            // payload holding something unrepresentable (a class instance, a
            // function) is dropped rather than failing the run over one event.
            let payload: Json | undefined;
            try {
              payload = coerceJson(rawPayload);
            } catch {
              payload = undefined;
            }

            if (mode === 'custom') {
              const step = segments.length === 0 ? undefined : stepOfSegments(segments, isStep);
              await progress(step ?? lastObservedStep, isJsonObject(payload) ? payload : { value: payload ?? null });
              continue;
            }

            if (mode === 'tasks') {
              const nodeName = jsonString(payload, 'name');
              if (!nodeName || payload === undefined) continue;
              const path = stepPath([...segments, { name: nodeName, taskId: undefined }]);
              const kind = taskChunkKind(payload);
              if (segments.length === 0) topLevelSteps.add(nodeName);

              // A task inside a subgraph the graph view does not draw (a bound
              // agent's model and tool calls, a child workflow's nodes) is
              // detail of the step it runs in, not a step of this workflow. Its
              // result stays out: a bound agent's would repeat its whole
              // conversation per task, which its own activity already reports.
              if (segments.length > 0 && !drawnSteps.has(path)) {
                const parent = stepOfSegments(segments, isStep) ?? lastObservedStep;
                const detail = { node: nodeName, namespace: namespace.join('/') };
                if (kind === 'create') await progress(parent, { phase: 'started', ...detail });
                if (kind === 'result') await progress(parent, { phase: 'completed', ...detail });
                continue;
              }

              // Each run of a node, a loop's next round or a fan-out branch, is
              // an execution of the same step, named by its task id.
              const step: StepRef = { stepId: path, executionId: jsonString(payload, 'id') };
              if (kind === 'create') {
                lastObservedStep = step;
                await runEffect(
                  publishWorkflowEvent(
                    context,
                    stepStartedEvent(context, step, renderJson(jsonProperty(payload, 'input'))),
                  ),
                );
                continue;
              }

              if (kind === 'result') {
                const pending = interruptRequest(payload);
                if (pending) {
                  interruptedStep ??= step;
                  rememberInterrupts(pending);
                  continue;
                }
                await finishStep(step, jsonProperty(payload, 'result') ?? '');
              }
              continue;
            }

            if (segments.length > 0) continue;

            if (mode === 'values') {
              lastOutput = payload ?? '';
              continue;
            }

            if (mode === 'updates') {
              const pending = interruptRequest(payload);
              if (pending) {
                rememberInterrupts(pending);
                continue;
              }
              if (isJsonObject(payload)) {
                for (const [node, value] of Object.entries(payload)) {
                  if (node === INTERRUPT_CHUNK_KEY) continue;
                  lastOutput = value;
                  // A step that never appeared in `tasks` (some functional-API
                  // shapes) still gets a timeline entry.
                  if (!topLevelSteps.has(node) && !finishedSteps.has(node)) {
                    topLevelSteps.add(node);
                    await runEffect(publishWorkflowEvent(context, stepStartedEvent(context, { stepId: node }, '')));
                    await finishStep({ stepId: node }, value);
                  }
                }
              }
            }
          }
        } catch (error) {
          if (signal.aborted) return { kind: 'canceled' };
          return { kind: 'failed', step: lastObservedStep, error: errorMessage(error) };
        }

        if (pendingRequest) {
          const state = await compiled.getState(streamOptions);
          const interrupts = coerceJson(state.tasks.flatMap((task) => task.interrupts ?? []));
          return {
            kind: 'interrupted',
            step: interruptedStep ?? lastObservedStep,
            request: { ...pendingRequest, interrupts },
          };
        }
        return { kind: 'completed', text: renderOutput(options.workflow.manifest.output, lastOutput) };
      },
      catch: (error) => new WorkflowExecutionError({ message: errorMessage(error), error }),
    });

    const outcome = yield* drive;

    if (outcome.kind === 'canceled') {
      yield* publishWorkflowEvent(context, runCanceledEvent(context));
      return { status: 'canceled', text: '' } satisfies WorkflowRunResult;
    }

    if (outcome.kind === 'failed') {
      yield* publishWorkflowEvent(context, stepFailedEvent(context, outcome.step, outcome.error));
      return yield* new WorkflowExecutionError({ message: outcome.error, error: null });
    }

    if (outcome.kind === 'interrupted') {
      const interrupt = outcome.request;
      // A tool approval names its gateway approval as the action id, so the
      // decision reaches the frozen call; any other interrupt gets a fresh id.
      const actionId = WorkflowPendingActionIdSchema.make(jsonString(interrupt, 'actionId') ?? (yield* randomUUIDv4));
      const title = jsonString(interrupt, 'title') ?? jsonString(interrupt, 'gate') ?? 'Input required';
      const description = jsonString(interrupt, 'description');
      const responseSchema = jsonString(interrupt, 'responseSchema');
      const requestInputValue = jsonProperty(interrupt, 'input');
      const interrupts = Array.isArray(interrupt.interrupts) ? interrupt.interrupts : [];

      yield* store.createPendingAction({
        id: actionId,
        runId: options.runId,
        workflowId: options.workflow.id,
        taskId: request.taskId,
        contextId: request.contextId,
        stepId: outcome.step.stepId,
        kind: 'human-input',
        status: 'pending',
        request: interrupt,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });

      // Built by composition rather than with `undefined` placeholders: this
      // envelope is validated as JSON downstream, where a present-but-undefined
      // key is not the same as an absent one.
      const requestBase = { actionId, runId: options.runId, stepId: outcome.step.stepId, title, interrupts };
      const withDescription = description === undefined ? requestBase : { ...requestBase, description };
      const withInput =
        requestInputValue === undefined ? withDescription : { ...withDescription, input: requestInputValue };
      const inputRequired: WorkflowInputRequired =
        responseSchema === undefined ? withInput : { ...withInput, responseSchema };

      yield* publishWorkflowEvent(context, humanInputRequestedEvent(context, outcome.step, inputRequired));

      return { status: 'input-required', text: '', inputRequired } satisfies WorkflowRunResult;
    }

    yield* publishWorkflowEvent(context, runCompletedEvent(context, outcome.text));
    return { status: 'completed', text: outcome.text } satisfies WorkflowRunResult;
  }).pipe(
    Effect.withSpan('agentdock.workflow.run', {
      attributes: {
        'workflow.id': options.workflow.id,
        'workflow.run_id': options.runId,
        'workflow.source_hash': options.workflow.sourceHash,
      },
    }),
  );
