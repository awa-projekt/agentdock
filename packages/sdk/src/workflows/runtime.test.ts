import type { Message, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { RequestContext as A2ARequestContext, DefaultExecutionEventBus } from '@a2a-js/sdk/server';
import { describe, expect, it } from '@effect/vitest';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type StandardMessageStructure } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { MemorySaver } from '@langchain/langgraph';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import type * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Queue from 'effect/Queue';
import * as Schema from 'effect/Schema';
import type * as Scope from 'effect/Scope';
import { z } from 'zod';
import { AgentLoopFactory } from '../agents/loop';
import { ModelProvider } from '../agents/model-provider';
import { AgentRunStore } from '../agents/run-store';
import { AgentToolResolver } from '../agents/tool-resolver';
import type { Json, JsonObject, Workflow, WorkflowPendingAction, WorkflowRunEvent } from '../schemas';
import { WorkflowId, WorkflowPendingActionId, workflowA2AToolApprovalRequestEnvelope } from '../schemas';
import { type AgentToolSet, defineAgentTool } from '../tools';
import type { WorkflowAgentBinding } from './bindings';
import { WorkflowTaskExecutor } from './executor';
import { extractWorkflowGraph } from './graph';
import { importWorkflowGraph, loadWorkflowManifest } from './load';
import { makeInMemoryWorkflowRunStore, WorkflowRunStore } from './run-store';
import { WorkflowRuntime, WorkflowRuntimeLayer, type WorkflowRuntimeServices } from './runtime';
import { enclosingSteps } from './step-paths';
import { artifactFixture, artifactJson } from './test-artifact';
import { WorkflowToolInvokeError, WorkflowToolInvoker } from './tool-invoker';

const decodeWorkflowId = Schema.decodeUnknownSync(WorkflowId);
const decodeJsonString = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const loadWorkflow = (
  graphModule: string,
  manifestOverrides: JsonObject = {},
): Effect.Effect<Workflow, never, Scope.Scope> =>
  Effect.gen(function* () {
    const source = yield* artifactFixture('.tmp-runtime-test-', {
      'agentdock.workflow.json': artifactJson({
        name: 'Fixture workflow',
        description: 'A fixture workflow.',
        version: '1.0.0',
        graph: './workflow.mjs:default',
        ...manifestOverrides,
      }),
      'package.json': artifactJson({ name: 'fixture', type: 'module' }),
      'workflow.mjs': graphModule,
    });
    const loaded = yield* Effect.orDie(loadWorkflowManifest(source));
    return {
      id: decodeWorkflowId('workflow-1'),
      source,
      manifest: loaded.manifest,
      sourceHash: loaded.sourceHash,
      bindings: {},
      revision: 1,
    };
  });

/**
 * The executor hands work back through a Promise-shaped `run` callback; serving it from a
 * child fiber keeps those effects on the test's own fiber tree and services.
 */
const promiseRunner = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<Effect.Effect<void>>();
  yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(queue), (effect) => Effect.forkChild(effect))));
  return <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
    new Promise<A>((resolve, reject) => {
      Queue.offerUnsafe(
        queue,
        Effect.matchCause(effect, {
          onSuccess: resolve,
          onFailure: (cause) => reject(new Error(Cause.pretty(cause))),
        }),
      );
    });
});

const agentServicesLayer = (
  reply: string,
): Layer.Layer<
  AgentLoopFactory | ModelProvider | AgentToolResolver | AgentRunStore | WorkflowToolInvoker | HttpClient.HttpClient
> =>
  Layer.mergeAll(
    FetchHttpClient.layer,
    Layer.succeed(AgentLoopFactory, AgentLoopFactory.of({ create: () => Effect.die('AgentLoopFactory unused') })),
    Layer.succeed(
      ModelProvider,
      ModelProvider.of({
        resolve: () =>
          Effect.succeed({
            provider: 'test',
            model: 'test:fake',
            modelId: 'fake',
            config: { chatModel: new FakeListChatModel({ responses: [reply] }) },
          }),
      }),
    ),
    AgentToolResolver.static([]),
    AgentRunStore.inMemory,
    WorkflowToolInvoker.none,
  );

type TrackedStore = {
  readonly layer: Layer.Layer<WorkflowRunStore>;
  readonly events: Array<WorkflowRunEvent>;
  readonly pendingActions: Array<WorkflowPendingAction>;
};

const trackedStore: Effect.Effect<TrackedStore> = Effect.gen(function* () {
  // Built eagerly (not as a `Layer.effect`) because several tests call
  // `execute()` more than once and each call provides the layer again — a
  // per-build store would lose the first run's state.
  const store = makeInMemoryWorkflowRunStore(yield* Effect.clockWith(Effect.succeed));
  const events: Array<WorkflowRunEvent> = [];
  const pendingActions: Array<WorkflowPendingAction> = [];
  const layer = Layer.succeed(
    WorkflowRunStore,
    WorkflowRunStore.of({
      ...store,
      append: (event) => store.append(event).pipe(Effect.tap(() => Effect.sync(() => void events.push(event)))),
      appendEvent: (event) =>
        store.appendEvent(event).pipe(Effect.tap(() => Effect.sync(() => void events.push(event)))),
      createPendingAction: (action) =>
        store.createPendingAction(action).pipe(Effect.tap(() => Effect.sync(() => void pendingActions.push(action)))),
    }),
  );
  return { layer, events, pendingActions };
});

