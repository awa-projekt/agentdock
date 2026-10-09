import { describe, expect, it } from '@effect/vitest';
import { type BaseMessage, HumanMessage, isAIMessage } from '@langchain/core/messages';
import { RunnableLambda } from '@langchain/core/runnables';
import { END, MemorySaver, MessagesValue, START, StateGraph, StateSchema } from '@langchain/langgraph';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { type Agent, agentAsNode } from './core.ts';
import { createMapReduce } from './map-reduce.ts';
import { createOrchestrator } from './orchestrator.ts';
import { createParallel } from './parallel.ts';
import { agentStep, createPipeline, functionStep, llmStep, structuredStep } from './pipeline.ts';
import { createRouter } from './router.ts';
import { Answer, echoAgent, request, roleModel, spec } from './test-support.ts';
import type { ModelTurn } from './testing.ts';
import { createVoting } from './voting.ts';

const lastText = (messages: ReadonlyArray<BaseMessage>) => messages.at(-1)?.text ?? '';

const routerPolicy = (targets: ReadonlyArray<string>) => (turn: ModelTurn) =>
  turn.structured({ routes: targets.map((agent) => ({ agent, task: `task for ${agent}` })) });

const Label = z.object({ label: z.string() }).meta({ title: 'Label' });

describe('createPipeline', () => {
  it('runs steps in order and passes earlier outputs on', async () => {
    const model = roleModel({
      label: (turn) => turn.structured({ label: 'question' }),
      answer: (turn) => turn.say(`answer using ${turn.lastHuman.includes('question') ? 'question' : '?'}`),
    });
    const pipeline = createPipeline({
      steps: [
        structuredStep({ name: 'label', model, systemPrompt: 'role=label', schema: Label }),
        functionStep({
          name: 'length',
          run: async (state) => z.object({ text: z.string() }).parse(state.context).text.length,
        }),
        llmStep({ name: 'answer', model, systemPrompt: 'role=answer' }),
      ],
    });

    const result = await pipeline.invoke({ ...request('Why?'), context: { text: 'Why?' } });

    expect(result.outputs.label?.value).toEqual({ label: 'question' });
    expect(result.outputs.length?.value).toBe(4);
    expect(lastText(result.messages)).toBe('answer using question');
    expect(result.structuredResponse).toBeUndefined();
  });

  it('stops at a failing gate with the fallback as result', async () => {
    const calls: Array<string> = [];
    const model = roleModel({
      label: (turn) => turn.structured({ label: 'spam' }),
      never: (turn) => {
        calls.push(turn.lastHuman);
        return turn.say('x');
      },
    });
    const pipeline = createPipeline({
      steps: [
        structuredStep({
          name: 'label',
          model,
          systemPrompt: 'role=label',
          schema: Label,
          gate: (label) => label.label !== 'spam',
          onGateFail: () => ({ ignored: true }),
        }),
        llmStep({ name: 'never', model, systemPrompt: 'role=never' }),
      ],
    });

    const result = await pipeline.invoke(request('win money'));

    expect(result.structuredResponse).toEqual({ ignored: true });
    expect(result.stoppedAt).toBe('label');
    expect(calls).toEqual([]);
  });

  it('records an agent step by its structured response and picks the result with an output function', async () => {
    const agent: Agent<{ ok: boolean }> = { invoke: async () => ({ messages: [], structuredResponse: { ok: true } }) };
    const pipeline = createPipeline({
      steps: [agentStep({ name: 'check', agent }), agentStep({ name: 'echo', agent: echoAgent('E') })],
      output: (state) => ({ checked: state.outputs.check?.value, echoed: state.outputs.echo?.text }),
    });

    const result = await pipeline.invoke(request('hi'));

    expect(result.structuredResponse).toEqual({ checked: { ok: true }, echoed: expect.stringContaining('E: ') });
  });

  it('rejects state keys and duplicates as step names', () => {
    const run = async () => 'x';
    expect(() => createPipeline({ steps: [functionStep({ name: 'outputs', run })] })).toThrow(/reserved/);
    const twice = functionStep({ name: 'a', run });
    expect(() => createPipeline({ steps: [twice, twice] })).toThrow(/unique/);
  });
});

