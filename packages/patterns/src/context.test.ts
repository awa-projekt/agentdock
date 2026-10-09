import { describe, expect, it } from '@effect/vitest';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { type AgentInput, contextAgent, type Evaluation, toMessages } from './core.ts';
import { createEvaluatorOptimizer } from './evaluator-optimizer.ts';
import { contextModel } from './models.ts';
import { createOrchestrator } from './orchestrator.ts';
import { createParallel } from './parallel.ts';
import { createPipeline, llmStep, structuredStep } from './pipeline.ts';
import { createRouter } from './router.ts';
import { Answer, request, roleModel, spec } from './test-support.ts';
import { type ModelTurn, scriptedModel } from './testing.ts';

const lastText = (messages: ReadonlyArray<BaseMessage>) => messages.at(-1)?.text ?? '';

const Ticket = z.object({ category: z.enum(['billing', 'tech']), urgent: z.boolean() });

/** A bound agent answering with `structured`, recording the input keys it was sent. */
const bound = (structured: Record<string, string | boolean> | undefined, seen: Array<ReadonlyArray<string>> = []) => ({
  invoke: async (input: AgentInput) => {
    seen.push(Object.keys(input));
    const messages = [...toMessages(input.messages), new AIMessage('done')];
    return structured === undefined ? { messages } : { messages, structuredResponse: structured };
  },
});

describe('contextAgent', () => {
  it('parses the bound agent’s structured response with its output schema', async () => {
    const seen: Array<ReadonlyArray<string>> = [];
    const triage = contextAgent('triage', { output: Ticket });
    const context = { agents: { triage: bound({ category: 'tech', urgent: true }, seen) } };

    const result = await triage.invoke({ messages: [{ role: 'user', content: 'down' }] }, { context });

    const ticket: z.infer<typeof Ticket> | undefined = result.structuredResponse;
    expect(ticket).toEqual({ category: 'tech', urgent: true });
    expect(seen).toEqual([['messages']]);
  });

  it('fails clearly when the answer is missing or does not match', async () => {
    const triage = contextAgent('triage', { output: Ticket });
    const input = { messages: [{ role: 'user', content: 'x' }] };

    await expect(triage.invoke(input, { context: { agents: { triage: bound(undefined) } } })).rejects.toThrow(
      /Agent 'triage' returned no structured response/,
    );
    await expect(
      triage.invoke(input, { context: { agents: { triage: bound({ category: 'sales', urgent: true }) } } }),
    ).rejects.toThrow(/does not match its output schema[\s\S]*category/);
    await expect(triage.invoke(input, { context: { agents: {} } })).rejects.toThrow(/declare it under "agents"/);
  });

  it('passes an untyped agent’s answer through and forwards only messages', async () => {
    const seen: Array<ReadonlyArray<string>> = [];
    const agent = contextAgent('free');
    const context = { agents: { free: bound({ anything: 'goes' }, seen) } };

    const input = { messages: [{ role: 'user', content: 'x' }], evaluation: { passed: false } };
    const result = await agent.invoke(input, { context });

    expect(result.structuredResponse).toEqual({ anything: 'goes' });
    expect(seen).toEqual([['messages']]);
  });
});

describe('contextModel', () => {
  const routing = (calls: Array<string>) => (turn: ModelTurn) => {
    calls.push(turn.responseFormat ? 'native' : 'tool');
    return turn.system.includes('role=router')
      ? turn.structured({ routes: [{ agent: 'alpha', task: 'go' }] })
      : turn.structured({ text: 'done' });
  };
  const router = () =>
    createRouter({
      model: contextModel('router'),
      routes: [spec('alpha')],
      systemPrompt: 'role=router',
      responseFormat: Answer,
    });

  it('is resolved from the run context at call time, never when the graph is built', async () => {
    const graph = router();

    expect(Object.keys((await graph.getGraphAsync({ xray: true })).nodes)).toContain('route');
    await expect(graph.invoke(request('x'))).rejects.toThrow(/No chat model 'router'[\s\S]*"models"/);
  });

  it('makes structured calls natively when the bound model declares support, with tool calling otherwise', async () => {
    const calls: Array<string> = [];
    const graph = router();

    const native = scriptedModel(routing(calls), { profile: { structuredOutput: true } });
    expect((await graph.invoke(request('x'), { context: { models: { router: native } } })).structuredResponse).toEqual({
      text: 'done',
    });
    expect(calls).toEqual(['native', 'native']);

    calls.length = 0;
    await graph.invoke(request('x'), { context: { models: { router: scriptedModel(routing(calls)) } } });
    expect(calls).toEqual(['tool', 'tool']);
  });

  it('resolves per run, so two runs of one graph use the models their contexts bind', async () => {
    const graph = createPipeline({
      steps: [llmStep({ name: 'answer', model: contextModel('writer'), systemPrompt: 'Answer.' })],
    });
    const run = (reply: string) =>
      graph.invoke(request('x'), { context: { models: { writer: scriptedModel((turn) => turn.say(reply)) } } });

    const [first, second] = await Promise.all([run('from tenant A'), run('from tenant B')]);

    expect([lastText(first.messages), lastText(second.messages)]).toEqual(['from tenant A', 'from tenant B']);
  });

  it('serves every model option: steps, the parallel synthesis, the planner and a model judge', async () => {
    const model = roleModel(
      {
        label: (turn) => turn.structured({ label: 'ok' }),
        synth: (turn) => turn.structured({ text: 'merged' }),
        plan: (turn) =>
          turn.structured({ tasks: turn.lastHuman.includes('Results') ? [] : [{ worker: 'a', instruction: 'go' }] }),
        judge: (turn) => turn.structured({ passed: true, score: 1, issues: [], feedback: '' }),
      },
      { profile: { structuredOutput: true } },
    );
    const context = { models: { shared: model } };
    const shared = contextModel('shared');
    const step = createPipeline({
      steps: [
        structuredStep({
          name: 'label',
          model: shared,
          systemPrompt: 'role=label',
          schema: z.object({ label: z.string() }),
        }),
      ],
    });
    const team = createParallel({
      branches: [spec('a'), spec('b')],
      model: shared,
      synthesizerPrompt: 'role=synth',
      responseFormat: Answer,
    });
    const orchestrator = createOrchestrator({
      model: shared,
      workers: [spec('a')],
      plannerPrompt: 'role=plan',
      synthesizerPrompt: 'role=synth',
      responseFormat: Answer,
    });
    const reviewed = createEvaluatorOptimizer({
      generator: { name: 'team', agent: team },
      evaluator: { name: 'review', model: shared, prompt: 'role=judge' },
    });

    expect((await step.invoke(request('x'), { context })).structuredResponse).toEqual({ label: 'ok' });
    expect((await orchestrator.invoke(request('x'), { context })).structuredResponse).toEqual({ text: 'merged' });
    const result = await reviewed.invoke(request('x'), { context });
    const verdict: Evaluation | undefined = result.evaluation;
    expect([result.structuredResponse, verdict?.passed]).toEqual([{ text: 'merged' }, true]);
    expect(model.calls.every((turn) => turn.responseFormat !== undefined)).toBe(true);
  });
});
