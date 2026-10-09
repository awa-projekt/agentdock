import type { Message, Part, Task } from '@a2a-js/sdk';
import {
  type AgentLoopFactory,
  type AgentRunStore,
  type AgentToolResolver,
  type ModelProvider,
  randomUUIDv4,
  runAgent,
} from 'agentdock-sdk';
import { tracedA2aClientFactory } from 'agentdock-sdk/a2a/client';
import { type EvalModelCall, targetUsageFromCalls } from 'agentdock-sdk/evals';
import { buildWorkflowA2aUrl } from 'agentdock-sdk/routes';
import {
  AgentLoopProgressState,
  type AgentRunPart,
  type AgentRunRecord,
  coerceJson,
  EvalOperationError,
  type EvalRunTarget,
  type EvalRunTargetInput,
  EvalTargetUsage,
  type EvalToolCall,
  type EvalTrialOutput,
  EvalValidationError,
  emptyTokenUsage,
  isJsonObject,
  type Json,
  type JsonObject,
  jsonProperty,
  jsonString,
  ModelCallProgressState,
  TokenUsage,
  ToolCallProgressState,
  type WorkflowRunEvent,
  workflowInputContract,
} from 'agentdock-sdk/schemas';
import { WorkflowRunStore, workflowInputMode } from 'agentdock-sdk/workflows';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import { resolveAgentDefinition } from '../agents/runtime-layers';
import { AgentRegistry } from '../agents/service';
import { ServerConfig } from '../config';
import { ModelCatalog } from '../models/catalog';
import type { SkillRegistry } from '../skills/service';
import { WorkflowRegistry } from '../workflows/service';
import { priceModelCall } from './usage';

/**
 * The harness could not get an answer out of the target; the trial is
 * `errored`, not failed. `usage` is what the target spent before it gave up,
 * which is billed all the same.
 */
export class EvalTargetError extends Schema.TaggedError<EvalTargetError>()('EvalTargetError', {
  message: Schema.String,
  usage: Schema.optional(EvalTargetUsage),
}) {}

/** What the target answered and what answering cost. */
export type EvalTargetResult = {
  readonly output: EvalTrialOutput;
  readonly usage: EvalTargetUsage | undefined;
};

/** A model call as the loop reported it, before it is priced and placed in a loop phase. */
type RecordedCall = {
  readonly source: 'agent' | 'subagent';
  readonly model: string;
  readonly usage: TokenUsage | undefined;
  readonly toolCalls: number;
  readonly reasoningEstimated: boolean;
};

/** A subagent's `model-call` event as `send_task` relays it inside its progress events. */
const RelayedModelCall = Schema.Struct({
  type: Schema.Literal('model-call'),
  model: Schema.String,
  usage: Schema.optional(TokenUsage),
  toolCalls: Schema.Number,
  reasoningEstimated: Schema.Boolean,
});
const decodeRelayedModelCall = Schema.decodeUnknownOption(RelayedModelCall);

/** Unwraps nested delegation progress down to the event a (sub-)subagent emitted. */
const innermostEvent = (event: Json | undefined): Json | undefined =>
  jsonString(event, 'type') === 'send-task-progress' ? innermostEvent(jsonProperty(event, 'event')) : event;

/**
 * A hard limit per trial, so one stuck case cannot hold the whole run. The
 * trial is recorded as errored when it trips.
 */
const TRIAL_TIMEOUT = Duration.minutes(10);
const WORKFLOW_POLL_INTERVAL = Duration.seconds(1);
const TERMINAL_TASK_STATES = new Set([
  'completed',
  'failed',
  'canceled',
  'rejected',
  'input-required',
  'auth-required',
]);

export type EvalTargetsService = {
  /** Checks the target exists and names it for the run's snapshot. */
  readonly resolve: (
    target: EvalRunTargetInput,
  ) => Effect.Effect<EvalRunTarget, EvalValidationError | EvalOperationError>;
  readonly run: (target: EvalRunTarget, input: string) => Effect.Effect<EvalTargetResult, EvalTargetError>;
};

