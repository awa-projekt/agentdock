import { describe, expect, it } from '@effect/vitest';
import type { BaseMessage } from '@langchain/core/messages';
import { type ToolRuntime, tool } from '@langchain/core/tools';
import { isNodeTimeoutError, MemorySaver } from '@langchain/langgraph';
import { createAgent } from 'langchain';
import { z } from 'zod';
import type { Agent, Participant, StepPolicies } from './core.ts';
import { createEvaluatorOptimizer } from './evaluator-optimizer.ts';
import { createOrchestrator } from './orchestrator.ts';
import { createParallel } from './parallel.ts';
import { agentStep, createPipeline } from './pipeline.ts';
import { createRouter } from './router.ts';
import { Answer, echoAgent, request, roleModel, spec } from './test-support.ts';
import type { ModelTurn } from './testing.ts';
import { createVoting } from './voting.ts';

const lastText = (messages: ReadonlyArray<BaseMessage>) => messages.at(-1)?.text ?? '';

const routerPolicy = (targets: ReadonlyArray<string>) => (turn: ModelTurn) =>
  turn.structured({ routes: targets.map((agent) => ({ agent, task: `task for ${agent}` })) });

const Verdict = z.object({ passed: z.boolean() }).meta({ title: 'Verdict' });

/** Wraps a participant so its first `failures` calls throw. */
const flaky = <Structured>(agent: Agent<Structured>, failures: number): Agent<Structured> => {
  let calls = 0;
  return {
    invoke: async (input, config) => {
      calls += 1;
      if (calls <= failures) throw new Error('flaky');
      return agent.invoke(input, config);
    },
  };
};

const retry = { retryOn: (error: Error) => error.message === 'flaky', initialInterval: 0, jitter: false };