const requestContextFor = (parts: Message['parts'], taskId = 'task-1'): RequestContext =>
  new A2ARequestContext({ kind: 'message', messageId: `message-${taskId}`, role: 'user', parts }, taskId, 'context-1');

type Harness = {
  readonly statuses: Array<TaskStatusUpdateEvent>;
  readonly eventBus: ExecutionEventBus;
};

const harness = (): Harness => {
  const statuses: Array<TaskStatusUpdateEvent> = [];
  const eventBus = new DefaultExecutionEventBus();
  eventBus.on('event', (event) => {
    if (event.kind === 'status-update') statuses.push(event);
  });
  return { statuses, eventBus };
};

const runExecutor = (options: {
  readonly workflow: Workflow;
  readonly agents?: ReadonlyArray<WorkflowAgentBinding>;
  readonly services: Layer.Layer<WorkflowRuntimeServices>;
  readonly requestContexts: ReadonlyArray<RequestContext>;
  readonly checkpointer?: MemorySaver;
  readonly recover?: boolean;
}): Effect.Effect<Harness, never, Scope.Scope> =>
  Effect.gen(function* () {
    const run = yield* promiseRunner;
    const bus = harness();
    const checkpointer = options.checkpointer ?? new MemorySaver();
    const executor = new WorkflowTaskExecutor(options.workflow, options.agents ?? [], {
      checkpointer,
      recover: options.recover ?? false,
      run: (effect) => run(Effect.provide(effect, options.services)),
    });
    for (const requestContext of options.requestContexts) {
      yield* Effect.promise(() => executor.execute(requestContext, bus.eventBus));
    }
    return bus;
  });

const stepEvents = <T extends WorkflowRunEvent['type']>(
  events: ReadonlyArray<WorkflowRunEvent>,
  type: T,
): ReadonlyArray<Extract<WorkflowRunEvent, { type: T }>> =>
  events.filter((event): event is Extract<WorkflowRunEvent, { type: T }> => event.type === type);

const terminalState = (statuses: ReadonlyArray<TaskStatusUpdateEvent>): string | undefined =>
  statuses.findLast((status) => status.final)?.status.state;

const services = (store: TrackedStore, reply = 'reply') => Layer.mergeAll(store.layer, agentServicesLayer(reply));