export const EvalTargets = Context.Service<EvalTargetsService>('@agentdock/api/EvalTargets');

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const dataParts = (record: AgentRunRecord): ReadonlyArray<JsonObject> =>
  record.history.flatMap((message) => message.parts.flatMap((part) => (part.kind === 'data' ? [part.data] : [])));

/** Pairs each recorded tool call with its result or error, in call order. */
const toolCallsFromRecord = (record: AgentRunRecord): ReadonlyArray<EvalToolCall> => pairToolCalls(dataParts(record));

/** Pairs `tool-call` data with the `tool-result` or `tool-error` that answered it, by call id, else in order. */
const pairToolCalls = (records: ReadonlyArray<JsonObject>): ReadonlyArray<EvalToolCall> => {
  const calls: Array<EvalToolCall> = [];
  const byId = new Map<string, number>();
  for (const data of records) {
    const type = jsonString(data, 'type');
    const toolName = jsonString(data, 'toolName') ?? 'tool';
    const toolCallId = jsonString(data, 'toolCallId');
    if (type === 'tool-call') {
      if (toolCallId !== undefined) byId.set(toolCallId, calls.length);
      const call: EvalToolCall = { toolName, input: jsonProperty(data, 'input') ?? null };
      calls.push(toolCallId === undefined ? call : { ...call, toolCallId });
      continue;
    }
    if (type !== 'tool-result' && type !== 'tool-error') continue;
    const index = toolCallId === undefined ? undefined : byId.get(toolCallId);
    const existing = index === undefined ? undefined : calls[index];
    const outcome =
      type === 'tool-result'
        ? { output: jsonProperty(data, 'output') ?? null }
        : { error: jsonString(data, 'error') ?? 'Tool failed.' };
    if (existing !== undefined && index !== undefined) calls[index] = { ...existing, ...outcome };
    else calls.push({ toolName, ...outcome });
  }
  return calls;
};

/** A `model-call` progress event of a workflow step: a bound agent's or a bound model's call. */
const StepModelCall = Schema.Struct({
  model: Schema.String,
  usage: Schema.NullOr(TokenUsage),
  toolCalls: Schema.Number,
  reasoningEstimated: Schema.Boolean,
});
const decodeStepModelCall = Schema.decodeUnknownOption(StepModelCall);

/**
 * What a workflow run did, read off its step events: every model call it
 * made (its bound agents', its bound models', and what subagents relayed) and
 * every tool call, a bound agent's own and the workflow's bound tools alike.
 */
export const workflowActivity = (events: ReadonlyArray<WorkflowRunEvent>) => {
  const calls: Array<RecordedCall> = [];
  const toolEvents: Array<JsonObject> = [];
  const boundCalls: Array<string> = [];
  const openBound = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'step-progress') continue;
    const { data } = event;
    switch (event.state) {
      case ModelCallProgressState:
        for (const call of Option.toArray(decodeStepModelCall(data))) {
          calls.push({
            source: 'agent',
            model: call.model,
            usage: call.usage ?? undefined,
            toolCalls: call.toolCalls,
            reasoningEstimated: call.reasoningEstimated,
          });
        }
        break;
      case AgentLoopProgressState.Delegation:
        for (const relayed of Option.toArray(decodeRelayedModelCall(innermostEvent(jsonProperty(data, 'event'))))) {
          const { model, usage, toolCalls, reasoningEstimated } = relayed;
          calls.push({ source: 'subagent', model, usage, toolCalls, reasoningEstimated });
        }
        break;
      case AgentLoopProgressState.ToolCall:
      case AgentLoopProgressState.ToolResult:
      case AgentLoopProgressState.ToolError:
        toolEvents.push(data);
        break;
      case ToolCallProgressState.Call: {
        // A bound tool's events carry no call id; a step calls its tools one after the other.
        const toolName = jsonString(data, 'name') ?? 'tool';
        const toolCallId = `${event.stepId}:${toolName}:${boundCalls.push(toolName)}`;
        openBound.set(`${event.stepId}:${toolName}`, toolCallId);
        toolEvents.push({ type: 'tool-call', toolName, toolCallId, input: jsonProperty(data, 'input') ?? null });
        break;
      }
      case ToolCallProgressState.Result:
      case ToolCallProgressState.Error: {
        const toolName = jsonString(data, 'name') ?? 'tool';
        const toolCallId = openBound.get(`${event.stepId}:${toolName}`) ?? `${event.stepId}:${toolName}`;
        toolEvents.push(
          event.state === ToolCallProgressState.Result
            ? { type: 'tool-result', toolName, toolCallId, output: jsonProperty(data, 'output') ?? null }
            : { type: 'tool-error', toolName, toolCallId, error: jsonString(data, 'error') ?? 'Tool failed.' },
        );
        break;
      }
    }
  }
  return { calls, toolCalls: pairToolCalls(toolEvents) };
};

