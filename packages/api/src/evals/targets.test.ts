import { describe, expect, it } from '@effect/vitest';
import {
  AgentLoopError,
  type AgentLoopEvent,
  AgentLoopFactory,
  AgentRunStore,
  type AgentToolContext,
  AgentToolResolver,
  ModelProvider,
} from 'agentdock-sdk';
import type { CreateAgentInput, JsonObject, Model, WorkflowRunEvent } from 'agentdock-sdk/schemas';
import { WorkflowId, WorkflowRunEventId, WorkflowRunId } from 'agentdock-sdk/schemas';
import { WorkflowRunStore } from 'agentdock-sdk/workflows';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import { AgentRegistry, AgentRegistryLive } from '../agents/service';
import { ServerConfig } from '../config';
import { ModelCatalog } from '../models/catalog';
import { SkillRegistryLive } from '../skills/service';
import { WorkflowRegistry } from '../workflows/service';
import { EvalTargets, EvalTargetsLive, workflowActivity } from './targets';

const agentInput: CreateAgentInput = {
  name: 'Support agent',
  description: 'Answers tickets',
  integrations: {},
  skills: {},
  communication: { allowAll: false, allowedAgentIds: [] },
  instructions: 'Help the customer.',
  model: 'openai:gpt-5.6-luna',
  version: '0.1.0',
  capabilities: { pushNotifications: false, streaming: true },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
};

const openaiTokens = { input: 1_000, cacheRead: 600, cacheWrite: 0, output: 120, reasoning: 80, total: 1_120 };
const answerTokens = { input: 1_500, cacheRead: 1_000, cacheWrite: 0, output: 60, reasoning: 0, total: 1_560 };
const subagentTokens = { input: 300, cacheRead: 0, cacheWrite: 100, output: 50, reasoning: 20, total: 350 };

const toolEvents: ReadonlyArray<AgentLoopEvent> = [
  {
    type: 'model-call',
    model: 'openai:gpt-5.6-luna',
    usage: openaiTokens,
    toolCalls: 2,
    reasoningEstimated: false,
  },
  { type: 'tool-call', toolCallId: 'call-1', toolName: 'crm.lookup', input: { email: 'a@b.c' } },
  { type: 'tool-call', toolCallId: 'call-2', toolName: 'orders.refund', input: { order: 7 } },
  { type: 'tool-error', toolCallId: 'call-2', toolName: 'orders.refund', error: 'not allowed' },
  { type: 'tool-result', toolCallId: 'call-1', toolName: 'crm.lookup', output: { plan: 'pro' } },
];

/** A `send_task` relay two delegations deep, the way `delegate` nests them. */
const relayedSubagentCall = {
  type: 'send-task-progress',
  toolName: 'send_task',
  agentId: 'billing',
  taskId: 'task-1',
  state: 'working',
  event: {
    type: 'send-task-progress',
    toolName: 'send_task',
    agentId: 'ledger',
    taskId: 'task-2',
    state: 'working',
    event: {
      type: 'model-call',
      model: 'anthropic:claude-test',
      usage: subagentTokens,
      toolCalls: 0,
      reasoningEstimated: true,
    },
  },
};

/**
 * Plays one tool-use step, one delegated subagent call and the answer. The
 * tool context is captured at resolution so the loop can relay through its
 * `emit` as `send_task` would. Inputs starting with `fail` break after the
 * first model call.
 */
const scriptedRuntime = () => {
  let context: AgentToolContext | undefined;
  return Layer.mergeAll(
    Layer.succeed(
      AgentLoopFactory,
      AgentLoopFactory.of({
        create: () =>
          Effect.succeed({
            stream: (input, options) =>
              Effect.suspend(() => {
                for (const event of toolEvents) void options.onEvent(event);
                if (
                  'parts' in input &&
                  input.parts.some((part) => part.kind === 'text' && part.text.startsWith('fail'))
                ) {
                  return Effect.fail(new AgentLoopError({ message: 'The model is overloaded.', error: undefined }));
                }
                context?.emit?.(relayedSubagentCall);
                void options.onEvent({
                  type: 'model-call',
                  model: 'openai:gpt-5.6-luna',
                  usage: answerTokens,
                  toolCalls: 0,
                  reasoningEstimated: false,
                });
                return Effect.succeed({ text: 'Refund is not possible.', interrupted: false });
              }),
          }),
      }),
    ),
    Layer.succeed(
      ModelProvider,
      ModelProvider.of({ resolve: (model) => Effect.succeed({ model, provider: 'openai', modelId: 'gpt-5.6-luna' }) }),
    ),
    Layer.succeed(
      AgentToolResolver,
      AgentToolResolver.of({
        resolve: (_agent, toolContext) =>
          Effect.sync(() => {
            context = toolContext;
            return [];
          }),
      }),
    ),
  );
};

