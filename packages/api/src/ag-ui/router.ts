import * as NodeCrypto from 'node:crypto';
import {
  AgentLoopFactory,
  AgentRunStore,
  AgentToolResolver,
  AgUiEventAdapter,
  type AgUiRunAgentInput,
  AgUiRunInputSchema,
  type AgUiRunOutcome,
  formatSSEEvent,
  type GraphDeployment,
  graphEventToAgUi,
  graphInterrupts,
  graphThreadId,
  interruptAddress,
  ModelProvider,
  randomUUIDv4,
  runAgent,
  SSE_HEADERS,
  sseTextStream,
  streamAgentRunAsAgUi,
} from 'agentdock-sdk';
import {
  type AgentRunPart,
  coerceJson,
  isJsonObject,
  type JsonObject,
  type WorkflowPendingActionId,
  type WorkflowRunEvent,
  WorkflowRunEventId,
  workflowInputContract,
} from 'agentdock-sdk/schemas';
import {
  resolveDeploymentBindings,
  validateTaskInput,
  WorkflowRunStore,
  WorkflowRuntime,
  WorkflowRuntimeLayer,
  WorkflowToolInvoker,
  workflowInputFromParts,
} from 'agentdock-sdk/workflows';
import { Database } from 'db';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Layer from 'effect/Layer';
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import { z } from 'zod';
import { resolveAgentDefinition } from '../agents/runtime-layers';
import { AgentRegistry } from '../agents/service';
import { workflowDeploymentFor, workflowSecrets } from '../workflows/deployment';
import { DrizzleLibsqlCheckpointSaver } from '../workflows/langgraph-checkpointer';
import { WorkflowRegistry } from '../workflows/service';

const notFound = () => HttpServerResponse.jsonUnsafe({ error: 'Graph not found.' }, { status: 404 });

const closeProjectedMessages = (
  adapter: AgUiEventAdapter,
  outcome: AgUiRunOutcome,
  emit: (event: ReturnType<AgUiEventAdapter['start']>) => void,
): void => {
  for (const event of adapter.finish(outcome)) {
    if (event.type !== 'RUN_FINISHED' && event.type !== 'RUN_ERROR') emit(event);
  }
};

const agentDeploymentFor = (id: string) =>
  Effect.gen(function* () {
    const agents = yield* AgentRegistry;
    const agent = yield* agents.getById(id);
    if (!agent) return null;
    const definition = yield* resolveAgentDefinition(agent);
    const records = yield* agents.list();
    const snapshots = yield* Effect.forEach(records, (record) =>
      resolveAgentDefinition(record).pipe(
        Effect.map((resolved) => ({ ...record, instructions: resolved.instructions })),
      ),
    );
    return {
      kind: 'agent',
      agent: { ...agent, instructions: definition.instructions },
      agents: snapshots,
    } satisfies Extract<GraphDeployment, { readonly kind: 'agent' }>;
  });

const workflowDeploymentById = (id: string) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowRegistry;
    const workflow = yield* workflows.getById(id);
    return workflow ? yield* workflowDeploymentFor(workflow) : null;
  });

const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** An AG-UI user message's content: text, or text and binary items (inline `data` or a `url`). */
const AgUiUserContent = z.union([
  z.string(),
  z.array(
    z.union([
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({
        type: z.literal('binary'),
        mimeType: z.string(),
        data: z.string().optional(),
        url: z.string().optional(),
        filename: z.string().optional(),
      }),
    ]),
  ),
]);

/** The user turn as message parts; a binary item with neither data nor a URL cannot be passed on. */
const userTurnParts = (
  content: z.infer<typeof AgUiUserContent>,
): { readonly parts: ReadonlyArray<AgentRunPart> } | { readonly error: string } => {
  if (Predicate.isString(content)) return { parts: [{ kind: 'text', text: content }] };
  const parts: Array<AgentRunPart> = [];
  for (const item of content) {
    if (item.type === 'text') {
      parts.push({ kind: 'text', text: item.text });
      continue;
    }
    const source = item.data !== undefined ? { bytes: item.data } : item.url !== undefined ? { uri: item.url } : null;
    if (source === null) return { error: 'A binary input item needs `data` or a `url`.' };
    const file = { ...source, mimeType: item.mimeType };
    parts.push({ kind: 'file', file: item.filename === undefined ? file : { ...file, name: item.filename } });
  }
  return { parts };
};

