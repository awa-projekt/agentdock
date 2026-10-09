import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import { workflowGraphHasTopology } from '../schemas';
import { extractWorkflowContracts, extractWorkflowGraph } from './graph';
import { importWorkflowGraph, loadWorkflowManifest } from './load';
import { artifactFixture, artifactJson } from './test-artifact';

const artifact = (graphModule: string) =>
  artifactFixture('.tmp-graph-test-', {
    'agentdock.workflow.json': artifactJson({
      name: 'Fixture',
      description: 'A fixture workflow.',
      version: '1.0.0',
      graph: './workflow.mjs:default',
    }),
    'package.json': artifactJson({ name: 'fixture', type: 'module' }),
    'workflow.mjs': graphModule,
  });

const compiledOf = (graphModule: string) =>
  Effect.gen(function* () {
    const folder = yield* artifact(graphModule);
    const loaded = yield* loadWorkflowManifest(folder);
    return yield* importWorkflowGraph(loaded);
  });

const graphOf = (graphModule: string) =>
  Effect.gen(function* () {
    const compiled = yield* compiledOf(graphModule);
    return yield* extractWorkflowGraph(compiled, 'Fixture');
  });

const STATE_GRAPH = `
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

const State = Annotation.Root({ value: Annotation });

export default new StateGraph(State)
  .addNode('classify', () => ({}))
  .addNode('escalate', () => ({}))
  .addNode('reply', () => ({}))
  .addEdge(START, 'classify')
  .addConditionalEdges('classify', () => 'reply', ['escalate', 'reply'])
  .addEdge('escalate', END)
  .addEdge('reply', END)
  .compile();
`;

const ZOD_GRAPH = `
import { END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';

const Input = z.object({ text: z.string() });
const Output = z.object({ reply: z.string() });
const State = z.object({ text: z.string(), reply: z.string().default('') });

export default new StateGraph({ input: Input, output: Output, state: State })
  .addNode('answer', (state) => ({ reply: state.text }))
  .addEdge(START, 'answer')
  .addEdge('answer', END)
  .compile();
`;

// A review loop around a router from the host-provided `agentdock-patterns`, embedded as a subgraph that
// shares `messages`. One route is a bound agent, one an agent built in the artifact. Platform models
// (`contextModel`) and model ids resolve at call time, so registration never needs a model or a provider key.
const PATTERN_GRAPH = `
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { END, MessagesValue, START, StateGraph, StateSchema } from '@langchain/langgraph';
import { createAgent } from 'langchain';
import { contextAgent, contextModel, createEvaluatorOptimizer, createRouter } from 'agentdock-patterns';
import { z } from 'zod';

const lookup = tool(async () => 'found', { name: 'lookup', description: 'Look up.', schema: z.object({}) });
const desk = createRouter({
  model: contextModel('router'),
  routes: [
    { name: 'billing', description: 'Invoices and refunds', agent: contextAgent('billing') },
    { name: 'docs', description: 'Product docs', agent: createAgent({ model: 'openai:gpt-5.6-luna', tools: [lookup] }) },
  ],
});
const support = createEvaluatorOptimizer({
  generator: { name: 'desk', agent: desk },
  evaluator: { name: 'review', model: contextModel('judge'), prompt: 'Check.' },
});

const State = new StateSchema({ text: z.string(), messages: MessagesValue, reply: z.string().default('') });

export default new StateGraph(State)
  .addNode('prepare', (state) => ({ messages: [new HumanMessage(state.text)] }))
  .addNode('support', support)
  .addNode('respond', (state) => ({ reply: state.messages.at(-1)?.text ?? '' }))
  .addEdge(START, 'prepare')
  .addEdge('prepare', 'support')
  .addEdge('support', 'respond')
  .addEdge('respond', END)
  .compile();
`;

// research_review: an orchestrator with a bound researcher inside a review loop whose reviewer is a bound agent
// with a typed verdict.
const RESEARCH_REVIEW_GRAPH = `
import { contextAgent, contextModel, createEvaluatorOptimizer, createOrchestrator, Evaluation } from 'agentdock-patterns';

const research = createOrchestrator({
  model: contextModel('planner'),
  workers: [{ name: 'researcher', description: 'Researches one question.', agent: contextAgent('researcher') }],
});

export default createEvaluatorOptimizer({
  generator: { name: 'research', agent: research },
  evaluator: { name: 'review', agent: contextAgent('reviewer', { output: Evaluation }) },
});
`;

// Specialists reworking only what the review found: a parallel team of bound agents, merged into a submission,
// inside a review loop.
const SPECIALISTS_GRAPH = `
import { contextAgent, createEvaluatorOptimizer, createParallel } from 'agentdock-patterns';
import { z } from 'zod';

const TEAM = ['market', 'legal', 'tech'];
const Report = z.object({ summary: z.string() });
const ReviewReport = z.object({ findings: z.array(z.object({ agent: z.string(), issue: z.string() })) });

export default createEvaluatorOptimizer({
  generator: {
    name: 'team',
    agent: createParallel({
      branches: TEAM.map((name) => ({ name, agent: contextAgent(name, { output: Report }) })),
      merge: 'submission',
      aggregator: (results) => results,
      evaluation: ReviewReport,
      rerun: ({ evaluation }) => evaluation.findings.map((finding) => finding.agent),
    }),
  },
  evaluator: { name: 'review', agent: contextAgent('review', { output: ReviewReport }) },
  passed: (report) => report.findings.length === 0,
  maxIterations: 2,
});
`;

