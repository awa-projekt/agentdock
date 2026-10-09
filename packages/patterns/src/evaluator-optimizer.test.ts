import { describe, expect, it } from '@effect/vitest';
import { AIMessage, type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { END, MemorySaver, MessagesValue, START, StateGraph, StateSchema } from '@langchain/langgraph';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { type AgentInput, contextAgent, Evaluation, resultsBlock, toMessages, WorkResult } from './core.ts';
import { createEvaluatorOptimizer } from './evaluator-optimizer.ts';
import { createOrchestrator, WorkResults } from './orchestrator.ts';
import { type BranchResults, createParallel } from './parallel.ts';
import { createRouter } from './router.ts';
import { Answer, echoAgent, request, roleModel } from './test-support.ts';

const lastText = (messages: ReadonlyArray<BaseMessage>) => messages.at(-1)?.text ?? '';

/** A generator whose drafts count the feedback it got: `draft v1`, `draft v2`, … */
const reflectiveGenerator = () =>
  createAgent({
    model: roleModel({
      gen: (turn) =>
        turn.structured({
          text: `draft v${turn.humanMessages.filter((text) => text.toLowerCase().includes('feedback')).length + 1}`,
        }),
    }),
    tools: [],
    systemPrompt: 'role=gen',
    responseFormat: Answer,
  });

const Verdict = z.object({ passed: z.boolean() }).meta({ title: 'Verdict' });

const judge = (passes: (draft: string) => boolean) =>
  roleModel({
    judge: (turn) => {
      const ok = passes(turn.lastHuman);
      return turn.structured({ passed: ok, score: ok ? 1 : 0.3, issues: ok ? [] : ['too short'], feedback: 'longer' });
    },
  });

describe('createEvaluatorOptimizer', () => {
  it('revises until the evaluation passes', async () => {
    const loop = createEvaluatorOptimizer({
      generator: { name: 'write', agent: reflectiveGenerator() },
      evaluator: { name: 'review', model: judge((draft) => draft.includes('v2')), prompt: 'role=judge' },
    });

    const result = await loop.invoke(request('write something'));

    expect(result.structuredResponse?.text).toBe('draft v2');
    expect(result.iterations).toBe(2);
    expect(result.evaluation?.passed).toBe(true);
  });

  it('names its nodes after the roles and ends from the evaluator node', async () => {
    const loop = createEvaluatorOptimizer({
      generator: { name: 'write', agent: reflectiveGenerator() },
      evaluator: { name: 'review', model: judge(() => false), prompt: 'role=judge' },
      maxIterations: 2,
    });
    const drawn = await loop.getGraphAsync();
    const updates: Array<string> = [];

    for await (const chunk of await loop.stream(request('x'), { streamMode: 'updates' })) {
      updates.push(...Object.keys(chunk));
    }

    expect(Object.keys(drawn.nodes).sort()).toEqual(['__end__', '__start__', 'review', 'write']);
    expect(drawn.edges.map((edge) => [edge.source, edge.target, edge.conditional])).toEqual(
      expect.arrayContaining([
        ['__start__', 'write', false],
        ['write', 'review', false],
        ['review', 'write', true],
        ['review', '__end__', true],
      ]),
    );
    // The cap ends the loop: the last review writes the result, no finish step runs after it.
    expect(updates).toEqual(['write', 'review', 'write', 'review']);
  });

  it('applies onMaxIterations when no candidate passes', async () => {
    const loop = createEvaluatorOptimizer({
      generator: { name: 'write', agent: reflectiveGenerator() },
      evaluator: { name: 'review', model: judge(() => false), prompt: 'role=judge' },
      maxIterations: 2,
      onMaxIterations: (candidate) => ({
        text: 'escalated',
        structured: { text: `needs human (${candidate.structured?.text})` },
      }),
    });

    const result = await loop.invoke(request('x'));

    expect(result.structuredResponse).toEqual({ text: 'needs human (draft v2)' });
    expect(lastText(result.messages)).toBe('escalated');
    expect(result.iterations).toBe(2);
  });

  it('validates its options and requires a structured verdict from an agent evaluator', async () => {
    expect(() =>
      createEvaluatorOptimizer({
        generator: { name: 'review', agent: echoAgent('g') },
        evaluator: { name: 'review', agent: echoAgent('r') },
      }),
    ).toThrow(/both named 'review'/);
    expect(() =>
      createEvaluatorOptimizer({
        generator: { name: 'write', agent: echoAgent('g') },
        evaluator: { name: 'review', agent: echoAgent('r') },
        carryOver: { results: WorkResults },
        evaluatorInput: () => 'x',
        evaluatorContext: () => 'y',
      }),
    ).toThrow(/evaluatorInput/);
    expect(() =>
      createEvaluatorOptimizer({
        generator: { name: 'evaluation', agent: echoAgent('g') },
        evaluator: { name: 'review', agent: echoAgent('r') },
      }),
    ).toThrow(/reserved/);
    const loop = createEvaluatorOptimizer({
      generator: { name: 'write', agent: echoAgent('g') },
      evaluator: { name: 'review', agent: echoAgent('r') },
    });
    await expect(loop.invoke(request('x'))).rejects.toThrow(/'review' returned no structured response/);
  });

  it('sends an agent evaluator exactly what evaluatorInput builds', async () => {
    const sent: Array<ReadonlyArray<string>> = [];
    const reviewer = createAgent({
      model: roleModel({
        rev: (turn) => {
          sent.push([...turn.messages.map((message) => message.type), turn.lastHuman]);
          return turn.structured({ passed: true });
        },
      }),
      tools: [],
      systemPrompt: 'role=rev',
      responseFormat: Verdict,
    });
    const loop = createEvaluatorOptimizer({
      generator: { name: 'write', agent: reflectiveGenerator() },
      evaluator: { name: 'review', agent: reviewer },
      evaluatorInput: (state) => [
        ...state.request,
        new HumanMessage(`Check this draft: ${state.candidate.structured?.text}`),
      ],
    });

    const result = await loop.invoke(request('write something'));

    expect(result.structuredResponse).toEqual({ text: 'draft v1' });
    expect(sent).toEqual([['system', 'human', 'human', 'Check this draft: draft v1']]);
  });

  it("keeps a model judge's rubric with evaluatorInput and parses its own verdict schema", async () => {
    const seen: Array<readonly [string, ReadonlyArray<string>]> = [];
    const loop = createEvaluatorOptimizer({
      generator: { name: 'write', agent: reflectiveGenerator() },
      evaluator: {
        name: 'review',
        model: roleModel({
          judge: (turn) => {
            seen.push([turn.system, turn.humanMessages]);
            return turn.structured({ passed: true });
          },
        }),
        prompt: 'role=judge',
        output: Verdict,
      },
      evaluatorInput: (state) => `Only the draft: ${state.candidate.structured?.text}`,
    });

    const result = await loop.invoke(request('write something'));

    expect(result.evaluation).toEqual({ passed: true });
    expect(seen).toEqual([['role=judge', ['Only the draft: draft v1']]]);
  });

  it('revises with a pattern that takes none of the revision keys, like the support desk', async () => {
    const routed: Array<string> = [];
    const desk = createRouter({
      model: roleModel({
        router: (turn) => {
          routed.push(turn.lastHuman);
          return turn.structured({ routes: [{ agent: 'billing', task: turn.lastHuman }] });
        },
      }),
      routes: [{ name: 'billing', agent: echoAgent('billing') }],
      systemPrompt: 'role=router',
    });
    const loop = createEvaluatorOptimizer({
      generator: { name: 'desk', agent: desk },
      evaluator: { name: 'review', model: judge((draft) => draft.includes('Reviewer feedback')), prompt: 'role=judge' },
    });

    const result = await loop.invoke(request('refund please'));

    expect(result.iterations).toBe(2);
    expect(routed).toEqual(['refund please', expect.stringContaining('Reviewer feedback: longer')]);
  });

  it('starts over on a reused thread instead of revising the last run', async () => {
    const loop = createEvaluatorOptimizer({
      generator: { name: 'write', agent: reflectiveGenerator() },
      evaluator: { name: 'review', model: judge(() => false), prompt: 'role=judge' },
      maxIterations: 2,
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: 'reused' } };

    await loop.invoke(request('first'), config);
    const second = await loop.invoke(request('second'), config);

    expect(second.iterations).toBe(2);
    expect(second.structuredResponse).toEqual({ text: 'draft v2' });
  });
});

const Report = z.object({ summary: z.string(), sources: z.array(z.string()) }).meta({ title: 'Report' });

/** An orchestrator with a researcher worker inside a review loop with an agent reviewer. */
const researchReview = (searches: Array<string>, reviews: Array<string>) => {
  const search = tool(
    async ({ query }) => {
      searches.push(query);
      return `source://${query.replaceAll(' ', '-')} says: facts about ${query}`;
    },
    { name: 'search', description: 'Search the web.', schema: z.object({ query: z.string() }) },
  );
  const model = roleModel({
    research: (turn) =>
      turn.called('search') ? turn.say(turn.result('search') ?? '') : turn.call('search', { query: turn.firstHuman }),
    plan: (turn) => {
      if (!turn.lastHuman.includes('Results so far')) {
        return turn.structured({
          tasks: ['market', 'rivals'].map((instruction) => ({ worker: 'researcher', instruction })),
        });
      }
      const wantsPricing = turn.humanMessages.slice(0, -1).some((text) => text.includes('pricing'));
      if (wantsPricing && !turn.lastHuman.includes('(task: pricing)')) {
        return turn.structured({ tasks: [{ worker: 'researcher', instruction: 'pricing' }] });
      }
      return turn.structured({ tasks: [] });
    },
    synth: (turn) =>
      turn.structured({
        summary: 'report',
        sources: [...new Set(turn.lastHuman.match(/source:\/\/\S+/g) ?? [])].sort(),
      }),
    review: (turn) => {
      reviews.push(turn.lastHuman);
      const ok = (turn.lastHuman.split('Candidate to evaluate')[1] ?? '').includes('source://pricing');
      return turn.structured({
        passed: ok,
        score: ok ? 1 : 0.4,
        issues: ok ? [] : ['no pricing data'],
        feedback: ok ? 'fine' : 'Add pricing research.',
      });
    },
  });
  const researcher = createAgent({ model, tools: [search], systemPrompt: 'role=research', name: 'researcher' });
  const reviewer = createAgent({ model, tools: [], systemPrompt: 'role=review', responseFormat: Evaluation });
  const research = createOrchestrator({
    model,
    workers: [{ name: 'researcher', description: 'Researches one question', agent: researcher }],
    plannerPrompt: 'role=plan',
    synthesizerPrompt: 'role=synth',
    responseFormat: Report,
  });
  return createEvaluatorOptimizer({
    generator: { name: 'research', agent: research },
    evaluator: { name: 'review', agent: reviewer },
    carryOver: { results: WorkResults },
    evaluatorContext: (state) => resultsBlock(state.results ?? [], 'Research results'),
    maxIterations: 3,
  });
};

describe('research with review', () => {
  it('revises the research without redoing it', async () => {
    const searches: Array<string> = [];
    const reviews: Array<string> = [];

    const result = await researchReview(searches, reviews).invoke(request('Research the EV market'));

    expect(searches.sort()).toEqual(['market', 'pricing', 'rivals']);
    expect(result.results?.map((entry) => [entry.round, entry.task])).toEqual([
      [1, 'market'],
      [1, 'rivals'],
      [2, 'pricing'],
    ]);
    expect(result.iterations).toBe(2);
    expect(result.evaluation?.passed).toBe(true);
    expect(result.structuredResponse?.sources).toEqual(['source://market', 'source://pricing', 'source://rivals']);
    expect(reviews.every((review) => review.includes('Research results') && review.includes('source://market'))).toBe(
      true,
    );
  });

  it('builds on earlier research when embedded as a subgraph, typed in the parent state', async () => {
    const searches: Array<string> = [];
    const Workflow = new StateSchema({
      messages: MessagesValue,
      // No reducer: the loop returns the complete list.
      results: z.array(WorkResult).optional(),
      structuredResponse: Report.optional(),
      evaluation: Evaluation.optional(),
    });
    const graph = new StateGraph(Workflow)
      .addNode('research', researchReview(searches, []))
      .addEdge(START, 'research')
      .addEdge('research', END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: 't1' } };

    await graph.invoke(request('Research the EV market'), config);
    expect(searches.sort()).toEqual(['market', 'pricing', 'rivals']);

    const result = await graph.invoke(request('Anything new on pricing?'), config);
    expect(searches).toHaveLength(3);
    expect(result.results).toHaveLength(3);
    expect(result.evaluation?.passed).toBe(true);
    expect(result.structuredResponse?.summary).toBe('report');
  });
});