/** Wraps a participant so its first `calls` calls hang until their step is aborted. */
const hangs = (agent: Agent, calls: number): Agent => {
  let count = 0;
  return {
    invoke: async (input, config) => {
      count += 1;
      if (count <= calls) {
        await new Promise<never>((_, reject) => {
          config?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return agent.invoke(input, config);
    },
  };
};

const FACTORIES = ['parallel', 'pipeline', 'router', 'orchestrator', 'voting'] as const;

/** `factory` with `worker` as its only participant, under `policies` (retry policy, timeout). */
const oneWorkerGraph = (factory: (typeof FACTORIES)[number], worker: Participant, policies: StepPolicies): Agent => {
  switch (factory) {
    case 'parallel':
      return createParallel({ branches: [worker], ...policies });
    case 'pipeline':
      return createPipeline({ steps: [agentStep({ name: 'w', agent: worker.agent })], ...policies });
    case 'router':
      return createRouter({
        model: roleModel({ router: routerPolicy(['w']), synth: (turn) => turn.say('done') }),
        routes: [worker],
        systemPrompt: 'role=router',
        synthesizerPrompt: 'role=synth',
        ...policies,
      });
    case 'orchestrator':
      return createOrchestrator({
        model: roleModel({
          plan: (turn) => turn.structured({ tasks: [{ worker: 'w', instruction: 'go' }] }),
          synth: (turn) => turn.say('done'),
        }),
        workers: [worker],
        plannerPrompt: 'role=plan',
        synthesizerPrompt: 'role=synth',
        ...policies,
      });
    case 'voting':
      return createVoting({ voter: worker, n: 1, ...policies });
  }
};

const generator = (counter: { generated: number }) =>
  createAgent({
    model: roleModel({
      gen: (turn) => {
        counter.generated += 1;
        return turn.structured({ text: 'draft' });
      },
    }),
    tools: [],
    systemPrompt: 'role=gen',
    responseFormat: Answer,
  });

const reviewer = () =>
  createAgent({
    model: roleModel({ rev: (turn) => turn.structured({ passed: true }) }),
    tools: [],
    systemPrompt: 'role=rev',
    responseFormat: Verdict,
  });

describe('retryPolicy and timeout', () => {
  it('retries only the step that failed', async () => {
    const counter = { generated: 0 };
    const loop = createEvaluatorOptimizer({
      generator: { name: 'write', agent: generator(counter) },
      evaluator: { name: 'review', agent: flaky(reviewer(), 1) },
      retryPolicy: retry,
    });
    expect((await loop.invoke(request('x'))).evaluation?.passed).toBe(true);
    expect(counter.generated).toBe(1);

    const without = createEvaluatorOptimizer({
      generator: { name: 'write', agent: generator(counter) },
      evaluator: { name: 'review', agent: flaky(reviewer(), 1) },
    });
    await expect(without.invoke(request('x'))).rejects.toThrow('flaky');
  });

  it.each(FACTORIES)('retries a failing participant of %s', async (factory) => {
    const worker: Participant = { name: 'w', description: 'The worker.', agent: flaky(echoAgent('w'), 1) };
    const graph = oneWorkerGraph(factory, worker, { retryPolicy: retry });

    expect(lastText((await graph.invoke(request('x'))).messages)).not.toBe('');
  });

  it.each(FACTORIES)('aborts a hung step of %s at its timeout and the retry runs it again', async (factory) => {
    const worker: Participant = { name: 'w', description: 'The worker.', agent: hangs(echoAgent('w'), 1) };
    // NodeTimeoutError is retryable by LangGraph's default `retryOn`.
    const graph = oneWorkerGraph(factory, worker, {
      retryPolicy: { initialInterval: 0, jitter: false, logWarning: false },
      timeout: 200,
    });

    expect(lastText((await graph.invoke(request('x'))).messages)).not.toBe('');
  });

  it('fails the run with NodeTimeoutError when a timed-out step is not retried', async () => {
    const graph = createParallel({
      branches: [{ name: 'w', description: 'The worker.', agent: hangs(echoAgent('w'), 1) }],
      timeout: 200,
    });

    const error = await graph.invoke(request('x')).then(
      () => undefined,
      (failure: Error) => failure,
    );
    expect(isNodeTimeoutError(error)).toBe(true);
  });
});

describe('checkpointer', () => {
  const makers = [
    ['parallel', (checkpointer: MemorySaver) => createParallel({ branches: [spec('a')], checkpointer })],
    [
      'pipeline',
      (checkpointer: MemorySaver) =>
        createPipeline({ steps: [agentStep({ name: 'a', agent: spec('a').agent })], checkpointer }),
    ],
    [
      'evaluator_optimizer',
      (checkpointer: MemorySaver) =>
        createEvaluatorOptimizer({
          generator: { name: 'write', agent: generator({ generated: 0 }) },
          evaluator: {
            name: 'review',
            model: roleModel({
              judge: (turn) => turn.structured({ passed: true, score: 1, issues: [], feedback: '' }),
            }),
            prompt: 'role=judge',
          },
          checkpointer,
        }),
    ],
  ] as const;

  it.each(makers)('%s takes a checkpointer', async (_, make) => {
    const graph = make(new MemorySaver());
    const config = { configurable: { thread_id: 't' } };

    await graph.invoke(request('x'), config);

    expect((await graph.getState(config)).values).toHaveProperty('messages');
  });
});

describe('run context', () => {
  const Tenant = z.object({ name: z.string() });
  const whoami = tool(async (_, runtime: ToolRuntime) => Tenant.parse(runtime.context).name, {
    name: 'whoami',
    description: 'The tenant of the run.',
    schema: z.object({}),
  });
  const worker = () =>
    createAgent({
      model: roleModel({
        w: (turn) => (turn.called('whoami') ? turn.say(`tenant ${turn.result('whoami')}`) : turn.call('whoami')),
      }),
      tools: [whoami],
      systemPrompt: 'role=w',
      name: 'w',
    });
  const patterns = [
    ['parallel', () => createParallel({ branches: [{ name: 'w', description: 'Asks.', agent: worker() }] })],
    ['pipeline', () => createPipeline({ steps: [agentStep({ name: 'w', agent: worker() })] })],
    [
      'router',
      () =>
        createRouter({
          model: roleModel({ r: (turn) => turn.say('unused') }),
          routes: [{ name: 'w', description: 'Asks.', agent: worker() }],
          routeFn: () => [{ agent: 'w', task: 'who?' }],
          synthesizerPrompt: 'role=r',
        }),
    ],
    [
      'evaluator_optimizer',
      () =>
        createEvaluatorOptimizer({
          generator: { name: 'w', agent: worker() },
          evaluator: { name: 'review', agent: reviewer() },
        }),
    ],
  ] as const;

  it.each(patterns)('reaches the agents inside %s', async (pattern, make) => {
    const graph: Agent = make();
    const result = await graph.invoke(request('who?'), { context: { name: pattern } });
    expect(JSON.stringify(result.messages.map((message) => message.text))).toContain(`tenant ${pattern}`);
  });
});