/** A resume reuses one message id per identical resume payload, so a retried resume is not a new turn. */
const resumeMessageId = (resumes: NonNullable<AgUiRunAgentInput['resume']>): string =>
  `resume:${NodeCrypto.createHash('sha256').update(encodeJsonString(resumes)).digest('hex')}`;

const parseResumes = (resumes: NonNullable<AgUiRunAgentInput['resume']>) => {
  const parsedAddresses = z
    .array(
      z.string().transform((value, ctx) => {
        try {
          return interruptAddress.parse(JSON.parse(value));
        } catch {
          ctx.addIssue({ code: 'custom', message: 'Invalid interrupt address.' });
          return z.NEVER;
        }
      }),
    )
    .safeParse(resumes.map((entry) => entry.interruptId));
  if (!parsedAddresses.success) return { error: parsedAddresses.error.message } as const;
  const addresses = parsedAddresses.data;
  const taskId = addresses[0]?.[0];
  if (taskId && addresses.some(([id]) => id !== taskId))
    return { error: 'Resume entries must address one task.' } as const;
  return {
    addresses,
    taskId,
    response: Object.fromEntries(
      resumes.map((entry, index) => [addresses[index]?.[1] ?? '', coerceJson(entry.payload)]),
    ),
  } as const;
};

const agentRoutes = HttpRouter.add(
  'POST',
  '/agents/:graphId/ag-ui',
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    if (!params.graphId) return notFound();
    const request = yield* HttpServerRequest.HttpServerRequest;
    const input = AgUiRunInputSchema.safeParse(yield* request.json);
    if (!input.success) return HttpServerResponse.jsonUnsafe({ error: input.error.message }, { status: 400 });
    const deployment = yield* agentDeploymentFor(params.graphId);
    if (!deployment) return notFound();

    const resumes = input.data.resume ?? [];
    const parsed = parseResumes(resumes);
    if ('error' in parsed) return HttpServerResponse.jsonUnsafe({ error: parsed.error }, { status: 400 });
    const taskId = parsed.taskId ?? `ag-ui:${input.data.runId}`;
    const runStore = yield* AgentRunStore;
    const existing = yield* runStore.get(taskId);
    const waiting = (yield* runStore.listByContext(input.data.threadId)).find(
      (record) =>
        record.agentId === deployment.agent.id &&
        record.origin.surface === 'ag-ui' &&
        record.status.state === 'input-required',
    );
    if (existing && existing.origin.surface !== 'ag-ui')
      return HttpServerResponse.jsonUnsafe({ error: 'Run ID belongs to another protocol.' }, { status: 409 });
    if (waiting && resumes.length === 0)
      return HttpServerResponse.jsonUnsafe(
        { error: 'Resolve the pending interrupts before starting a new run on this thread.' },
        { status: 400 },
      );
    if (
      resumes.length > 0 &&
      (!existing ||
        existing.agentId !== deployment.agent.id ||
        existing.contextId !== input.data.threadId ||
        existing.status.state !== 'input-required')
    )
      return HttpServerResponse.jsonUnsafe(
        { error: 'Interrupt does not belong to this agent thread.' },
        { status: 400 },
      );

    if (existing?.status.state === 'input-required') {
      const data = existing.status.message?.parts.find((part) => part.kind === 'data')?.data;
      const open = graphInterrupts(taskId, coerceJson(data));
      if (
        open.length !== resumes.length ||
        open.some((entry) => !resumes.some((response) => response.interruptId === entry.id))
      )
        return HttpServerResponse.jsonUnsafe({ error: 'Resume must address every open interrupt.' }, { status: 400 });
    }

    const user = input.data.messages.findLast((message) => message.role === 'user');
    const content = AgUiUserContent.safeParse(user?.content);
    if (!content.success && resumes.length === 0)
      return HttpServerResponse.jsonUnsafe(
        { error: 'A user message (text, or text and binary items) or a resume response is required.' },
        { status: 400 },
      );
    const turn = content.success ? userTurnParts(content.data) : { parts: [] };
    if ('error' in turn) return HttpServerResponse.jsonUnsafe({ error: turn.error }, { status: 400 });

    const database = yield* Database;
    const runtimeContext = yield* Effect.context<
      AgentLoopFactory | ModelProvider | AgentToolResolver | AgentRunStore
    >();
    const source = streamAgentRunAsAgUi({ threadId: input.data.threadId, runId: input.data.runId }, async (emit) => {
      const adapter = new AgUiEventAdapter(input.data.threadId, input.data.runId);
      if (resumes.some((entry) => entry.status === 'cancelled') && existing) {
        await Effect.runPromiseWith(runtimeContext)(
          Effect.gen(function* () {
            const timestamp = DateTime.formatIso(yield* DateTime.now);
            yield* runStore.save({
              ...existing,
              status: { state: 'canceled', timestamp },
              updatedAt: timestamp,
            });
          }),
        );
        const outcome = { status: 'canceled' } satisfies AgUiRunOutcome;
        closeProjectedMessages(adapter, outcome, emit);
        return outcome;
      }
      const result = await Effect.runPromiseWith(runtimeContext)(
        runAgent(deployment.agent, resumes.length > 0 ? { resume: parsed.response } : { parts: turn.parts }, {
          deployment,
          taskId,
          contextId: input.data.threadId,
          userMessageId: resumes.length > 0 ? resumeMessageId(resumes) : (user?.id ?? input.data.runId),
          origin: { surface: 'ag-ui' },
          checkpointer: new DrizzleLibsqlCheckpointSaver(database.db),
          threadId: graphThreadId(`ag-ui:agent:${deployment.agent.id}`, input.data.threadId),
          recover: resumes.length > 0,
          onEvent: (event) => {
            for (const translated of adapter.handle(event)) emit(translated);
          },
        }),
      );
      const outcome: AgUiRunOutcome =
        result.status === 'completed'
          ? {
              status: 'completed',
              result: result.structured ?? { text: result.text },
            }
          : result.status === 'input-required'
            ? {
                status: 'input-required',
                interrupts: graphInterrupts(taskId, coerceJson(result.inputRequired)),
              }
            : result.status === 'canceled'
              ? { status: 'canceled' }
              : {
                  status: 'failed',
                  message:
                    result.record.status.message?.parts
                      .flatMap((part) => (part.kind === 'text' ? [part.text] : []))
                      .join('\n') || 'Agent run failed.',
                };
      closeProjectedMessages(adapter, outcome, emit);
      return outcome;
    });
    async function* frames() {
      for await (const event of source) yield formatSSEEvent(event);
    }
    return HttpServerResponse.stream(sseTextStream(frames()), { headers: SSE_HEADERS });
  }).pipe(Effect.withSpan('agentdock.ag-ui.agent_run')),
);