/** The drawn topology as `source --> target` lines, `-.->` for conditional edges. */
const edgeLines = (graph: {
  readonly edges: ReadonlyArray<{ source: string; target: string; conditional: boolean }>;
}) => graph.edges.map((edge) => `${edge.source} ${edge.conditional ? '-.->' : '-->'} ${edge.target}`).sort();

const stepIds = (graph: { readonly nodes: ReadonlyArray<{ id: string; kind: string }> }) =>
  graph.nodes.flatMap((node) => (node.kind === 'step' ? [node.id] : [])).sort();

const FUNCTIONAL = `
import { entrypoint, task } from '@langchain/langgraph';

const step = task('step', async (value) => value);
export default entrypoint('brief', async (input) => step(input));
`;

describe('extractWorkflowGraph', () => {
  it.effect('reads nodes and edges off a compiled StateGraph', () =>
    Effect.gen(function* () {
      const graph = yield* graphOf(STATE_GRAPH);

      expect(
        graph.nodes
          .filter((node) => node.kind === 'step')
          .map((node) => node.id)
          .sort(),
      ).toEqual(['classify', 'escalate', 'reply']);
      expect(graph.nodes.some((node) => node.kind === 'start')).toBe(true);
      expect(graph.nodes.some((node) => node.kind === 'end')).toBe(true);
      expect(workflowGraphHasTopology(graph)).toBe(true);
    }),
  );

  it.effect('marks branch targets conditional, and only the declared ones', () =>
    Effect.gen(function* () {
      const graph = yield* graphOf(STATE_GRAPH);

      const branches = graph.edges.filter((edge) => edge.source === 'classify');
      expect(branches.every((edge) => edge.conditional)).toBe(true);
      // Without the path map LangGraph would list every other node here.
      expect(branches.map((edge) => edge.target).sort()).toEqual(['escalate', 'reply']);
    }),
  );

  it.effect('expands a nested pattern level by level under its roles, a bound agent as one step', () =>
    Effect.gen(function* () {
      const graph = yield* graphOf(PATTERN_GRAPH);
      const ids = graph.nodes.map((node) => node.id);

      // The loop's roles, and inside the desk the router's steps with their participants.
      expect(ids).toEqual(
        expect.arrayContaining([
          'support:desk:route',
          'support:desk:billing',
          'support:desk:synthesize',
          'support:desk:docs:model_request',
          'support:desk:docs:tools',
          'support:review',
        ]),
      );
      // The bound agent runs on the host: nothing inside it is drawn.
      expect(ids.filter((id) => id.startsWith('support:desk:billing:'))).toEqual([]);
      expect(graph.nodes.find((node) => node.id === 'support:desk:route')?.group).toBe('support:desk');
      const branches = graph.edges.filter((edge) => edge.source === 'support:desk:route');
      expect(branches.every((edge) => edge.conditional)).toBe(true);
      expect(edgeLines(graph)).toEqual(
        expect.arrayContaining([
          'support:desk:synthesize --> support:review',
          'support:review -.-> support:desk:route',
          'support:review -.-> support:__end__',
          'support:__end__ --> respond',
        ]),
      );
    }),
  );

  it.effect('draws a research review loop as research → review → research | end, the orchestrator inside', () =>
    Effect.gen(function* () {
      const graph = yield* graphOf(RESEARCH_REVIEW_GRAPH);

      expect(stepIds(graph)).toEqual([
        'research:plan',
        'research:prepare',
        'research:researcher',
        'research:synthesize',
        'review',
      ]);
      expect(edgeLines(graph)).toEqual([
        '__start__ --> research:prepare',
        'research:plan -.-> research:researcher',
        'research:plan -.-> research:synthesize',
        'research:prepare --> research:plan',
        'research:researcher --> research:plan',
        'research:synthesize --> review',
        'review -.-> __end__',
        'review -.-> research:prepare',
      ]);
    }),
  );

  it.effect('draws specialists under their names, merged into the submission the review loops back from', () =>
    Effect.gen(function* () {
      const graph = yield* graphOf(SPECIALISTS_GRAPH);

      expect(stepIds(graph)).toEqual(['review', 'team:legal', 'team:market', 'team:submission', 'team:tech']);
      expect(edgeLines(graph)).toEqual([
        '__start__ --> team:__start__',
        'review -.-> __end__',
        'review -.-> team:__start__',
        'team:__start__ -.-> team:legal',
        'team:__start__ -.-> team:market',
        'team:__start__ -.-> team:submission',
        'team:__start__ -.-> team:tech',
        'team:legal --> team:submission',
        'team:market --> team:submission',
        'team:submission --> review',
        'team:tech --> team:submission',
      ]);
    }),
  );

  it.effect('reports no topology for the functional API, whose shape only exists at runtime', () =>
    Effect.gen(function* () {
      const graph = yield* graphOf(FUNCTIONAL);

      expect(workflowGraphHasTopology(graph)).toBe(false);
    }),
  );
});

describe('extractWorkflowContracts', () => {
  it.effect('derives input and output JSON Schema from a Zod-typed StateGraph', () =>
    Effect.gen(function* () {
      const compiled = yield* compiledOf(ZOD_GRAPH);

      const contracts = extractWorkflowContracts(compiled);

      expect(contracts.input).toMatchObject({ type: 'object', required: ['text'] });
      expect(contracts.output).toMatchObject({ type: 'object', required: ['reply'] });
    }),
  );

  it.effect('derives nothing from Annotation-based or functional graphs', () =>
    Effect.gen(function* () {
      expect(extractWorkflowContracts(yield* compiledOf(STATE_GRAPH))).toEqual({});
      expect(extractWorkflowContracts(yield* compiledOf(FUNCTIONAL))).toEqual({});
    }),
  );
});