const rates = {
  'openai:gpt-5.6-luna': { inputCostPerMillion: 1, outputCostPerMillion: 10, cacheReadCostPerMillion: 0.1 },
  'anthropic:claude-test': {
    inputCostPerMillion: 3,
    outputCostPerMillion: 15,
    cacheReadCostPerMillion: 0.3,
    cacheWriteCostPerMillion: 3.75,
  },
} satisfies Record<string, Partial<Model>>;

const catalog = Layer.succeed(
  ModelCatalog,
  ModelCatalog.of({
    list: Effect.succeed([]),
    find: (value): Effect.Effect<Model> =>
      Effect.succeed({
        value,
        provider: 'test',
        providerName: 'Test',
        id: value,
        name: value,
        ...(value === 'openai:gpt-5.6-luna' || value === 'anthropic:claude-test' ? rates[value] : undefined),
      }),
  }),
);

const noWorkflows = Layer.succeed(
  WorkflowRegistry,
  WorkflowRegistry.of({
    register: () => Effect.die('unused'),
    list: () => Effect.succeed([]),
    getById: () => Effect.succeed(null),
    download: () => Effect.succeed(null),
    remove: () => Effect.succeed(false),
  }),
);

const serverConfig = Layer.succeed(
  ServerConfig,
  ServerConfig.of({
    host: '127.0.0.1',
    port: 0,
    apiBaseUrl: 'http://127.0.0.1:0',
    webOrigin: 'http://127.0.0.1:1',
    isProduction: false,
    internalMcpEndpoint: 'http://127.0.0.1:0/mcp/internal',
  }),
);

const targetsLayer = () =>
  EvalTargetsLive.pipe(
    Layer.provideMerge(Layer.mergeAll(AgentRegistryLive, AgentRunStore.inMemory, WorkflowRunStore.inMemory)),
    Layer.provide(
      Layer.mergeAll(SkillRegistryLive, scriptedRuntime(), noWorkflows, serverConfig, catalog, FetchHttpClient.layer),
    ),
  );

describe('EvalTargetsLive', () => {
  it.effect('runs an agent in a fresh context and pairs its tool calls with their outcomes', () =>
    Effect.gen(function* () {
      const agent = yield* AgentRegistry.use((registry) => registry.add(agentInput));
      const targets = yield* EvalTargets;
      const target = yield* targets.resolve({ kind: 'agent', id: agent.id });
      expect(target).toEqual({
        kind: 'agent',
        id: agent.id,
        name: 'Support agent',
        model: 'openai:gpt-5.6-luna',
        revision: 1,
      });

      const { output } = yield* targets.run(target, 'Can I get a refund?');
      expect(output).toMatchObject({ text: 'Refund is not possible.', state: 'completed' });
      expect(output.toolCalls).toEqual([
        { toolName: 'crm.lookup', toolCallId: 'call-1', input: { email: 'a@b.c' }, output: { plan: 'pro' } },
        { toolName: 'orders.refund', toolCallId: 'call-2', input: { order: 7 }, error: 'not allowed' },
      ]);

      const record = yield* AgentRunStore.use((store) => store.get(output.agentRunId ?? ''));
      expect(record?.origin).toEqual({ surface: 'eval' });
    }).pipe(Effect.provide(targetsLayer())),
  );

  it.effect('prices every model call and splits the spend by loop phase, model and token kind', () =>
    Effect.gen(function* () {
      const agent = yield* AgentRegistry.use((registry) => registry.add(agentInput));
      const targets = yield* EvalTargets;
      const { usage } = yield* targets.run(yield* targets.resolve({ kind: 'agent', id: agent.id }), 'Refund?');

      expect(usage?.total).toMatchObject({ calls: 3, reasoningEstimated: true });
      expect(usage?.phases.map((entry) => [entry.phase, entry.usage.calls, entry.usage.tokens.input])).toEqual([
        ['tool-use', 1, 1_000],
        ['answer', 1, 1_500],
        ['subagents', 1, 300],
      ]);
      expect(usage?.models.map((entry) => [entry.model, entry.usage.calls])).toEqual([
        ['openai:gpt-5.6-luna', 2],
        ['anthropic:claude-test', 1],
      ]);

      const toolUse = usage?.phases.find((entry) => entry.phase === 'tool-use')?.usage.cost;
      expect(toolUse?.input).toBeCloseTo((400 * 1) / 1_000_000);
      expect(toolUse?.cacheRead).toBeCloseTo((600 * 0.1) / 1_000_000);
      expect(toolUse?.output).toBeCloseTo((120 * 10) / 1_000_000);
      expect(toolUse?.reasoning).toBeCloseTo((80 * 10) / 1_000_000);
      const subagents = usage?.phases.find((entry) => entry.phase === 'subagents')?.usage.cost;
      expect(subagents?.input).toBeCloseTo((200 * 3) / 1_000_000);
      expect(subagents?.cacheWrite).toBeCloseTo((100 * 3.75) / 1_000_000);
      const phaseTotal = (usage?.phases ?? []).reduce((total, entry) => total + (entry.usage.cost?.total ?? 0), 0);
      expect(usage?.total.cost?.total).toBeCloseTo(phaseTotal);
    }).pipe(Effect.provide(targetsLayer())),
  );

  it.effect('keeps what a failed trial spent on the error', () =>
    Effect.gen(function* () {
      const agent = yield* AgentRegistry.use((registry) => registry.add(agentInput));
      const targets = yield* EvalTargets;
      const error = yield* Effect.flip(
        targets.run(yield* targets.resolve({ kind: 'agent', id: agent.id }), 'fail this'),
      );
      expect(error.message).toBe('The model is overloaded.');
      expect(error.usage?.phases.map((entry) => entry.phase)).toEqual(['tool-use']);
      expect(error.usage?.total.tokens.input).toBe(1_000);
    }).pipe(Effect.provide(targetsLayer())),
  );

  it.effect('refuses a target that does not exist', () =>
    Effect.gen(function* () {
      const targets = yield* EvalTargets;
      const agent = yield* Effect.flip(targets.resolve({ kind: 'agent', id: 'nope' }));
      const workflow = yield* Effect.flip(targets.resolve({ kind: 'workflow', id: 'nope' }));
      expect(agent.message).toBe("The agent 'nope' does not exist.");
      expect(workflow.message).toBe("The workflow 'nope' does not exist.");
    }).pipe(Effect.provide(targetsLayer())),
  );
});