describe('createRouter', () => {
  it('fans out in parallel and synthesizes a structured answer', async () => {
    const model = roleModel({
      router: routerPolicy(['alpha', 'beta']),
      synth: (turn) =>
        turn.structured({
          text: turn.lastHuman
            .split('\n')
            .filter((line) => line.includes(':') && line.includes('task'))
            .sort()
            .join(' + '),
        }),
    });
    const router = createRouter({
      model,
      routes: [spec('alpha'), spec('beta'), spec('gamma')],
      systemPrompt: 'role=router',
      synthesizerPrompt: 'role=synth',
      responseFormat: Answer,
    });

    const result = await router.invoke(request('do both'));

    expect(result.routes.map((route) => route.agent)).toEqual(['alpha', 'beta']);
    expect(result.structuredResponse?.text).toBe('alpha: task for alpha + beta: task for beta');
  });

  it('passes a single route through without synthesis', async () => {
    const router = createRouter({
      model: roleModel({ router: routerPolicy(['alpha']) }),
      routes: [spec('alpha'), spec('beta')],
      systemPrompt: 'role=router',
    });

    const result = await router.invoke(request('x'));

    expect(lastText(result.messages)).toBe('alpha: task for alpha');
    expect(result.structuredResponse).toBeUndefined();
  });

  it('routes deterministically with routeFn', async () => {
    const router = createRouter({
      model: roleModel({ synth: (turn) => turn.say('merged') }),
      routes: [spec('alpha'), spec('beta')],
      synthesizerPrompt: 'role=synth',
      routeFn: () => [{ agent: 'beta', task: 'rule-based' }],
      synthesize: true,
    });

    expect(lastText((await router.invoke(request('x'))).messages)).toBe('merged');
  });

  it('constrains the routing schema to the route names and lists routes without a description by name', async () => {
    const seen: Array<readonly [string, string]> = [];
    const model = roleModel({
      router: (turn) => {
        seen.push([JSON.stringify(turn.structuredToolSchema()), turn.system]);
        return turn.structured({ routes: [] });
      },
      synth: (turn) => turn.say('nothing to do'),
    });
    const router = createRouter({
      model,
      routes: [spec('alpha'), { name: 'beta', agent: echoAgent('beta') }],
      systemPrompt: 'role=router',
      synthesizerPrompt: 'role=synth',
    });

    expect(lastText((await router.invoke(request('x'))).messages)).toBe('nothing to do');
    expect(seen[0]?.[0]).toContain('"enum":["alpha","beta"]');
    expect(seen[0]?.[1]).toContain('- alpha: The alpha agent.\n- beta');
  });
});

describe('createParallel', () => {
  it('merges the branches in code under the merge node', async () => {
    const graph = createParallel({
      branches: [spec('a'), spec('b')],
      merge: 'combine',
      aggregator: (results) =>
        Object.values(results)
          .map((result) => result.text)
          .sort(),
    });

    const result = await graph.invoke(request('q'));

    expect(result.structuredResponse).toEqual(['a: q', 'b: q']);
    expect(Object.keys(result.branchResults).sort()).toEqual(['a', 'b']);
    expect(Object.keys((await graph.getGraphAsync()).nodes).sort()).toEqual([
      '__end__',
      '__start__',
      'a',
      'b',
      'combine',
    ]);
  });

  it('synthesizes the branches with a model', async () => {
    const graph = createParallel({
      branches: [spec('a'), spec('b')],
      model: roleModel({ synth: (turn) => turn.structured({ text: 'both' }) }),
      synthesizerPrompt: 'role=synth',
      responseFormat: Answer,
    });

    expect((await graph.invoke(request('q'))).structuredResponse).toEqual({ text: 'both' });
  });

  it('joins the answers as text without an aggregator or a model', async () => {
    const graph = createParallel({ branches: [spec('a'), spec('b')] });

    expect(lastText((await graph.invoke(request('q'))).messages)).toBe('[a]\na: q\n\n[b]\nb: q');
  });

  it('on a revision runs only what rerun names, each branch continuing its own conversation', async () => {
    const graph = createParallel({
      branches: [spec('a'), spec('b'), spec('c')],
      aggregator: (results) => Object.fromEntries(Object.values(results).map((result) => [result.name, result.text])),
      rerun: ({ evaluation }) => evaluation.issues,
    });
    const first = await graph.invoke(request('q'));
    const revisionRequest = new HumanMessage('fix b');

    const revised = await graph.invoke({
      messages: [...first.messages, revisionRequest],
      branchResults: first.branchResults,
      evaluation: { passed: false, score: 0.5, issues: ['b', 'nobody'], feedback: 'fix b' },
    });

    expect(revised.structuredResponse).toEqual({ a: 'a: q', b: 'b: fix b', c: 'c: q' });
    expect(revised.branchResults.b?.messages.map((message) => message.text)).toEqual([
      'q',
      'b: q',
      'fix b',
      'b: fix b',
    ]);
    expect(revised.branchResults.a).toEqual(first.branchResults.a);
  });

  it('runs every branch without rerun or without a verdict', async () => {
    const calls: Array<string> = [];
    const counted = (name: string) => ({
      name,
      agent: {
        invoke: async () => {
          calls.push(name);
          return { messages: [new HumanMessage(name)] };
        },
      },
    });
    const graph = createParallel({ branches: [counted('a'), counted('b')], rerun: () => ['a'] });
    const first = await graph.invoke(request('q'));

    await graph.invoke({ ...request('again'), branchResults: first.branchResults });

    expect(calls.sort()).toEqual(['a', 'a', 'b', 'b']);
  });

  it('rejects a merge name that is a branch or a state key', () => {
    expect(() => createParallel({ branches: [spec('merge')] })).toThrow(/unique/);
    expect(() => createParallel({ branches: [spec('a')], merge: 'branchResults' })).toThrow(/reserved/);
  });
});

