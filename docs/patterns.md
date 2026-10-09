# Multi-agent patterns

`agentdock-patterns` packages the graph-level multi-agent patterns as
factories for agentdock workflows: pipeline, router, parallel fan-out, voting,
map-reduce, orchestrator-workers and evaluator-optimizer loops. The
participants are platform agents (`contextAgent`) and the models the patterns
call themselves are platform models (`contextModel`); a pattern only wires
them into a LangGraph graph whose nodes are named after the participants'
roles, so the workflow's graph view shows who does what. It is a thin layer
over LangGraph (`StateGraph`, `Send`): there is no custom runtime, and the
graphs it builds are ordinary LangGraph graphs.

The package ships with agentdock and is **host-provided** like LangGraph
itself, so workflow artifacts import it without installing it. It has no
dependency on the agentdock runtime: bound agents and models reach it through
LangGraph's own runtime `context` (see
[Workflows](workflows.md#the-injected-context)).

## Why there are no agent-level patterns

Single agents, supervisors, hierarchies, swarms, state machines and skills are
patterns *inside* one agent: its instructions, tools, skills, output contract
and delegation. On agentdock those are what a platform agent is. Give an
agent its skills and tools, an output schema, and other agents to delegate to
(`send_task`), and the platform runs, limits, records and evaluates its loop.
A workflow then binds that agent (`contextAgent`) and decides only the
structure between agents, which is what this package does. Loop limits, run
budgets and per-run MCP tools are platform concerns for the same reason.

## Setup

Declare it as an optional peer next to the LangChain packages. It is not on the
npm registry, and an optional peer makes `bun install` record the range without
trying to fetch it. `agentdock new` scaffolds exactly this:

```json
{
  "peerDependencies": {
    "agentdock-patterns": "^0.1.0",
    "@langchain/core": "^1.2.12",
    "@langchain/langgraph": "^1.4.5",
    "langchain": "^1.5.2"
  },
  "peerDependenciesMeta": { "agentdock-patterns": { "optional": true } }
}
```

The server links it into its artifact root and checks the declared range
against the version it ships, like every host-provided package. `agentdock init`
links it into a project from the host's copy (a `file:` dependency), so local
runs resolve it too. Subpaths: `agentdock-patterns` (the patterns) and
`agentdock-patterns/testing` (scripted model, usage tracker).

The package is TypeScript source with explicit `.ts` imports and only erasable
syntax, so it loads under `tsx` and Bun as well as in plain Node through
Node's type stripping (Node 22.18 / 23.6 and later). Node does not strip types
under `node_modules`; the host's symlink resolves to the real path outside it.

## Participants and platform models

Every pattern speaks one contract: `{ messages }` in, `{ messages,
structuredResponse? }` out, with the answer appended as the last message.
Anything with an `invoke` that follows it is an `Agent`: a bound agent, a
`createAgent(...)` built in the artifact, or another pattern, so patterns nest.

A participant is an agent under the name of its role, `{ name, agent }`, with
an optional `description`. The name becomes the pattern's node, and must match
`[A-Za-z0-9_-]+`, be unique in the pattern and differ from the pattern's own
node and state keys. Routers and orchestrators show the descriptions to their
model to decide whom to involve, so write them for the model there.

```ts
import { contextAgent, contextModel, createRouter } from 'agentdock-patterns';

const desk = createRouter({
  model: contextModel('desk'),
  routes: [
    { name: 'billing', description: 'Invoices and refunds.', agent: contextAgent('billing') },
    { name: 'tech', description: 'Errors and outages.', agent: contextAgent('tech') },
  ],
});
```

- `contextAgent(name)` resolves `config.context.agents[name]` when it is
  invoked: the agent the manifest's `agents.<name>` binds. It forwards only
  `messages`.
- `contextAgent(name, { output: Schema })` also parses the agent's
  `structuredResponse` with the Zod schema, so its answer is typed
  (`Agent<z.output<Schema>>`) and a verdict or report can be read in code. A
  missing or mismatching answer fails the step with an error naming the agent
  and the mismatch. Give the platform agent the matching output schema.
- `contextModel(name)` is the model counterpart: every `model` option accepts
  it, next to a chat model instance and a `provider:model` id
  (`initChatModel`). It resolves `config.context.models[name]`, a LangChain
  chat model the host injects, at every call and never when the graph is
  built. On agentdock that is the platform model the manifest binds, so the
  call runs on the platform's provider keys and custom providers and is
  recorded on the calling step. Structured output goes through the bound
  model's own `withStructuredOutput`, natively where its profile declares
  support (see `structuredOutputMethod`).

Declare the names in `agentdock.workflow.json`:

```json
{
  "agents": { "billing": { "description": "Answers invoice and refund questions." } },
  "models": { "desk": { "description": "Routes and writes the reply.", "default": "openai:gpt-5.6-luna" } }
}
```

Locally pass them yourself: `graph.invoke(input, { context: { agents: {
billing }, models: { desk: new ChatOpenAI({ model: 'gpt-5.6-luna' }) } } })`.
Both resolve lazily, so a graph built from them is created once at module
scope, needs neither a key nor a binding at registration, and keeps a static
topology. The run's `context` reaches every participant inside a pattern.

## Using a pattern in a workflow

A workflow's input is its own domain schema, not a conversation. There are two
ways to put a pattern inside one.

**As a subgraph node** that shares the `messages` key:

```ts
import { HumanMessage } from '@langchain/core/messages';
import { END, MessagesValue, START, StateGraph, StateSchema } from '@langchain/langgraph';
import { z } from 'zod';

const State = new StateSchema({ text: z.string(), messages: MessagesValue, reply: z.string().default('') });

export default new StateGraph(State)
  .addNode('prepare', (state) => ({ messages: [new HumanMessage(state.text)] }))
  .addNode('desk', desk)
  .addNode('respond', (state) => ({ reply: state.messages.at(-1)?.text ?? '' }))
  .addEdge(START, 'prepare')
  .addEdge('prepare', 'desk')
  .addEdge('desk', 'respond')
  .addEdge('respond', END)
  .compile();
```

Declare the other output keys you want to read in the parent state too (a
review loop's `evaluation`, an orchestrator's `results`, a parallel's
`branchResults`). A pattern's `structuredResponse` has the type of its answer
(an aggregator's value, a `responseFormat`, a generator's answer), so declare
it with its real schema, e.g. `structuredResponse: Report.optional()`.

**Through `agentAsNode`**, which maps any state onto the contract and back
(defaults: pass `messages` in, append the answer's last message). Pass the
pattern as the node's subgraph to keep its steps in the graph view:

```ts
.addNode(
  'resolve',
  agentAsNode(desk, {
    input: (state) => ({ messages: [new HumanMessage(state.text)] }),
    output: (result) => ({ reply: finalText(result) }),
  }),
  { subgraphs: [desk] },
)
```

## What the graph view shows

agentdock draws a workflow from `getGraphAsync({ xray: true })`: a node whose
subgraph is a compiled graph is expanded in place as `parent:child`. Every
pattern names its nodes after its participants and keeps a generic node only
where no participant runs (the router's own model call, a merge in code):

| Pattern | Nodes and edges |
| --- | --- |
| Pipeline | `classify → enrich → answer`; a gated step also `-.-> __end__` |
| Router | `route -.-> billing \| tech -.-> synthesize`; `route -.-> synthesize` when nobody is chosen |
| Parallel | `__start__ -.-> legal \| market \| tech → submission` (the `merge` name); the fan-out is conditional because a revision runs only some branches |
| Voting | `classify → tally` (the voter's node runs `n` times) |
| Map-reduce | `triage → reduce` (the mapper's node runs once per item) |
| Orchestrator | `prepare → plan -.-> researcher → plan`, `plan -.-> synthesize` |
| Evaluator-optimizer | `research → review -.-> research \| __end__`; the evaluator writes the result when the loop ends |

- A pattern added as a node, or used as a participant, is drawn under that
  name level by level: `support:desk:billing`, `team:submission`.
- Participants built in the artifact (`createAgent` with tools, another
  pattern) are declared as their node's subgraph and drawn too
  (`team:docs:model_request`); LangGraph JS draws a subgraph of one step as
  one node.
- Bound agents (`contextAgent`) run on the host: each is a single step.
- A subgraph without a single entry or exit (a review loop, a fan-out) keeps
  its `__start__` / `__end__` as `team:__start__`, which the parent's edges
  connect to.
- `agentAsNode` without `{ subgraphs }` is a single step.

Three drawn examples, as `extractWorkflowGraph` reads them:

```text
# A research review loop: an orchestrator with a bound researcher, reviewed by a bound agent
__start__ --> research:prepare --> research:plan -.-> research:researcher --> research:plan
research:plan -.-> research:synthesize --> review -.-> research:prepare | __end__

# Specialists reworking what the review found (the example below)
__start__ --> team:__start__ -.-> team:market | team:legal | team:tech | team:submission
team:market | team:legal | team:tech --> team:submission --> review -.-> team:__start__ | __end__

# The support-desk example: a router desk in a review loop, embedded as `support`
prepare --> support:__start__ --> support:desk:route -.-> support:desk:billing | support:desk:tech
support:desk:billing | support:desk:tech --> support:desk:synthesize --> support:review
support:review -.-> support:desk:route | support:__end__ --> respond
```

`getState(config, { subgraphs: true })` shows the state of an interrupted
participant, and an `interrupt()` inside a participant pauses the whole
workflow and resumes where it stopped.

## Choosing a pattern

Start with the simplest thing that works, and measure. One platform agent with
good tools and skills beats most multi-agent designs. Keep known business
processes as workflows and put agents inside the steps.

| If you need… | Use |
| --- | --- |
| One agent, its tools, skills or delegation | A platform agent, called with `contextAgent` |
| A fixed, auditable sequence with early exits | `createPipeline` |
| Clear input categories with specialists | `createRouter` |
| Independent analyses at once, majority votes, batch work | `createParallel`, `createVoting`, `createMapReduce` |
| Sub-tasks that depend on intermediate results | `createOrchestrator` with `maxRounds > 1` |
| A checkable quality bar | `createEvaluatorOptimizer` around any of the above |

Who decides the control flow differs: the graph (pipeline, parallel), one model
decision then the graph (router), a plan (orchestrator), or a verdict
(evaluator-optimizer). Put irreversible side effects in code or behind an
`interrupt()` approval, never only in a prompt.

## Reference

Every factory takes one options object and returns a compiled `StateGraph`.
Shared options:

- `name`: the graph name, used in traces (each factory has a default).
- `checkpointer`: only the outermost graph needs one; on agentdock the host
  injects it, so artifacts set none.
- `retryPolicy` (a LangGraph `RetryPolicy`) and `timeout` on every factory,
  applied to each step that runs an agent or a model: a failed step is retried
  on its own, so one transient error does not rerun the whole pattern, and an
  attempt over `timeout` (milliseconds, or a LangGraph `TimeoutPolicy` that can
  also cap idle time) is aborted with `NodeTimeoutError`, which the default
  `retryOn` retries.
- `structuredOutputMethod` on every pattern that makes its own structured
  model call (router, `structuredStep`, parallel synthesis, orchestrator,
  model judge): `'auto'` (default) uses the provider's native structured output
  (`withStructuredOutput(schema, { method: 'jsonSchema' })`) when the model's
  profile declares support, the same rule `createAgent` applies to
  `responseFormat`, and the provider default (usually forced tool calling)
  otherwise. `'functionCalling'`, `'jsonSchema'` or `'jsonMode'` force one.
- `responseFormat` is a Zod schema; the parsed answer is the
  `structuredResponse`, typed by it.

### Sequential pipeline

`createPipeline({ steps, output?, retryPolicy?, timeout?, checkpointer?, name? })`
with steps built by `llmStep({ name, model, systemPrompt })` (one model call,
text output), `structuredStep({ name, model, systemPrompt, schema,
structuredOutputMethod? })`, `agentStep({ name, agent })` (any participant,
drawn as a subgraph) and `functionStep({ name, run })` (deterministic `async`
code). Each step records `outputs[name]` (`{ text, value? }`), and later steps
see earlier outputs in their prompt (`defaultPrompt`, or `prompt(state)`). A
step's `gate(output, state)` returning `false` stops the pipeline;
`onGateFail(output, state)` supplies the result instead. `output` picks the
result: a step name, a function of the state (typing `structuredResponse`), or
the last step that ran. The step that ends the run writes the result. Input `{
messages, context? }`; output adds `structuredResponse`, `outputs` and
`stoppedAt`.

### Router

`createRouter({ model, routes, systemPrompt?, allowMultiple?, routeFn?,
synthesizerPrompt?, responseFormat?, synthesize?, structuredOutputMethod?,
retryPolicy?, timeout?, checkpointer?, name? })`. One structured routing call
(`RoutingDecision`, route names as an enum, the descriptions as the catalog)
picks participants and writes each a self-contained task; they run in
parallel and a synthesizer merges the answers. A single answer without a
`responseFormat` is passed through without a synthesis call. `routeFn(state)`
replaces the model with code. Nodes: `route`, the route names, `synthesize`.
Output: `messages`, `structuredResponse` (with `responseFormat`), `routes`.

### Parallelization

- `createParallel({ branches, merge?, aggregator?, model?, synthesizerPrompt?,
  responseFormat?, structuredOutputMethod?, evaluation?, rerun?, retryPolicy?,
  timeout?, checkpointer?, name? })`: every branch gets the request and is a
  node under its name; the merge node is named `merge` (default `'merge'`).
  The results are merged by `aggregator(branchResults, state)` in code (its
  value is the `structuredResponse`), by a synthesis call with `model`, or
  else joined as text. `branchResults` are typed with the branches' answer
  types. For revisions see [Targeted rework](#targeted-rework). Output adds
  `branchResults`.
- `createVoting({ voter, n?, key?, retryPolicy?, timeout?, checkpointer?,
  name? })`: the `voter` participant runs `n` times (default 3) in its node,
  and the majority of `key(result)` wins (ties go to the earliest). Use a
  temperature above 0. Output adds `votes`.
- `createMapReduce({ mapper, prepare?, extract?, reduce?, retryPolicy?,
  timeout?, checkpointer?, name? })`: `mapper` is `{ name, agent }` where the
  agent is any runnable (a pattern, a workflow graph, a `RunnableLambda`),
  run once per item in its node. Input `{ items }`, output `{ results, output
  }` in item order; `prepare(item)` builds the mapper's input,
  `extract(output)` the per-item result, `reduce(results)` the `output`.

### Orchestrator-workers

`createOrchestrator({ model, workers, plannerPrompt?, synthesizerPrompt?,
responseFormat?, maxRounds?, maxTasksPerRound?, structuredOutputMethod?,
retryPolicy?, timeout?, checkpointer?, name? })`. A planner (`Plan`, worker
names as an enum, the descriptions as the catalog) splits the request into
tasks at run time, and the same worker can get several. With `maxRounds > 1`
it sees every result and plans again until it returns no tasks. Input `{
messages, results? }`: earlier `results` are shown to the planner, which plans
only what is missing, and to the synthesizer; round numbers continue after
them, and `prepare` resets the round limit per run, so a reused thread plans
again. Nodes: `prepare`, `plan`, the worker names, `synthesize`. Output:
`results` as `{ round, worker, task, output }` (`WorkResult`), earlier work
included.

### Evaluator-optimizer

`createEvaluatorOptimizer({ generator, evaluator, evaluatorContext?,
evaluatorInput?, carryOver?, passed?, feedback?, maxIterations?,
onMaxIterations?, keepHistory?, structuredOutputMethod?, retryPolicy?,
timeout?, checkpointer?, name? })`.

- `generator`: a participant, patterns included. Its name is the generating
  node.
- `evaluator`: a participant whose structured response is the verdict (e.g.
  `contextAgent('review', { output: Evaluation })`, optionally with a `prompt`
  added to the review request as criteria), or a model judge `{ name, model,
  prompt, output? }`: one structured call per review with `prompt` as its
  rubric and `output` as the verdict schema (default `Evaluation`: `passed`,
  `score`, `issues`, `feedback`). Its name is the reviewing node; the two names
  must differ.
- `passed(verdict)` (default: its `passed`) and `feedback(verdict)` (default:
  its feedback and issues) are typed with the verdict.
- `evaluatorContext(state)`: extra material for the reviewer next to the
  request and the candidate, typically the evidence:
  `(state) => resultsBlock(state.results ?? [], 'Research results')`.
- `evaluatorInput(state)`: replaces what the reviewer is sent. `state.request`
  holds the loop's input messages, `state.candidate` the candidate (`{ text,
  structured? }`). Excludes `evaluatorContext`; a model judge keeps its rubric.
- `carryOver`: generator output keys the loop takes as input (handed to the
  first generation), returns and shows the evaluator callbacks, with their
  schemas, e.g. `{ results: WorkResults }`.
- `keepHistory` (default `true`): a revision continues the generator's own
  conversation, so an agent does not repeat its tool calls; `false` restarts it
  from the request, the last candidate and the feedback.
- `onMaxIterations(candidate, verdict)` replaces the last candidate when the
  cap (`maxIterations`, default 3) is hit without passing, e.g. with an
  escalation.
- When the loop ends, passed or capped, the evaluator node writes the result:
  there is no separate finish step. Output: `messages`, `structuredResponse`
  (the generator's answer, typed), `evaluation`, `iterations`, plus the
  `carryOver` keys.

**The revision contract.** On a revision the generator is invoked with its own
previous output (minus `structuredResponse`), its `messages` continued with
the revision request (`feedback(verdict)`), and the verdict as `evaluation`.
A bound agent receives only the messages. The patterns build on the rest: an
orchestrator plans only what is missing from its `results`, and a parallel
with `rerun` runs only the branches the verdict names.

A research loop with review: an orchestrator with a researcher worker, inside
a review loop whose reviewer sees the research:

```ts
const research = createOrchestrator({
  model: contextModel('planner'),
  workers: [{ name: 'researcher', description: 'Researches one question.', agent: contextAgent('researcher') }],
  responseFormat: Report,
});
const reviewed = createEvaluatorOptimizer({
  generator: { name: 'research', agent: research },
  evaluator: { name: 'review', agent: contextAgent('reviewer', { output: Evaluation }) },
  carryOver: { results: WorkResults },
  evaluatorContext: (state) => resultsBlock(state.results ?? [], 'Research results'),
  maxIterations: 3,
});
```

A failed review sends the report and the feedback back to the orchestrator
together with its earlier `results`; the planner researches only the gaps.

### Targeted rework

A team of specialists writes reports in parallel, a reviewer files findings
per specialist, and only the specialists with findings rework theirs:

```ts
const Report = z.object({ summary: z.string(), sources: z.array(z.string()) });
const ReviewReport = z.object({ findings: z.array(z.object({ agent: z.string(), issue: z.string() })) });
const TEAM = ['market', 'legal', 'tech'];

const submission = (results: BranchResults<z.infer<typeof Report>>) =>
  TEAM.map((name) => ({ name, report: results[name]?.structured }));
const rework = (review: z.infer<typeof ReviewReport>) =>
  `Rework these findings:\n${review.findings.map((f) => `- ${f.agent}: ${f.issue}`).join('\n')}`;

export const assessment = createEvaluatorOptimizer({
  generator: {
    name: 'team',
    agent: createParallel({
      branches: TEAM.map((name) => ({ name, agent: contextAgent(name, { output: Report }) })),
      merge: 'submission',
      aggregator: submission,
      evaluation: ReviewReport,
      rerun: ({ evaluation }) => evaluation.findings.map((f) => f.agent),
    }),
  },
  evaluator: { name: 'review', agent: contextAgent('review', { output: ReviewReport }) },
  passed: (review) => review.findings.length === 0,
  feedback: rework,
  maxIterations: 2,
});
```

The parallel's state contract:

- Input `{ messages, branchResults?, evaluation? }`. Without `evaluation`
  (the first run, or any run that is no revision) every branch runs on
  `messages`.
- With `evaluation`, it is a revision: the verdict is parsed with the
  `evaluation` schema (default `Evaluation`; pass the evaluator's verdict
  schema, which also types `rerun`) and `rerun({ evaluation, branchResults,
  messages })` names the branches to run again. Names that are no branch are
  ignored; a branch without a previous result always runs; without `rerun`
  every branch runs. Each branch that runs continues its own conversation
  (`branchResults[name].messages`) with the revision request, the last of
  `messages`, rather than the merged submission. Only those branches are
  sent (`Send`); the others keep their previous result.
- Output `branchResults` holds every branch, new and kept, and the merge sees
  all of them, so `submission` always covers the whole team.

In the evaluator-optimizer above the second round therefore runs `legal`
alone when only legal has findings, and `review` sees a submission with all
three reports.

### Core helpers

| Helper | Purpose |
| --- | --- |
| `contextAgent(name, { output? })` | A platform agent, resolved from `config.context.agents` when invoked; `output` types and checks its answer. |
| `contextModel(name)` | A platform model, resolved from `config.context.models` at every call (`ContextModel#resolve(config)` for your own nodes). |
| `agentAsNode(agent, { input?, output? })` | Adapt a participant to a graph with another state. |
| `agentGraph(agent)` | The compiled graph behind a participant (for `subgraphs`), if any. |
| `invokeAgent(participant, task, config?)` | Invoke with a string or messages; returns `{ name, text, structured?, messages }`. |
| `finalText(output)` | The structured response as JSON, or the last message's text. |
| `structuredLlm(model, schema, { name, method? })` | The structured call the patterns make (`StructuredOutputMethod`). |
| `resultsBlock(results, header?)` | Participant results or orchestrator `results` as a prompt block. |

## Limits

The patterns' own loops have caps: `maxRounds` and `maxTasksPerRound` on the
orchestrator, `maxIterations` on the evaluator-optimizer, `n` on voting.
LangGraph's `recursionLimit` is the backstop for the whole graph (it counts
super-steps; agentdock runs workflows with 100, nested graphs count their
own). Limits of an agent's own loop (model and tool calls, delegations) belong
to the platform agent and are enforced where it runs.

## Testing

`agentdock-patterns/testing` unit-tests orchestration without API calls:

```ts
import { scriptedModel } from 'agentdock-patterns/testing';

const model = scriptedModel((turn) => {
  if (turn.system.includes('router')) return turn.structured({ routes: [{ agent: 'billing', task: turn.lastHuman }] });
  return turn.say('merged');
});
await graph.invoke(input, { context: { models: { desk: model }, agents: { billing: fakeBilling } } });
```

- The policy sees the call (`turn.system`, `turn.lastHuman`, `turn.toolNames`,
  `turn.toolResults()`, `turn.result(name)`, `turn.callResults()`,
  `turn.structuredToolSchema()`, …) and replies with `turn.say`, `turn.call`,
  `turn.callMany` (parallel calls) or `turn.structured(data)`.
- `turn.structured` answers both structured-output paths: tool calling, and
  native structured output, which `scriptedModel(policy, { profile: {
  structuredOutput: true } })` simulates the way current OpenAI and Anthropic
  models declare it. `model.calls` records every call.
- It throws `ScriptError` for what a real model cannot do: calling an unbound
  tool, or answering in text when a tool call is forced.
- `UsageTracker` (a callback) counts model calls, tokens and tool calls, model
  calls per node included.
- Bound agents are stubbed with any object with an `invoke` (or a
  `createAgent`), passed as `{ context: { agents } }`; platform models with a
  scripted model, passed as `{ context: { models } }`.

## Design notes

- Participants are `{ name, agent }` and name the pattern's nodes; the
  evaluator-optimizer's nodes are its generator's and evaluator's names, and
  its finish step is folded into the evaluator. The parallel's merge node is
  named by `merge`, the voter's and mapper's nodes by their names.
- `contextAgent(name, { output })` types a bound agent's answer, and
  `contextModel(name)` makes a platform model a `model` option.
- `createParallel` reworks only the branches `rerun` names, and the
  evaluator-optimizer hands the generator its previous output and the verdict
  on a revision (`carryOver` does not need to list them).
- Graph view: LangGraph JS cannot see which participants a node calls, so the
  patterns declare them (`addNode(…, { subgraphs })`). With `agentAsNode` you
  pass `{ subgraphs }` yourself. LangGraph JS draws one-step subgraphs as one
  node.
- `retryPolicy` is one LangGraph `RetryPolicy` (JS takes one per node); combine
  `retryOn` predicates instead of passing several. `timeout` is in milliseconds
  and also works under `invoke`.
- Structured output methods are LangChain JS's (`'jsonSchema'`,
  `'functionCalling'`, `'jsonMode'`). Pipeline LLM steps are `llmStep` (text)
  and `structuredStep` (schema), gates receive the step's output, and outputs
  are recorded as `{ text, value? }`.
- Model ids resolve through `initChatModel` in the artifact, so they use the
  host's provider environment variables, not agentdock's provider keys, and
  their calls are not recorded as model calls of the run. Use `contextModel`
  for that.

## Caveats

- Carried-over keys are last-value in the review loop: the generator is
  expected to return the complete value (the orchestrator returns earlier plus
  new `results`, the parallel every branch). Do not give such a key an
  appending reducer in the parent.
- TypeScript cannot infer the verdict type of a parallel nested inside an
  evaluator-optimizer from the evaluator, so pass `evaluation: VerdictSchema`
  to the parallel to type `rerun`.
- Multi-agent patterns multiply model calls and tokens. Measure against a
  single platform agent before committing to one.