describe('workflowActivity', () => {
  const base = {
    runId: WorkflowRunId.make('wfr_1'),
    workflowId: WorkflowId.make('wf_1'),
    taskId: 'task-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    stepId: 'team:research',
    label: 'team:research',
    type: 'step-progress',
  } as const;
  const progress = (id: string, state: string, data: JsonObject): WorkflowRunEvent => ({
    ...base,
    id: WorkflowRunEventId.make(id),
    state,
    data,
  });
  const usage = { input: 100, cacheRead: 0, cacheWrite: 0, output: 20, reasoning: 0, total: 120 };

  it('sums the model calls and pairs the tool calls of a workflow run', () => {
    const activity = workflowActivity([
      progress('e1', 'agent-tool-call', {
        agentId: 'research',
        type: 'tool-call',
        toolName: 'search',
        toolCallId: 'c1',
        input: { q: '42' },
      }),
      progress('e2', 'agent-tool-result', {
        agentId: 'research',
        type: 'tool-result',
        toolName: 'search',
        toolCallId: 'c1',
        output: ['ref-1'],
      }),
      progress('e3', 'model-call', {
        agentId: 'research',
        model: 'openai:gpt-6-luna',
        usage,
        toolCalls: 1,
        reasoningEstimated: false,
      }),
      progress('e4', 'model-call', {
        modelName: 'router',
        model: 'openai:gpt-6-luna',
        usage: null,
        toolCalls: 0,
        reasoningEstimated: false,
      }),
      progress('e5', 'agent-delegation', {
        agentId: 'research',
        event: {
          type: 'send-task-progress',
          agentId: 'citations',
          taskId: 'sub-1',
          state: 'working',
          event: { type: 'model-call', model: 'anthropic:claude-test', usage, toolCalls: 0, reasoningEstimated: false },
        },
      }),
      progress('e6', 'tool-call', { tool: 'tools.x.org.default.publish', name: 'publish', input: { title: 't' } }),
      progress('e7', 'tool-result', { tool: 'tools.x.org.default.publish', name: 'publish', output: { url: 'u' } }),
    ]);

    expect(activity.calls).toEqual([
      { source: 'agent', model: 'openai:gpt-6-luna', usage, toolCalls: 1, reasoningEstimated: false },
      { source: 'agent', model: 'openai:gpt-6-luna', usage: undefined, toolCalls: 0, reasoningEstimated: false },
      { source: 'subagent', model: 'anthropic:claude-test', usage, toolCalls: 0, reasoningEstimated: false },
    ]);
    expect(activity.toolCalls).toEqual([
      { toolName: 'search', toolCallId: 'c1', input: { q: '42' }, output: ['ref-1'] },
      { toolName: 'publish', toolCallId: 'team:research:publish:1', input: { title: 't' }, output: { url: 'u' } },
    ]);
  });
});
