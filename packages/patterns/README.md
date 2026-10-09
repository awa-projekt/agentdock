# agentdock-patterns

Graph-level multi-agent patterns for agentdock workflows: pipeline, router,
parallel / voting / map-reduce, orchestrator-workers and evaluator-optimizer.
The participants are platform agents (`contextAgent`) and the patterns' own
models platform models (`contextModel`); every pattern names its graph nodes
after the participants' roles, so the workflow graph view shows who does what.
Plain LangGraph underneath, with no dependency on the agentdock runtime.
Workflow artifacts get it from the host like `@langchain/langgraph`.

```ts
import { contextAgent, contextModel, createEvaluatorOptimizer, createRouter } from 'agentdock-patterns';

const desk = createRouter({
  model: contextModel('desk'),
  routes: [
    { name: 'billing', description: 'Invoices and refunds.', agent: contextAgent('billing') },
    { name: 'tech', description: 'Errors and outages.', agent: contextAgent('tech') },
  ],
});

// Drawn as `desk:route → desk:billing | desk:tech → desk:synthesize → review → desk | end`.
export const support = createEvaluatorOptimizer({
  generator: { name: 'desk', agent: desk },
  evaluator: { name: 'review', model: contextModel('review'), prompt: 'Pass replies that answer every question.' },
});
```

Every factory speaks one contract (`{ messages }` in, `{ messages,
structuredResponse? }` out), so patterns nest and embed as subgraphs.
`contextAgent(name, { output })` types a bound agent's answer; a parallel
inside a review loop reworks only the branches the verdict names (`rerun`).
Agent-level patterns (supervisors, swarms, skills, loop limits) are not here:
they are what a platform agent is. `agentdock-patterns/testing` has a scripted
chat model for testing orchestration without API calls.

The source is TypeScript with explicit `.ts` imports and only erasable syntax,
so it also loads in plain Node through type stripping.

See [docs/patterns.md](../../docs/patterns.md) for setup, participants and
platform models, what the graph view shows, the reference, and design notes.