const textOfParts = (parts: ReadonlyArray<Part> | undefined): string =>
  (parts ?? []).flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n');

const textOfRunParts = (parts: ReadonlyArray<AgentRunPart> | undefined): string =>
  (parts ?? []).flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n');

const structuredOfParts = (parts: ReadonlyArray<Part> | undefined): JsonObject | undefined =>
  (parts ?? []).flatMap((part) => {
    if (part.kind !== 'data') return [];
    const data = coerceJson(part.data);
    return isJsonObject(data) ? [data] : [];
  })[0];

/** A workflow's answer lives in its final status message, or failing that its artifacts. */
const workflowAnswer = (task: Task) => {
  const statusParts = task.status.message?.parts;
  const artifactParts = (task.artifacts ?? []).flatMap((artifact) => artifact.parts);
  const text = textOfParts(statusParts) || textOfParts(artifactParts);
  return { text, structured: structuredOfParts(statusParts) ?? structuredOfParts(artifactParts) };
};

const workflowMessage = (messageId: string, parts: ReadonlyArray<Part>): Message => ({
  kind: 'message',
  messageId,
  role: 'user',
  parts: [...parts],
});

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

export const EvalTargetsLive = Layer.effect(
  EvalTargets,
  Effect.gen(function* () {
    const agents = yield* AgentRegistry;
    const workflows = yield* WorkflowRegistry;
    const server = yield* ServerConfig;
    const httpClient = yield* HttpClient.HttpClient;
    const catalog = yield* ModelCatalog;
    const workflowRuns = yield* WorkflowRunStore;
    const runtime = yield* Effect.context<
      | AgentLoopFactory
      | ModelProvider
      | AgentToolResolver
      | AgentRunStore
      | Context.Service.Identifier<typeof SkillRegistry>
    >();

    const notFound = (target: EvalRunTargetInput) =>
      new EvalValidationError({ message: `The ${target.kind} '${target.id}' does not exist.` });
    const lookupFailed = (error: { readonly cause: unknown }) =>
      new EvalOperationError({ message: `Could not look up the target: ${errorMessage(error.cause)}` });

    const resolve = Effect.fn('EvalTargets.resolve')(function* (target: EvalRunTargetInput) {
      if (target.kind === 'agent') {
        const agent = yield* agents.getById(target.id).pipe(Effect.mapError(lookupFailed));
        if (!agent) return yield* notFound(target);
        return {
          kind: 'agent',
          id: agent.id,
          name: agent.name,
          model: agent.model,
          revision: agent.revision,
        } satisfies EvalRunTarget;
      }
      const workflow = yield* workflows.getById(target.id).pipe(Effect.mapError(lookupFailed));
      if (!workflow) return yield* notFound(target);
      if (workflowInputMode(workflowInputContract(workflow)) === 'file') {
        return yield* new EvalValidationError({
          message: `The workflow '${workflow.manifest.name}' takes a file as input, which eval cases cannot supply.`,
        });
      }
      return { kind: 'workflow', id: workflow.id, name: workflow.manifest.name } satisfies EvalRunTarget;
    });

    /**
     * Prices the recorded calls and places each in a loop phase. The last call
     * of an answered run wrote the answer (structured output included); every
     * other call of the agent's own ended in tool calls. Delegated calls count
     * as subagents, however deep.
     */
    const priceCalls = (calls: ReadonlyArray<RecordedCall>, answered: boolean) => {
      const lastOwnCall = calls.findLastIndex((call) => call.source === 'agent');
      return Effect.forEach(calls, (call, index): Effect.Effect<EvalModelCall> => {
        const phase =
          call.source === 'subagent'
            ? 'subagents'
            : (answered ? index === lastOwnCall : call.toolCalls === 0)
              ? 'answer'
              : 'tool-use';
        // A call the provider reported no usage for still happened; its cost is unknown, not zero.
        const priced =
          call.usage === undefined
            ? Effect.succeed({ calls: 1, tokens: emptyTokenUsage, reasoningEstimated: false })
            : priceModelCall(catalog, call.model, call.usage, call.reasoningEstimated);
        return Effect.map(priced, (usage) => ({ phase, model: call.model, usage }));
      }).pipe(Effect.map(targetUsageFromCalls));
    };

    const runAgentTarget = (target: EvalRunTarget, input: string, calls: Array<RecordedCall>) =>
      Effect.gen(function* () {
        const agent = yield* agents
          .getById(target.id)
          .pipe(Effect.mapError((error) => new EvalTargetError({ message: errorMessage(error.cause) })));
        if (!agent) return yield* new EvalTargetError({ message: `The agent '${target.id}' no longer exists.` });
        const definition = yield* resolveAgentDefinition(agent).pipe(
          Effect.mapError((error) => new EvalTargetError({ message: errorMessage(error.cause) })),
        );
        const controller = new AbortController();
        const startedAt = yield* Clock.currentTimeMillis;
        // Every trial runs in a fresh context, so no trial can see another's conversation.
        const result = yield* runAgent(
          definition,
          { parts: [{ kind: 'text', text: input }] },
          {
            origin: { surface: 'eval' },
            signal: controller.signal,
            onEvent: (event) => {
              if (event.type !== 'model-call') return;
              calls.push({
                source: 'agent',
                model: event.model,
                usage: event.usage,
                toolCalls: event.toolCalls,
                reasoningEstimated: event.reasoningEstimated,
              });
            },
            emit: (progress) => {
              const relayed = decodeRelayedModelCall(innermostEvent(coerceJson(progress)));
              if (Option.isNone(relayed)) return;
              const { model, usage, toolCalls, reasoningEstimated } = relayed.value;
              calls.push({ source: 'subagent', model, usage, toolCalls, reasoningEstimated });
            },
          },
        ).pipe(
          Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
          Effect.mapError((error) => new EvalTargetError({ message: error.message })),
        );
        const finishedAt = yield* Clock.currentTimeMillis;
        if (result.status === 'failed' || result.status === 'canceled') {
          const reason = textOfRunParts(result.record.status.message?.parts);
          return yield* new EvalTargetError({ message: reason || `The agent run ${result.status}.` });
        }
        const output: EvalTrialOutput = {
          text: result.text,
          state: result.status,
          toolCalls: toolCallsFromRecord(result.record),
          durationMs: Math.max(0, finishedAt - startedAt),
          agentRunId: result.taskId,
        };
        return {
          output: result.structured === undefined ? output : { ...output, structured: result.structured },
          answered: result.status === 'completed',
        };
      }).pipe(Effect.provide(runtime));

    /** What the workflow task's run did; nothing when the run cannot be found (it never started). */
    const runActivity = (taskId: string) =>
      Effect.gen(function* () {
        const runs = yield* workflowRuns.list();
        const run = runs.find((candidate) => candidate.taskId === taskId);
        const events = run === undefined ? null : yield* workflowRuns.listEvents(run.id);
        return workflowActivity(events ?? []);
      }).pipe(Effect.orElseSucceed(() => workflowActivity([])));

    const runWorkflowTarget = (target: EvalRunTarget, input: string, calls: Array<RecordedCall>) =>
      Effect.gen(function* () {
        const workflow = yield* workflows
          .getById(target.id)
          .pipe(Effect.mapError((error) => new EvalTargetError({ message: errorMessage(error.cause) })));
        if (!workflow) return yield* new EvalTargetError({ message: `The workflow '${target.id}' no longer exists.` });
        const mode = workflowInputMode(workflowInputContract(workflow));
        const data = mode === 'data' ? Option.getOrUndefined(decodeJsonText(input)) : undefined;
        if (mode === 'data' && data === undefined) {
          return yield* new EvalTargetError({ message: 'This workflow takes JSON input; the case input is not JSON.' });
        }
        const parts: ReadonlyArray<Part> =
          data === undefined
            ? [{ kind: 'text', text: input }]
            : [{ kind: 'data', data: isJsonObject(data) ? { ...data } : { value: data } }];

        const factory = yield* tracedA2aClientFactory.pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
        const client = yield* Effect.tryPromise({
          try: () => factory.createFromUrl(`${buildWorkflowA2aUrl(server.apiBaseUrl, workflow.id)}/`),
          catch: (cause) => new EvalTargetError({ message: `Could not reach the workflow: ${errorMessage(cause)}` }),
        });
        const startedAt = yield* Clock.currentTimeMillis;
        const messageId = yield* randomUUIDv4;
        const sent = yield* Effect.tryPromise({
          try: () =>
            client.sendMessage({ configuration: { blocking: false }, message: workflowMessage(messageId, parts) }),
          catch: (cause) => new EvalTargetError({ message: `The workflow rejected the task: ${errorMessage(cause)}` }),
        });
        if (sent.kind !== 'task') {
          const finishedAt = yield* Clock.currentTimeMillis;
          const output: EvalTrialOutput = {
            text: textOfParts(sent.parts),
            state: 'completed',
            toolCalls: [],
            durationMs: Math.max(0, finishedAt - startedAt),
          };
          return { output, answered: true };
        }
        // Polling rather than holding one request open keeps long workflows clear of HTTP timeouts.
        const task = yield* Effect.tryPromise({
          try: () => client.getTask({ id: sent.id }),
          catch: (cause) =>
            new EvalTargetError({ message: `Could not read the workflow task: ${errorMessage(cause)}` }),
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced(WORKFLOW_POLL_INTERVAL),
            until: (current) => TERMINAL_TASK_STATES.has(current.status.state),
          }),
          Effect.onInterrupt(() => Effect.promise(() => client.cancelTask({ id: sent.id }).catch(() => undefined))),
        );
        const finishedAt = yield* Clock.currentTimeMillis;
        const answer = workflowAnswer(task);
        // Spend counts whether or not the run succeeded.
        const activity = yield* runActivity(task.id);
        calls.push(...activity.calls);
        if (task.status.state === 'failed' || task.status.state === 'canceled' || task.status.state === 'rejected') {
          return yield* new EvalTargetError({ message: answer.text || `The workflow task ${task.status.state}.` });
        }
        const output: EvalTrialOutput = {
          text: answer.text,
          state: task.status.state,
          toolCalls: activity.toolCalls,
          durationMs: Math.max(0, finishedAt - startedAt),
          taskId: task.id,
        };
        return {
          output: answer.structured === undefined ? output : { ...output, structured: answer.structured },
          answered: true,
        };
      });

    return EvalTargets.of({
      resolve,
      run: (target, input) => {
        // Filled as the loop reports each call, so a trial that fails or times out still accounts for its spend.
        const calls: Array<RecordedCall> = [];
        const attempt =
          target.kind === 'agent' ? runAgentTarget(target, input, calls) : runWorkflowTarget(target, input, calls);
        return attempt.pipe(
          Effect.timeoutOrElse({
            duration: TRIAL_TIMEOUT,
            orElse: () =>
              Effect.fail(new EvalTargetError({ message: `No answer within ${Duration.format(TRIAL_TIMEOUT)}.` })),
          }),
          Effect.flatMap(({ output, answered }) =>
            Effect.map(priceCalls(calls, answered), (usage): EvalTargetResult => ({ output, usage })),
          ),
          Effect.catch((error) =>
            Effect.flatMap(priceCalls(calls, false), (usage) =>
              Effect.fail(usage === undefined ? error : new EvalTargetError({ message: error.message, usage })),
            ),
          ),
          Effect.withSpan('agentdock.evals.target', { attributes: { 'eval.target.kind': target.kind } }),
        );
      },
    });
  }),
);