const TEAM = ['market', 'legal', 'tech'] as const;
const SpecialistReport = z.object({ agent: z.string(), summary: z.string() });
type SpecialistReport = z.infer<typeof SpecialistReport>;
const ReviewReport = z.object({ findings: z.array(z.object({ agent: z.string(), issue: z.string() })) });
type ReviewReport = z.infer<typeof ReviewReport>;

const submission = (results: BranchResults<SpecialistReport>) => ({
  reports: TEAM.flatMap((name) => results[name]?.structured ?? []),
});
const rework = (report: ReviewReport) =>
  `Rework these findings: ${report.findings.map((finding) => `${finding.agent}: ${finding.issue}`).join('; ')}`;

/** A bound specialist: answers `<name> v<n>` on its n-th call and records what it was sent. */
const specialist = (name: string, inputs: Array<readonly [string, ReadonlyArray<string>]>) => ({
  invoke: async (input: AgentInput) => {
    const messages = toMessages(input.messages);
    inputs.push([name, messages.map((message) => message.text)]);
    const version = inputs.filter(([agent]) => agent === name).length;
    const summary = `${name} v${version}`;
    return { messages: [...messages, new AIMessage(summary)], structuredResponse: { agent: name, summary } };
  },
});

/** A bound reviewer: legal's first report is missing a citation, everything else passes. */
const reviewer = {
  invoke: async (input: AgentInput) => {
    const candidate = toMessages(input.messages).at(-1)?.text ?? '';
    const findings = candidate.includes('legal v1') ? [{ agent: 'legal', issue: 'cite the regulation' }] : [];
    return { messages: [new AIMessage('reviewed')], structuredResponse: { findings } };
  },
};

