import { describe, expect, it } from '@effect/vitest';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command, interrupt, MemorySaver } from '@langchain/langgraph';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { contextAgent } from './core.ts';
import { createEvaluatorOptimizer } from './evaluator-optimizer.ts';
import { createMapReduce } from './map-reduce.ts';
import { createOrchestrator } from './orchestrator.ts';
import { createParallel } from './parallel.ts';
import { agentStep, createPipeline, functionStep } from './pipeline.ts';
import { createRouter } from './router.ts';
import { Answer, add, echoAgent, request, roleModel, spec, toolSpec } from './test-support.ts';
import { createVoting } from './voting.ts';

const lastText = (messages: ReadonlyArray<BaseMessage>) => messages.at(-1)?.text ?? '';

type Drawable = { getGraphAsync(config: { readonly xray?: boolean | number }): Promise<{ nodes: object }> };

const drawn = async (graph: Drawable, xray: boolean | number = true) =>
  Object.keys((await graph.getGraphAsync({ xray })).nodes);

describe('graph view', () => {
  const tooled = (prefix: string) => echoAgent(prefix, prefix, [add]);
  const judge = createAgent({ model: roleModel({}), tools: [add], systemPrompt: 'role=judge', responseFormat: Answer });
  const cases = [
    [
      'router',
      () => createRouter({ model: roleModel({}), routes: [toolSpec('a'), toolSpec('b')], routeFn: () => [] }),
      ['a', 'b'],
    ],
    ['parallel', () => createParallel({ branches: [toolSpec('a'), toolSpec('b')] }), ['a', 'b']],
    ['voting', () => createVoting({ voter: toolSpec('classify') }), ['classify']],
    ['map_reduce', () => createMapReduce({ mapper: { name: 'triage', agent: tooled('m') } }), ['triage']],
    [
      'orchestrator',
      () => createOrchestrator({ model: roleModel({}), workers: [toolSpec('a'), toolSpec('b')] }),
      ['a', 'b'],
    ],
    [
      'pipeline',
      () =>
        createPipeline({
          steps: [agentStep({ name: 'a', agent: tooled('a') }), agentStep({ name: 'b', agent: tooled('b') })],
        }),
      ['a', 'b'],
    ],
    [
      'evaluator_optimizer',
      () =>
        createEvaluatorOptimizer({
          generator: { name: 'write', agent: tooled('gen') },
          evaluator: { name: 'review', agent: judge },
        }),
      ['review', 'write'],
    ],
  ] as const;

  it.each(cases)('draws the participants of %s as subgraphs under their names', async (_, make, expected) => {
    const graph = make();
    const subgraphs: Array<string> = [];
    for await (const [name] of graph.getSubgraphsAsync()) subgraphs.push(name);
    const nodes = await drawn(graph);

    expect(subgraphs.sort()).toEqual([...expected]);
    for (const name of expected) {
      expect(nodes).toEqual(expect.arrayContaining([`${name}:model_request`, `${name}:tools`]));
    }
  });

  it("draws each pattern's own nodes only where no participant runs", async () => {
    const bound = (name: string) => ({ name, description: name, agent: contextAgent(name) });
    const topologies = await Promise.all([
      drawn(createRouter({ model: roleModel({}), routes: [bound('billing'), bound('tech')] })),
      drawn(createParallel({ branches: [bound('legal'), bound('tech')], merge: 'submission' })),
      drawn(createOrchestrator({ model: roleModel({}), workers: [bound('researcher')] })),
      drawn(
        createPipeline({
          steps: [
            agentStep({ name: 'draft', agent: contextAgent('writer') }),
            functionStep({ name: 'publish', run: async () => 'ok' }),
          ],
        }),
      ),
      drawn(
        createEvaluatorOptimizer({
          generator: bound('research'),
          evaluator: { name: 'review', model: roleModel({}), prompt: 'Check.' },
        }),
      ),
    ]);

    expect(topologies.map((nodes) => nodes.filter((node) => !node.startsWith('__')).sort())).toEqual([
      ['billing', 'route', 'synthesize', 'tech'],
      ['legal', 'submission', 'tech'],
      ['plan', 'prepare', 'researcher', 'synthesize'],
      ['draft', 'publish'],
      ['research', 'review'],
    ]);
  });

  it('draws a participant without tools as one step, and one resolved at run time not at all', async () => {
    const router = createRouter({
      model: roleModel({}),
      routes: [spec('plain'), { name: 'bound', description: 'Bound.', agent: contextAgent('bound') }],
      routeFn: () => [],
    });

    const nodes = await drawn(router);

    expect(nodes).toEqual(expect.arrayContaining(['plain', 'bound']));
    expect(nodes.filter((node) => node.startsWith('plain:') || node.startsWith('bound:'))).toEqual([]);
  });

  it('expands nested patterns level by level', async () => {
    const team = createParallel({ branches: [toolSpec('a')], merge: 'submission' });
    const loop = createEvaluatorOptimizer({
      generator: { name: 'team', agent: team },
      evaluator: { name: 'review', model: roleModel({}), prompt: 'Check.' },
    });

    expect(await drawn(loop)).toEqual(expect.arrayContaining(['team:a:model_request', 'team:submission', 'review']));
    expect(await drawn(loop, 1)).not.toContain('team:a:model_request');
  });

  it("shows an interrupted participant's state from the pattern and resumes it", async () => {
    const refund = tool(async ({ amount }) => (interrupt(`Refund ${amount}?`) ? 'refunded' : 'declined'), {
      name: 'refund',
      description: 'Refund an amount.',
      schema: z.object({ amount: z.number() }),
    });
    const billing = createAgent({
      model: roleModel({
        billing: (turn) =>
          turn.called('refund') ? turn.say(`done: ${turn.result('refund')}`) : turn.call('refund', { amount: 5 }),
      }),
      tools: [refund],
      systemPrompt: 'role=billing',
    });
    const router = createRouter({
      model: roleModel({}),
      routes: [{ name: 'billing', description: 'Refunds.', agent: billing }],
      routeFn: () => [{ agent: 'billing', task: 'refund 5' }],
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: 't' } };

    await router.invoke(request('refund'), config);
    const inner = (await router.getState(config, { subgraphs: true })).tasks[0]?.state;

    expect(inner !== undefined && 'next' in inner ? inner.next : undefined).toEqual(['tools']);
    expect(lastText((await router.invoke(new Command({ resume: true }), config)).messages)).toBe('done: refunded');
  });
});