const workflowRoutes = HttpRouter.add(
  'POST',
  '/workflows/:graphId/ag-ui',
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    if (!params.graphId) return notFound();
    const request = yield* HttpServerRequest.HttpServerRequest;
    const input = AgUiRunInputSchema.safeParse(yield* request.json);
    if (!input.success) return HttpServerResponse.jsonUnsafe({ error: input.error.message }, { status: 400 });
    const deployment = yield* workflowDeploymentById(params.graphId);
    if (deployment?.kind !== 'workflow') return notFound();

    const resumes = input.data.resume ?? [];
    const parsed = parseResumes(resumes);
    if ('error' in parsed) return HttpServerResponse.jsonUnsafe({ error: parsed.error }, { status: 400 });
    const taskId = parsed.taskId ?? `ag-ui:${input.data.runId}`;
    const store = yield* WorkflowRunStore;
    const runs = yield* store.list();
    const waitingOnThread = runs.find(
      (run) =>
        run.workflowId === deployment.workflow.id &&
        run.contextId === input.data.threadId &&
        run.status === 'input-required',
    );
    if (waitingOnThread && resumes.length === 0)
      return HttpServerResponse.jsonUnsafe(
        { error: 'Resolve the pending interrupts before starting a new run on this thread.' },
        { status: 400 },
      );

    const waiting =
      resumes.length === 0
        ? null
        : yield* store.getWaitingByTask({
            workflowId: deployment.workflow.id,
            taskId,
            contextId: input.data.threadId,
          });
    if (resumes.length > 0 && !waiting)
      return HttpServerResponse.jsonUnsafe(
        { error: 'Interrupt does not belong to this workflow thread.' },
        { status: 400 },
      );
    const history = waiting ? yield* store.listEvents(waiting.id) : null;
    const pending = history?.findLast((event) => event.type === 'human-input-requested');
    if (resumes.length > 0 && pending?.type !== 'human-input-requested')
      return HttpServerResponse.jsonUnsafe({ error: 'The workflow has no pending input request.' }, { status: 400 });
    if (pending?.type === 'human-input-requested') {
      const open = graphInterrupts(taskId, coerceJson(pending));
      if (
        open.length !== resumes.length ||
        open.some((entry) => !resumes.some((response) => response.interruptId === entry.id))
      )
        return HttpServerResponse.jsonUnsafe({ error: 'Resume must address every open interrupt.' }, { status: 400 });
    }

    const user = input.data.messages.findLast((message) => message.role === 'user');
    const text = z.string().safeParse(user?.content);
    const state = coerceJson(input.data.state);
    const parts =
      isJsonObject(state) && Object.keys(state).length > 0
        ? ([{ kind: 'data', data: state }] as const)
        : ([{ kind: 'text', text: text.success ? text.data : '' }] as const);
    if (resumes.length === 0) {
      const issues = validateTaskInput(workflowInputContract(deployment.workflow), parts);
      if (issues.length > 0)
        return HttpServerResponse.jsonUnsafe(
          { error: `Run does not match this workflow's input contract: ${issues.join('; ')}` },
          { status: 400 },
        );
    }

    const database = yield* Database;
    const modelProvider = yield* ModelProvider;
    const toolResolver = yield* AgentToolResolver;
    const loopFactory = yield* AgentLoopFactory;
    const agentRunStore = yield* AgentRunStore;
    const toolInvoker = yield* WorkflowToolInvoker;
    const httpClient = yield* HttpClient.HttpClient;
    const effectContext = yield* Effect.context<never>();
    const bindings = resolveDeploymentBindings(deployment.workflow, deployment);
    const secrets = yield* workflowSecrets(deployment.workflow.manifest);
    const runtimeServices = Layer.mergeAll(
      Layer.succeed(WorkflowRunStore, store),
      Layer.succeed(AgentLoopFactory, loopFactory),
      Layer.succeed(ModelProvider, modelProvider),
      Layer.succeed(AgentToolResolver, toolResolver),
      Layer.succeed(AgentRunStore, agentRunStore),
      Layer.succeed(WorkflowToolInvoker, toolInvoker),
      Layer.succeed(HttpClient.HttpClient, httpClient),
    );
    const messageId = resumes.length > 0 ? resumeMessageId(resumes) : (user?.id ?? input.data.runId);
    const source = streamAgentRunAsAgUi({ threadId: input.data.threadId, runId: input.data.runId }, async (emit) => {
      const adapter = new AgUiEventAdapter(input.data.threadId, input.data.runId);
      const outcome = await Effect.runPromiseWith(effectContext)(
        Effect.gen(function* () {
          if (resumes.some((entry) => entry.status === 'cancelled')) {
            if (!waiting) return { status: 'failed', message: 'Workflow run is not waiting for input.' } as const;
            const event = {
              id: WorkflowRunEventId.make(yield* randomUUIDv4),
              runId: waiting.id,
              workflowId: waiting.workflowId,
              taskId,
              timestamp: DateTime.formatIso(yield* DateTime.now),
              type: 'run-canceled',
            } as const;
            yield* store.append(event);
            for (const translated of graphEventToAgUi(adapter, coerceJson({ type: 'workflow-event', event })))
              emit(translated);
            return { status: 'canceled' } as const;
          }

          let resume:
            | { readonly actionId: WorkflowPendingActionId; readonly stepId: string; readonly response: JsonObject }
            | undefined;
          let run = waiting;
          if (waiting && pending?.type === 'human-input-requested') {
            const resolved = yield* store.resolvePendingAction({
              actionId: pending.actionId,
              response: parsed.response,
            });
            if (!resolved)
              return { status: 'failed', message: 'The workflow input request is no longer pending.' } as const;
            resume = { actionId: pending.actionId, stepId: pending.stepId, response: parsed.response };
          } else {
            run = yield* store.create({
              workflow: deployment.workflow,
              taskId,
              contextId: input.data.threadId,
              input: workflowInputFromParts(workflowInputContract(deployment.workflow), parts),
            });
          }
          if (!run) return { status: 'failed', message: 'Workflow run was not found.' } as const;

          const runtimeLayer = WorkflowRuntimeLayer({
            workflow: deployment.workflow,
            runId: run.id,
            agents: bindings,
            secrets,
            checkpointer: new DrizzleLibsqlCheckpointSaver(database.db),
            consumeCancellation: () => false,
            deployment,
            recover: resumes.length > 0,
            threadNamespace: `ag-ui:workflow:${deployment.workflow.id}`,
          });
          const result = yield* Effect.gen(function* () {
            const runtime = yield* WorkflowRuntime;
            const runtimeInput = {
              request: { taskId, contextId: input.data.threadId, messageId },
              input: run.input,
              onEvent: (event: WorkflowRunEvent) => {
                for (const translated of graphEventToAgUi(adapter, coerceJson({ type: 'workflow-event', event })))
                  emit(translated);
              },
            };
            return yield* runtime.execute(resume ? { ...runtimeInput, resume } : runtimeInput);
          }).pipe(
            Effect.provide(Layer.mergeAll(runtimeLayer, runtimeServices)),
            Effect.catch((error) =>
              Effect.gen(function* () {
                const message = error instanceof Error ? error.message : String(error);
                const event = {
                  id: WorkflowRunEventId.make(yield* randomUUIDv4),
                  runId: run.id,
                  workflowId: deployment.workflow.id,
                  taskId,
                  timestamp: DateTime.formatIso(yield* DateTime.now),
                  type: 'run-failed',
                  error: message,
                } as const;
                yield* store.append(event);
                for (const translated of graphEventToAgUi(adapter, coerceJson({ type: 'workflow-event', event })))
                  emit(translated);
                return { status: 'failed', message } as const;
              }),
            ),
          );

          if (result.status === 'failed') return result;
          if (result.status === 'completed') {
            for (const translated of adapter.handle({ type: 'text-delta', text: result.text })) emit(translated);
            return { status: 'completed', result: { text: result.text } } as const;
          }
          if (result.status === 'input-required')
            return {
              status: 'input-required',
              interrupts: graphInterrupts(taskId, coerceJson(result.inputRequired)),
            } as const;
          return { status: 'canceled' } as const;
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              status: 'failed',
              message: error instanceof Error ? error.message : String(error),
            } as const),
          ),
        ),
      );
      closeProjectedMessages(adapter, outcome, emit);
      return outcome;
    });
    async function* frames() {
      for await (const event of source) yield formatSSEEvent(event);
    }
    return HttpServerResponse.stream(sseTextStream(frames()), { headers: SSE_HEADERS });
  }).pipe(Effect.withSpan('agentdock.ag-ui.workflow_run')),
);
export const AgentAgUiRoutes = Layer.mergeAll(agentRoutes, workflowRoutes);