describe('createVoting', () => {
  it('returns the majority vote from the node named after the voter', async () => {
    const answers = ['yes', 'no', 'yes'];
    let next = 0;
    const voter = createAgent({
      model: roleModel({ vote: (turn) => turn.say(answers[next++ % answers.length] ?? '') }),
      tools: [],
      systemPrompt: 'role=vote',
    });
    const graph = createVoting({ voter: { name: 'classify', agent: voter }, n: 3 });

    const result = await graph.invoke(request('?'));

    expect(lastText(result.messages)).toBe('yes');
    expect(result.votes).toEqual({ yes: 2, no: 1 });
    expect(Object.keys((await graph.getGraphAsync()).nodes)).toEqual(['__start__', 'classify', 'tally', '__end__']);
  });
});

describe('createMapReduce', () => {
  it('maps in parallel, keeps the item order, reduces and handles empty input', async () => {
    const graph = createMapReduce({
      mapper: { name: 'scale', agent: RunnableLambda.from(async (value: number) => value * 10) },
      reduce: (results) => results.reduce((sum, value) => sum + value, 0),
    });

    const result = await graph.invoke({ items: [3, 1, 2] });
    expect(result.results).toEqual([30, 10, 20]);
    expect(result.output).toBe(60);
    expect((await graph.invoke({ items: [] })).output).toBe(0);
    expect(Object.keys((await graph.getGraphAsync()).nodes)).toEqual(['__start__', 'scale', 'reduce', '__end__']);
  });

  it('prepares the mapper input and extracts the per-item result', async () => {
    const graph = createMapReduce({
      mapper: { name: 'echo', agent: echoAgent('m') },
      prepare: (item: string) => request(item),
      extract: (output: { readonly messages: BaseMessage[] }) => lastText(output.messages),
    });

    expect((await graph.invoke({ items: ['a', 'b'] })).output).toEqual(['m: a', 'm: b']);
  });
});