describe('WorkflowTaskExecutor driving a bare compiled graph', () => {
  it.live('lets protocol adapters consume raw workflow runtime events directly', () =>
    Effect.gen(function* () {
      const workflow = yield* loadWorkflow(`
      import { entrypoint, task } from '@langchain/langgraph';
      const greet = task('greet', async (name) => 'Hello ' + name);
      export default entrypoint('direct', async (input) => greet(input.name));
    `);
      const store = yield* trackedStore;
      const run = yield* Effect.gen(function* () {
        const runs = yield* WorkflowRunStore;
        return yield* runs.create({
          workflow,
          taskId: 'direct-task',
          contextId: 'direct-context',
          input: '{"name":"Ada"}',
        });
      }).pipe(Effect.provide(store.layer));
      const emitted: Array<WorkflowRunEvent> = [];
      const result = yield* Effect.gen(function* () {
        const runtime = yield* WorkflowRuntime;
        return yield* runtime.execute({
          request: { taskId: 'direct-task', contextId: 'direct-context', messageId: 'direct-message' },
          input: run.input,
          onEvent: (event) => {
            emitted.push(event);
          },
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            WorkflowRuntimeLayer({
              workflow,
              runId: run.id,
              agents: [],
              checkpointer: new MemorySaver(),
              consumeCancellation: () => false,
            }),
            services(store),
          ),
        ),
      );

      expect(result).toEqual({ status: 'completed', text: 'Hello Ada' });
      expect(emitted.map((event) => event.type)).toEqual(
        expect.arrayContaining(['run-started', 'step-started', 'step-completed', 'run-completed']),
      );
      expect(emitted.every((event) => !('kind' in event))).toBe(true);
    }),
  );

  it.live('records a step per task and completes the run with the last output', () =>
    Effect.gen(function* () {
      const workflow = yield* loadWorkflow(`
      import { entrypoint, task } from '@langchain/langgraph';
      const shout = task('shout', async (text) => text.toUpperCase());
      const reverse = task('reverse', async (text) => [...text].reverse().join(''));
      export default entrypoint('pipeline', async (input) => reverse(await shout(input.text)));
    `);
      const store = yield* trackedStore;

      const bus = yield* runExecutor({
        workflow,
        services: services(store),
        requestContexts: [requestContextFor([{ kind: 'data', data: { text: 'abc' } }])],
      });

      expect(terminalState(bus.statuses)).toBe('completed');
      expect(stepEvents(store.events, 'step-started').map((event) => event.stepId)).toEqual(
        expect.arrayContaining(['shout', 'reverse']),
      );
      expect(stepEvents(store.events, 'step-completed').map((event) => event.stepId)).toEqual(
        expect.arrayContaining(['shout', 'reverse']),
      );
      expect(stepEvents(store.events, 'run-completed')[0]?.output).toContain('CBA');
    }),
  );

  it.live('rejects a graph that was compiled with its own checkpointer', () =>
    Effect.gen(function* () {
      const workflow = yield* loadWorkflow(`
      import { entrypoint, MemorySaver } from '@langchain/langgraph';
      export default entrypoint({ name: 'own', checkpointer: new MemorySaver() }, async (input) => input);
    `);
      const store = yield* trackedStore;

      const bus = yield* runExecutor({
        workflow,
        services: services(store),
        requestContexts: [requestContextFor([{ kind: 'text', text: 'hi' }])],
      });

      expect(terminalState(bus.statuses)).toBe('failed');
      expect(stepEvents(store.events, 'run-failed')[0]?.error).toContain('without a checkpointer');
    }),
  );

  it.live('exposes a bound internal agent as context.agents and records its run and progress', () =>
    Effect.gen(function* () {
      const workflow = yield* loadWorkflow(
        `
      import { entrypoint, getConfig, task } from '@langchain/langgraph';
      const ask = task('ask', async (question) => {
        const out = await getConfig().context.agents.research.invoke({
          messages: [{ role: 'user', content: question }],
        });
        return out.messages.at(-1).content;
      });
      export default entrypoint('pipeline', async (input) => ask(input.text));
    `,
        { agents: { research: {} } },
      );
      const store = yield* trackedStore;
      const binding: WorkflowAgentBinding = {
        name: 'research',
        kind: 'internal',
        agent: { id: 'agent-research', name: 'Research', instructions: 'research', model: 'test:test' },
      };
      // One store instance shared by the run and the assertion below; a fresh
      // `inMemory` layer per provide would hide the record.
      const agentRuns = Layer.succeed(
        AgentRunStore,
        yield* AgentRunStore.use(Effect.succeed).pipe(Effect.provide(AgentRunStore.inMemory)),
      );
      const layer = Layer.mergeAll(store.layer, agentServicesLayer('answered: why?'), agentRuns);

      const bus = yield* runExecutor({
        workflow,
        agents: [binding],
        services: layer,
        requestContexts: [requestContextFor([{ kind: 'data', data: { text: 'why?' } }])],
      });

      expect(terminalState(bus.statuses)).toBe('completed');
      expect(stepEvents(store.events, 'run-completed')[0]?.output).toBe('answered: why?');
      // The agent's own model call is detail of the `ask` step, not a step of its own.
      expect(stepEvents(store.events, 'step-started').map((event) => event.stepId)).toEqual(['pipeline', 'ask']);
      expect(
        stepEvents(store.events, 'step-progress').some(
          (event) => event.stepId === 'ask' && event.data.node === 'model_request',
        ),
      ).toBe(true);
      const recorded = yield* AgentRunStore.use((runs) => runs.listByWorkflowRun(store.events[0]?.runId ?? '')).pipe(
        Effect.provide(layer),
      );
      expect(recorded.map((record) => [record.agentId, record.status.state])).toEqual([
        ['agent-research', 'completed'],
      ]);
    }),
  );

  it.live('runs the nodes of an embedded pattern as steps of their own, as the graph view draws them', () =>
    Effect.gen(function* () {
      const workflow = yield* loadWorkflow(
        `
      import { HumanMessage } from '@langchain/core/messages';
      import { END, MessagesValue, START, StateGraph, StateSchema } from '@langchain/langgraph';
      import { contextAgent, createRouter } from 'agentdock-patterns';
      import { z } from 'zod';

      // Deterministic routing, so the router's model is never resolved.
      const desk = createRouter({
        model: 'openai:gpt-5.6-luna',
        routes: [{ name: 'research', description: 'Researches a question.', agent: contextAgent('research') }],
        routeFn: (state) => [{ agent: 'research', task: state.messages.at(-1).text }],
        name: 'desk',
      });
      const team = new StateGraph(new StateSchema({ messages: MessagesValue }))
        .addNode('desk', desk)
        .addEdge(START, 'desk')
        .addEdge('desk', END)
        .compile();
      const State = new StateSchema({ text: z.string(), messages: MessagesValue, answer: z.string().default('') });

      export default new StateGraph(State)
        .addNode('prepare', (state) => ({ messages: [new HumanMessage(state.text)] }))
        .addNode('team', team)
        .addNode('respond', (state) => ({ answer: state.messages.at(-1)?.text ?? '' }))
        .addEdge(START, 'prepare')
        .addEdge('prepare', 'team')
        .addEdge('team', 'respond')
        .addEdge('respond', END)
        .compile();
    `,
        { agents: { research: {} } },
      );
      const store = yield* trackedStore;
      const binding: WorkflowAgentBinding = {
        name: 'research',
        kind: 'internal',
        agent: { id: 'agent-research', name: 'Research', instructions: 'research', model: 'test:test' },
      };

      const bus = yield* runExecutor({
        workflow,
        agents: [binding],
        services: services(store, 'answered: why?'),
        requestContexts: [requestContextFor([{ kind: 'data', data: { text: 'why?' } }])],
      });

      expect(terminalState(bus.statuses)).toBe('completed');
      expect(decodeJsonString(stepEvents(store.events, 'run-completed')[0]?.output)).toMatchObject({
        answer: 'answered: why?',
      });
      // The pattern's nodes are drawn inside `team:desk`, so each is a step of
      // its own under its drawn id; what runs inside them (the bound agent's
      // model call) is progress of the node that ran it. An expanded node is
      // not drawn itself but frames its nodes, and is a step as well.
      const topology = yield* extractWorkflowGraph(
        yield* importWorkflowGraph(yield* loadWorkflowManifest(workflow.source), {}),
        'team',
      );
      const drawn = new Set(topology.nodes.flatMap((node) => [node.id, ...enclosingSteps(node.group)]));
      const started = stepEvents(store.events, 'step-started').map((event) => event.stepId);
      expect(started).toEqual(
        expect.arrayContaining(['prepare', 'team', 'team:desk', 'team:desk:research', 'respond']),
      );
      expect(started.every((stepId) => drawn.has(stepId))).toBe(true);
      expect(
        stepEvents(store.events, 'step-progress').some(
          (event) => event.stepId === 'team:desk:research' && event.data.node === 'model_request',
        ),
      ).toBe(true);
    }),
  );

  it.live("streams a bound internal agent's tokens as artifact progress of the calling step", () =>
    Effect.gen(function* () {
      const workflow = yield* loadWorkflow(
        `
      import { entrypoint, getConfig, task } from '@langchain/langgraph';
      const ask = task('ask', async (question) => {
        const out = await getConfig().context.agents.research.invoke({
          messages: [{ role: 'user', content: question }],
        });
        return out.messages.at(-1).content;
      });
      export default entrypoint('pipeline', async (input) => ask(input.text));
    `,
        { agents: { research: {} } },
      );
      const store = yield* trackedStore;
      const binding: WorkflowAgentBinding = {
        name: 'research',
        kind: 'internal',
        agent: { id: 'agent-research', name: 'Research', instructions: 'research', model: 'test:test' },
      };

      const bus = yield* runExecutor({
        workflow,
        agents: [binding],
        services: services(store, 'streamed reply'),
        requestContexts: [requestContextFor([{ kind: 'data', data: { text: 'why?' } }])],
      });

      expect(terminalState(bus.statuses)).toBe('completed');
      const deltas = stepEvents(store.events, 'step-progress').filter((event) => event.state === 'a2a-artifact');
      expect(deltas.length).toBeGreaterThan(1);
      expect(deltas.every((event) => event.stepId === 'ask' && event.data.agentId === 'agent-research')).toBe(true);
      expect(deltas.map((event) => event.data.text).join('')).toBe('streamed reply');
    }),
  );

  it.live('exposes a bound integration tool as context.tools and reports each call as step progress', () =>
    Effect.gen(function* () {
      const workflow = yield* loadWorkflow(
        `
      import { entrypoint, getConfig, task } from '@langchain/langgraph';
      const publish = task('publish', async (post) => {
        const tool = getConfig().context.tools.publish_post;
        return tool.invoke({ title: post.title, channel: 'blog' });
      });
      export default entrypoint('publisher', async (input) => publish(input));
    `,
        { tools: { publish_post: {} } },
      );
      const store = yield* trackedStore;
      const calls: Array<[string, unknown]> = [];
      const binding: WorkflowAgentBinding = {
        name: 'publish_post',
        kind: 'tool',
        tool: {
          id: 'tools.mock.org.mock.publish_post',
          name: 'publish_post',
          description: 'Publish a post.',
          inputSchema: {
            type: 'object',
            required: ['title', 'channel'],
            properties: { title: { type: 'string' }, channel: { type: 'string' } },
          },
        },
      };
      const layer = Layer.mergeAll(
        store.layer,
        agentServicesLayer('unused'),
        WorkflowToolInvoker.fromFunctions({
          'tools.mock.org.mock.publish_post': async (input) => {
            calls.push(['tools.mock.org.mock.publish_post', input]);
            return { status: 'published', url: 'https://mock.example/blog/1' };
          },
        }),
      );

      const bus = yield* runExecutor({
        workflow,
        agents: [binding],
        services: layer,
        requestContexts: [requestContextFor([{ kind: 'data', data: { title: 'Hello' } }])],
      });

      expect(terminalState(bus.statuses)).toBe('completed');
      expect(calls).toEqual([['tools.mock.org.mock.publish_post', { title: 'Hello', channel: 'blog' }]]);
      expect(decodeJsonString(stepEvents(store.events, 'run-completed')[0]?.output ?? '')).toEqual({
        status: 'published',
        url: 'https://mock.example/blog/1',
      });
      const progress = stepEvents(store.events, 'step-progress').filter((event) => event.stepId === 'publish');
      expect(progress.map((event) => event.state)).toEqual(['tool-call', 'tool-result']);
      expect(progress[0]?.data).toMatchObject({ tool: 'tools.mock.org.mock.publish_post', name: 'publish_post' });
    }),
  );

  it.live('rejects tool arguments that do not satisfy the catalog schema before calling the host', () =>
    Effect.gen(function* () {
      const workflow = yield* loadWorkflow(
        `
      import { entrypoint, getConfig, task } from '@langchain/langgraph';
      const publish = task('publish', async () => getConfig().context.tools.publish_post.invoke({ title: 42 }));
      export default entrypoint('publisher', async (input) => publish(input));
    `,
        { tools: { publish_post: {} } },
      );
      const store = yield* trackedStore;
      let called = false;
      const binding: WorkflowAgentBinding = {
        name: 'publish_post',
        kind: 'tool',
        tool: {
          id: 'tool-1',
          name: 'publish_post',
          description: 'Publish a post.',
          inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
        },
      };
      const layer = Layer.mergeAll(
        store.layer,
        agentServicesLayer('unused'),
        WorkflowToolInvoker.fromFunctions({
          'tool-1': async () => {
            called = true;
            return null;
          },
        }),
      );

      const bus = yield* runExecutor({
        workflow,
        agents: [binding],
        services: layer,
        requestContexts: [requestContextFor([{ kind: 'data', data: {} }])],
      });

      expect(terminalState(bus.statuses)).toBe('failed');
      expect(called).toBe(false);
      expect(stepEvents(store.events, 'step-failed')[0]?.error).toContain('did not match expected schema');
    }),
  );

  const approvalGatedPublisher = `
    import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
    const State = Annotation.Root({ title: Annotation(), receipt: Annotation() });
    export default new StateGraph(State)
      .addNode('publish', async (state, config) => ({
        receipt: await config.context.tools.publish_post.invoke({ title: state.title }),
      }))
      .addEdge(START, 'publish')
      .addEdge('publish', END)
      .compile();
  `;

  const publishPostBinding: WorkflowAgentBinding = {
    name: 'publish_post',
    kind: 'tool',
    tool: {
      id: 'tools.mock.publish_post',
      name: 'publish_post',
      description: 'Publish a post.',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    },
  };

  type GatewayState = { decision: 'pending' | 'accept' | 'decline'; calls: number };

  /** Freezes every call until the test decides it, then hands back the decided outcome like the gateway does. */
  const approvalGateway = () => {
    const state: GatewayState = { decision: 'pending', calls: 0 };
    const layer = WorkflowToolInvoker.make((toolId, input) =>
      Effect.suspend(() => {
        state.calls += 1;
        switch (state.decision) {
          case 'pending':
            return Effect.succeed<Json>({
              status: 'input-required',
              request: workflowA2AToolApprovalRequestEnvelope({
                actionId: WorkflowPendingActionId.make('approval-1'),
                title: `Approve ${toolId}`,
                tool: { path: toolId, args: input },
              }),
            });
          case 'accept':
            return Effect.succeed<Json>({ status: 'published', url: 'https://mock.example/blog/1' });
          case 'decline':
            return Effect.fail(
              new WorkflowToolInvokeError({ message: `Tool '${toolId}' was denied: declined`, error: null }),
            );
        }
      }),
    );
    return { state, layer };
  };

  const approvalAnswer = (action: 'accept' | 'decline') =>
    requestContextFor([
      {
        kind: 'data',
        data: { type: 'workflow-human-input-response', actionId: 'approval-1', response: { action } },
      },
    ]);

  it.live('pauses on a tool call frozen for approval and collects the decided call on resume', () =>
    Effect.gen(function* () {
      const workflow = yield* loadWorkflow(approvalGatedPublisher, { tools: { publish_post: {} } });
      const store = yield* trackedStore;
      const gateway = approvalGateway();
      const layer = Layer.mergeAll(store.layer, agentServicesLayer('unused'), gateway.layer);
      const checkpointer = new MemorySaver();

      const first = yield* runExecutor({
        workflow,
        agents: [publishPostBinding],
        services: layer,
        checkpointer,
        requestContexts: [requestContextFor([{ kind: 'data', data: { title: 'Hello' } }])],
      });

      expect(first.statuses.at(-1)?.status.state).toBe('input-required');
      // The pending action is the gateway approval itself, so answering it decides the frozen call.
      expect(store.pendingActions.map((action) => action.id)).toEqual(['approval-1']);
      expect(store.pendingActions[0]?.request).toMatchObject({ type: 'workflow-tool-approval-request' });
      expect(stepEvents(store.events, 'run-completed')).toHaveLength(0);

      gateway.state.decision = 'accept';
      const second = yield* runExecutor({
        workflow,
        agents: [publishPostBinding],
        services: layer,
        checkpointer,
        requestContexts: [approvalAnswer('accept')],
      });

      expect(terminalState(second.statuses)).toBe('completed');
      expect(gateway.state.calls).toBe(2);
      expect(decodeJsonString(stepEvents(store.events, 'run-completed')[0]?.output ?? '')).toMatchObject({
        receipt: { status: 'published', url: 'https://mock.example/blog/1' },
      });
    }),
  );

  it.live('fails the step when the frozen tool call is declined', () =>
    Effect.gen(function* () {
      const workflow = yield* loadWorkflow(approvalGatedPublisher, { tools: { publish_post: {} } });
      const store = yield* trackedStore;
      const gateway = approvalGateway();
      const layer = Layer.mergeAll(store.layer, agentServicesLayer('unused'), gateway.layer);
      const checkpointer = new MemorySaver();

      yield* runExecutor({
        workflow,
        agents: [publishPostBinding],
        services: layer,
        checkpointer,
        requestContexts: [requestContextFor([{ kind: 'data', data: { title: 'Hello' } }])],
      });
      gateway.state.decision = 'decline';
      const second = yield* runExecutor({
        workflow,
        agents: [publishPostBinding],
        services: layer,
        checkpointer,
        requestContexts: [approvalAnswer('decline')],
      });

      expect(terminalState(second.statuses)).toBe('failed');
      expect(stepEvents(store.events, 'step-failed')[0]?.error).toContain('was denied');
      expect(stepEvents(store.events, 'run-completed')).toHaveLength(0);
    }),
  );

  it.live('rejects a task that does not satisfy the manifest input contract', () =>
    Effect.gen(function* () {
      const workflow = yield* loadWorkflow(
        `
      import { entrypoint } from '@langchain/langgraph';
      export default entrypoint('p', async (i) => 'ok');
    `,
        { input: { type: 'object', required: ['week'], properties: { week: { type: 'integer' } } } },
      );
      const store = yield* trackedStore;

      const bus = yield* runExecutor({
        workflow,
        services: services(store),
        requestContexts: [requestContextFor([{ kind: 'data', data: { notWeek: true } }])],
      });

      expect(bus.statuses.at(-1)?.status.state).toBe('rejected');
      expect(store.events).toHaveLength(0);
    }),
  );
});

describe('workflow cancellation', () => {
  it.live('aborts a blocked activity and publishes a terminal canceled task', () =>
    Effect.gen(function* () {
      const workflow = yield* loadWorkflow(`
      import { entrypoint, getConfig, task } from '@langchain/langgraph';
      const wait = task('wait', async () => new Promise((resolve) => {
        const signal = getConfig().signal;
        if (signal.aborted) resolve('canceled');
        else signal.addEventListener('abort', () => resolve('canceled'), { once: true });
      }));
      export default entrypoint('blocked', async () => wait());
    `);
      const store = yield* trackedStore;
      const run = yield* promiseRunner;
      const executor = new WorkflowTaskExecutor(workflow, [], {
        checkpointer: new MemorySaver(),
        run: (effect) => run(effect.pipe(Effect.provide(services(store)))),
      });
      const bus = harness();
      const running = executor.execute(requestContextFor([{ kind: 'text', text: 'start' }]), bus.eventBus);
      yield* Effect.promise(() =>
        expect
          .poll(() => store.events.some((event) => event.type === 'step-started' && event.stepId === 'wait'))
          .toBe(true),
      );
      yield* Effect.promise(() => executor.cancelTask('task-1', bus.eventBus));
      yield* Effect.promise(() => running);
      expect(bus.statuses.at(-1)?.status.state).toBe('canceled');
      expect(store.events.at(-1)?.type).toBe('run-canceled');
    }),
  );
});

describe('human input via interrupt()', () => {
  const gatedWorkflow = `
    import { entrypoint, interrupt, task } from '@langchain/langgraph';
    const finish = task('finish', async (decision) => 'decided: ' + decision);
    export default entrypoint('gated', async (input) => {
      const answer = interrupt({ title: 'Approve?', input: { subject: input.text } });
      return finish(answer.decision);
    });
  `;

  it.live('pauses the run as input-required and records a pending action', () =>
    Effect.gen(function* () {
      const workflow = yield* loadWorkflow(gatedWorkflow);
      const store = yield* trackedStore;

      const bus = yield* runExecutor({
        workflow,
        services: services(store),
        requestContexts: [requestContextFor([{ kind: 'data', data: { text: 'the thing' } }])],
      });

      expect(bus.statuses.at(-1)?.status.state).toBe('input-required');
      expect(store.pendingActions).toHaveLength(1);
      expect(store.pendingActions[0]?.status).toBe('pending');
      expect(stepEvents(store.events, 'human-input-requested')[0]?.title).toBe('Approve?');
    }),
  );

  it.live('resumes the same task with the response and completes', () =>
    Effect.gen(function* () {
      const workflow = yield* loadWorkflow(gatedWorkflow);
      const store = yield* trackedStore;
      const layer = services(store);
      // The same checkpointer across both executions is what lets the resumed
      // task rejoin its own suspended graph.
      const checkpointer = new MemorySaver();

      const first = yield* runExecutor({
        workflow,
        services: layer,
        checkpointer,
        requestContexts: [requestContextFor([{ kind: 'data', data: { text: 'the thing' } }])],
      });
      expect(first.statuses.at(-1)?.status.state).toBe('input-required');

      const actionId = store.pendingActions[0]?.id;
      expect(actionId).toBeDefined();

      const second = yield* runExecutor({
        workflow,
        services: layer,
        checkpointer,
        requestContexts: [
          requestContextFor([
            {
              kind: 'data',
              data: {
                type: 'workflow-human-input-response',
                actionId,
                response: { decision: 'approve' },
              },
            },
          ]),
        ],
      });

      expect(terminalState(second.statuses)).toBe('completed');
      expect(stepEvents(store.events, 'run-completed').at(-1)?.output).toContain('decided: approve');
      expect(stepEvents(store.events, 'human-input-resolved')).toHaveLength(1);
    }),
  );

  it.live('recovers a saved approval request before its workflow action was resolved', () =>
    Effect.gen(function* () {
      const workflow = yield* loadWorkflow(gatedWorkflow);
      const store = yield* trackedStore;
      const layer = services(store);
      const checkpointer = new MemorySaver();
      yield* runExecutor({
        workflow,
        services: layer,
        checkpointer,
        requestContexts: [requestContextFor([{ kind: 'data', data: { text: 'subject' } }])],
      });
      const request = new A2ARequestContext(
        {
          kind: 'message',
          role: 'user',
          messageId: 'saved-resume',
          parts: [{ kind: 'data', data: { type: 'input-required-response', response: { decision: 'approve' } } }],
        },
        'task-1',
        'context-1',
      );
      const recovered = yield* runExecutor({
        workflow,
        services: layer,
        checkpointer,
        recover: true,
        requestContexts: [request],
      });
      expect(terminalState(recovered.statuses)).toBe('completed');
      expect(stepEvents(store.events, 'run-completed').at(-1)?.output).toContain('decided: approve');
    }),
  );

  it.live('exposes and resumes every parallel workflow interrupt by its native ID', () =>
    Effect.gen(function* () {
      const workflow = yield* loadWorkflow(`
      import { StateGraph, Annotation, interrupt } from '@langchain/langgraph';
      const State = Annotation.Root({ results: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }) });
      export default new StateGraph(State)
        .addNode('left', () => ({ results: [interrupt({ title: 'left' })] }))
        .addNode('right', () => ({ results: [interrupt({ title: 'right' })] }))
        .addEdge('__start__', 'left').addEdge('__start__', 'right')
        .addEdge('left', '__end__').addEdge('right', '__end__')
        .compile();
    `);
      const store = yield* trackedStore;
      const layer = services(store);
      const checkpointer = new MemorySaver();
      const first = yield* runExecutor({
        workflow,
        services: layer,
        checkpointer,
        requestContexts: [requestContextFor([{ kind: 'data', data: { results: [] } }])],
      });
      expect(first.statuses.at(-1)?.status.state).toBe('input-required');
      const interrupts = z
        .array(z.object({ id: z.string(), value: z.object({ title: z.string() }) }))
        .parse(store.pendingActions.at(-1)?.request.interrupts);
      expect(interrupts.map((item) => item.value.title).sort()).toEqual(['left', 'right']);
      const response = Object.fromEntries(interrupts.map((item) => [item.id, `${item.value.title}-approved`]));
      const request = new A2ARequestContext(
        {
          kind: 'message',
          role: 'user',
          messageId: 'parallel-resume',
          parts: [{ kind: 'data', data: { type: 'input-required-response', response } }],
        },
        'task-1',
        'context-1',
      );
      const second = yield* runExecutor({ workflow, services: layer, checkpointer, requestContexts: [request] });
      expect(terminalState(second.statuses)).toBe('completed');
      expect(stepEvents(store.events, 'run-completed').at(-1)?.output).toBe(
        '{"results":["left-approved","right-approved"]}',
      );
    }),
  );

  it.live('rejects a human-input response when no run is waiting on that task', () =>
    Effect.gen(function* () {
      const workflow = yield* loadWorkflow(gatedWorkflow);
      const store = yield* trackedStore;

      const bus = yield* runExecutor({
        workflow,
        services: services(store),
        requestContexts: [
          requestContextFor([
            {
              kind: 'data',
              data: {
                type: 'workflow-human-input-response',
                actionId: 'never-issued',
                response: { decision: 'approve' },
              },
            },
          ]),
        ],
      });

      expect(bus.statuses.at(-1)?.status.state).toBe('rejected');
    }),
  );
});

/** Answers each model call with the next scripted message, tool calls included. */
class ScriptedChatModel extends BaseChatModel {
  private calls = 0;

  constructor(private readonly script: ReadonlyArray<AIMessage<StandardMessageStructure>>) {
    super({});
  }

  _llmType(): string {
    return 'scripted';
  }

  override bindTools(): this {
    return this;
  }

  async _generate(): Promise<ChatResult> {
    const message = this.script[Math.min(this.calls, this.script.length - 1)] ?? new AIMessage('');
    this.calls += 1;
    return { generations: [{ text: '', message }] };
  }
}

const scriptedServices = (
  store: TrackedStore,
  script: () => ReadonlyArray<AIMessage<StandardMessageStructure>>,
  tools: AgentToolSet = [],
) =>
  Layer.mergeAll(
    store.layer,
    FetchHttpClient.layer,
    Layer.succeed(AgentLoopFactory, AgentLoopFactory.of({ create: () => Effect.die('AgentLoopFactory unused') })),
    Layer.succeed(
      ModelProvider,
      ModelProvider.of({
        resolve: (model) =>
          Effect.succeed({
            provider: 'test',
            model,
            modelId: model,
            config: { chatModel: new ScriptedChatModel(script()) },
          }),
      }),
    ),
    AgentToolResolver.static(tools),
    AgentRunStore.inMemory,
    WorkflowToolInvoker.none,
  );

describe('what a step does', () => {
  it.live('binds a platform model as context.models and records each call on the calling step', () =>
    Effect.gen(function* () {
      const workflow = yield* loadWorkflow(
        `
      import { END, START, StateGraph, StateSchema } from '@langchain/langgraph';
      import { z } from 'zod';
      const State = new StateSchema({ question: z.string(), answer: z.string().default('') });
      export default new StateGraph(State)
        .addNode('route', async (state, config) => ({
          answer: (await config.context.models.router.invoke(state.question)).text,
        }))
        .addEdge(START, 'route')
        .addEdge('route', END)
        .compile();
    `,
        { models: { router: { default: 'test:router' } } },
      );
      const store = yield* trackedStore;
      const bus = yield* runExecutor({
        workflow,
        agents: [{ name: 'router', kind: 'model', model: 'test:router' }],
        services: scriptedServices(store, () => [
          new AIMessage({
            content: 'billing',
            usage_metadata: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
          }),
        ]),
        requestContexts: [requestContextFor([{ kind: 'data', data: { question: 'Where is my invoice?' } }])],
      });

      expect(terminalState(bus.statuses)).toBe('completed');
      const calls = stepEvents(store.events, 'step-progress').filter((event) => event.state === 'model-call');
      expect(calls.map((event) => [event.stepId, event.data.modelName, event.data.model])).toEqual([
        ['route', 'router', 'test:router'],
      ]);
      expect(calls[0]?.data.usage).toMatchObject({ input: 12, output: 3, total: 15 });
    }),
  );

  it.live("reports a bound agent's tool calls and model calls as progress of its step, and records them", () =>
    Effect.gen(function* () {
      const workflow = yield* loadWorkflow(
        `
      import { END, START, StateGraph, StateSchema } from '@langchain/langgraph';
      import { z } from 'zod';
      const State = new StateSchema({ question: z.string(), answer: z.string().default('') });
      export default new StateGraph(State)
        .addNode('research', async (state, config) => {
          const out = await config.context.agents.research.invoke({ messages: [{ role: 'user', content: state.question }] });
          return { answer: out.messages.at(-1).text };
        })
        .addEdge(START, 'research')
        .addEdge('research', END)
        .compile();
    `,
        { agents: { research: {} } },
      );
      const store = yield* trackedStore;
      const lookup = defineAgentTool({
        name: 'lookup',
        description: 'Looks a record up.',
        schema: z.object({ id: z.string() }),
        invoke: async ({ id }) => ({ id, found: true }),
      });
      const layer = scriptedServices(
        store,
        () => [
          new AIMessage({ content: '', tool_calls: [{ id: 'call-1', name: 'lookup', args: { id: '42' } }] }),
          new AIMessage('found 42'),
        ],
        [lookup],
      );
      const agentRuns = Layer.succeed(
        AgentRunStore,
        yield* AgentRunStore.use(Effect.succeed).pipe(Effect.provide(AgentRunStore.inMemory)),
      );
      const bus = yield* runExecutor({
        workflow,
        agents: [
          {
            name: 'research',
            kind: 'internal',
            agent: { id: 'agent-research', name: 'Research', instructions: 'research', model: 'test:research' },
          },
        ],
        services: Layer.mergeAll(layer, agentRuns),
        requestContexts: [requestContextFor([{ kind: 'data', data: { question: 'What is 42?' } }])],
      });

      expect(terminalState(bus.statuses)).toBe('completed');
      const progress = stepEvents(store.events, 'step-progress').filter((event) => event.stepId === 'research');
      expect(progress.map((event) => event.state)).toEqual(
        expect.arrayContaining(['agent-tool-call', 'agent-tool-result', 'model-call']),
      );
      expect(progress.find((event) => event.state === 'agent-tool-result')?.data).toMatchObject({
        agentId: 'agent-research',
        toolName: 'lookup',
        output: '{"id":"42","found":true}',
      });
      const [record] = yield* AgentRunStore.use((runs) => runs.listByWorkflowRun(store.events[0]?.runId ?? '')).pipe(
        Effect.provide(agentRuns),
      );
      const recorded = record?.history.flatMap((message) =>
        message.parts.flatMap((part) => (part.kind === 'data' ? [part.data.type] : [])),
      );
      expect(recorded).toEqual(['tool-call', 'tool-result']);
    }),
  );
});