describe('targeted rework', () => {
  it('reruns only the owners of findings and still merges every branch', async () => {
    const inputs: Array<readonly [string, ReadonlyArray<string>]> = [];
    const team = createParallel({
      branches: TEAM.map((name) => ({ name, agent: contextAgent(name, { output: SpecialistReport }) })),
      merge: 'submission',
      aggregator: submission,
      evaluation: ReviewReport,
      rerun: ({ evaluation }) => evaluation.findings.map((finding) => finding.agent),
    });
    const loop = createEvaluatorOptimizer({
      generator: { name: 'team', agent: team },
      evaluator: { name: 'review', agent: contextAgent('review', { output: ReviewReport }) },
      passed: (report) => report.findings.length === 0,
      feedback: rework,
      maxIterations: 2,
    });
    const agents = { ...Object.fromEntries(TEAM.map((name) => [name, specialist(name, inputs)])), review: reviewer };

    const result = await loop.invoke(request('Assess the launch'), { context: { agents } });

    expect(inputs.map(([agent]) => agent).sort()).toEqual(['legal', 'legal', 'market', 'tech']);
    expect(result.structuredResponse?.reports.map((report) => report.summary)).toEqual([
      'market v1',
      'legal v2',
      'tech v1',
    ]);
    // Legal continues its own conversation with the rework request, not the merged submission.
    expect(inputs.at(-1)).toEqual([
      'legal',
      ['Assess the launch', 'legal v1', 'Rework these findings: legal: cite the regulation'],
    ]);
    expect(result.iterations).toBe(2);
    expect(result.evaluation).toEqual({ findings: [] });
  });

  it("fails the revision when the evaluator's verdict does not match the schema rerun reads", async () => {
    const team = createParallel({
      branches: TEAM.map((name) => ({ name, agent: contextAgent(name, { output: SpecialistReport }) })),
      aggregator: submission,
      rerun: ({ evaluation }) => evaluation.issues,
    });
    const loop = createEvaluatorOptimizer({
      generator: { name: 'team', agent: team },
      evaluator: { name: 'review', agent: contextAgent('review', { output: ReviewReport }) },
      passed: (report) => report.findings.length === 0,
    });
    const agents = { ...Object.fromEntries(TEAM.map((name) => [name, specialist(name, [])])), review: reviewer };

    await expect(loop.invoke(request('Assess the launch'), { context: { agents } })).rejects.toThrow(
      /does not match the schema its rerun reads/,
    );
  });
});