describe('createOrchestrator', () => {
  it('re-plans until the planner returns no tasks', async () => {
    const plan = (turn: ModelTurn) => {
      if (!turn.lastHuman.includes('Results so far')) {
        return turn.structured({ tasks: [{ worker: 'researcher', instruction: 'find' }] });
      }
      if ((turn.lastHuman.match(/\[/g) ?? []).length === 1) {
        return turn.structured({
          tasks: [
            { worker: 'writer', instruction: 'write' },
            { worker: 'writer', instruction: 'polish' },
          ],
        });
      }
      return turn.structured({ tasks: [] });
    };
    const graph = createOrchestrator({
      model: roleModel({
        plan,
        synth: (turn) => turn.structured({ text: 'x'.repeat((turn.lastHuman.match(/\[/g) ?? []).length) }),
      }),
      workers: [spec('researcher'), spec('writer')],
      plannerPrompt: 'role=plan',
      synthesizerPrompt: 'role=synth',
      responseFormat: Answer,
      maxRounds: 3,
    });

    const result = await graph.invoke(request('report'));

    expect(result.results.map((entry) => [entry.round, entry.worker, entry.task])).toEqual([
      [1, 'researcher', 'find'],
      [2, 'writer', 'write'],
      [2, 'writer', 'polish'],
    ]);
    expect(result.structuredResponse?.text).toBe('xxx');
  });

  it('plans once with a single round', async () => {
    let plans = 0;
    const graph = createOrchestrator({
      model: roleModel({
        plan: (turn) => {
          plans += 1;
          return turn.structured({ tasks: [{ worker: 'w', instruction: 'go' }] });
        },
        synth: (turn) => turn.say('done'),
      }),
      workers: [spec('w')],
      plannerPrompt: 'role=plan',
      synthesizerPrompt: 'role=synth',
    });

    expect(lastText((await graph.invoke(request('x'))).messages)).toBe('done');
    expect(plans).toBe(1);
  });

  it('continues from earlier results, numbering rounds after them', async () => {
    const plannerInputs: Array<string> = [];
    const graph = createOrchestrator({
      model: roleModel({
        plan: (turn) => {
          plannerInputs.push(turn.lastHuman);
          return turn.structured({ tasks: [{ worker: 'w', instruction: 'more' }] });
        },
        synth: (turn) => turn.say('done'),
      }),
      workers: [spec('w')],
      plannerPrompt: 'role=plan',
      synthesizerPrompt: 'role=synth',
      maxRounds: 2,
    });
    const earlier = [{ round: 1, worker: 'w', task: 'first', output: 'w: first' }];

    const result = await graph.invoke({ ...request('x'), results: earlier });

    expect(result.results.map((entry) => entry.round)).toEqual([1, 2, 3]);
    expect(plannerInputs[0]).toContain('(task: first)');
  });

  it('resets its round limit per run on a reused thread', async () => {
    const graph = createOrchestrator({
      model: roleModel({
        plan: (turn) => turn.structured({ tasks: [{ worker: 'w', instruction: 'go' }] }),
        synth: (turn) => turn.say('done'),
      }),
      workers: [spec('w')],
      plannerPrompt: 'role=plan',
      synthesizerPrompt: 'role=synth',
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: 'reused' } };

    await graph.invoke(request('first'), config);
    const second = await graph.invoke(request('second'), config);

    // Without the per-run reset the second run would skip planning: its round would already be past the limit.
    expect(second.results.map((entry) => entry.round)).toEqual([1, 2]);
  });
});

describe('composition', () => {
  it('embeds a pattern in a graph with another state through agentAsNode', async () => {
    const Ticket = z.object({ question: z.string(), answer: z.string().default('') });
    const router = createRouter({
      model: roleModel({ router: routerPolicy(['alpha']) }),
      routes: [spec('alpha')],
      systemPrompt: 'role=router',
    });
    const node = agentAsNode(router, {
      input: (state: z.infer<typeof Ticket>) => ({ messages: [new HumanMessage(state.question)] }),
      output: (result) => ({ answer: lastText(result.messages) }),
    });
    const graph = new StateGraph(Ticket)
      .addNode('router', node, { subgraphs: [router] })
      .addEdge(START, 'router')
      .addEdge('router', END)
      .compile();

    expect((await graph.invoke({ question: 'q' })).answer).toBe('alpha: task for alpha');
    expect(Object.keys((await graph.getGraphAsync({ xray: true })).nodes)).toContain('router:alpha');
  });

  it('adds a pattern graph sharing messages as a subgraph node, with its typed answer in the parent state', async () => {
    const team = createParallel({
      branches: [spec('a'), spec('b')],
      aggregator: (results) => ({ text: Object.keys(results).sort().join(' + ') }),
    });
    const graph = new StateGraph(new StateSchema({ messages: MessagesValue, structuredResponse: Answer.optional() }))
      .addNode('team', team)
      .addEdge(START, 'team')
      .addEdge('team', END)
      .compile();

    const result = await graph.invoke(request('hi'));

    const last = result.messages.at(-1);
    expect(last !== undefined && isAIMessage(last)).toBe(true);
    expect(result.structuredResponse?.text).toBe('a + b');
  });
});
