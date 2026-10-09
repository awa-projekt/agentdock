# Workflows

Workflows are the escape hatch for work that plain agents cannot express. They
are **ordinary LangGraph code in a folder**, registered on the platform and
invoked like agents through A2A.

If a task can be done by an agent with tools, use an agent. Reach for a workflow
when you need code-level control over orchestration: deterministic fan-out,
retries with specific policies, or a human sign-off gate in a known place.

## The artifact

```
my-workflow/
  agentdock.workflow.json   ← manifest
  package.json              ← the artifact's own dependencies
  bun.lock                  ← required to push; the server installs from it
  workflow.ts               ← exports a compiled LangGraph
  lib/…                     ← anything else, imported normally
```

The code imports nothing from the agentdock runtime. Everything the host
provides — the durable checkpointer, the agents the workflow may call, run
identity — is injected through LangGraph's own runtime `context` and
`configurable` at invoke time. For multi-agent orchestration the host also
provides [`agentdock-patterns`](patterns.md), plain LangGraph factories for
routers, pipelines, parallel fan-outs and review loops whose nodes are named
after the roles in them. The manifest carries what the
graph object cannot express by itself: identity, where to find the export, and
the dependencies to bind at registration.

Examples: `apps/examples/workflows/ticket-triage` (`StateGraph`, Zod schemas),
`apps/examples/workflows/market-brief` (functional API, `interrupt()`),
`apps/examples/workflows/support-desk` (a router inside a review loop from
`agentdock-patterns`, over bound agents) and
`apps/examples/workflows/content-publisher` (`interrupt()` review gate with a
revise loop, a bound integration tool).

### Manifest

```json
{
  "$schema": "http://localhost:38123/schemas/workflow-manifest.json",
  "name": "Ticket triage",
  "description": "Classifies a ticket, escalates or drafts a reply.",
  "version": "0.2.0",
  "graph": "./workflow.ts:default",
  "agents": { "writer": { "description": "Writes the customer-facing reply." } },
  "models": { "classifier": { "description": "Labels the ticket.", "default": "openai:gpt-6-luna" } }
}
```

| Field | Meaning |
| --- | --- |
| `$schema` | Optional. The manifest's JSON Schema is served at `<api>/schemas/workflow-manifest.json` for editor support. |
| `name`, `description`, `version` | Identity. `name` is how the registry recognises a re-push of the same workflow and how other workflows bind to it. Drives the A2A agent card. |
| `graph` | `<module>:<export>` relative to the folder. Defaults to `./workflow.ts:default`. |
| `input` | JSON Schema for the task input. Omit it when the graph declares an input schema (Zod, `StateSchema`); the registry derives it. A graph built from plain `Annotation`s or the functional API declares nothing, so state it here to get an input contract. Without either, any task is accepted and its content reaches the graph as-is. |
| `output` | JSON Schema for the final output. Derived from the graph's output schema when omitted. |
| `agents` | Map of local name → `{ description? }`. Each name appears in code as `context.agents.<name>` and is bound to a registered agent at registration. Never a database id. |
| `workflows` | Same shape, for registered workflows the code invokes as `context.workflows.<name>`. |
| `tools` | Same shape, for integration tools the code calls as `context.tools.<name>`. Each name is bound to one tool of the platform's tool catalog (MCP and OpenAPI sources) at registration. |
| `models` | Map of local name → `{ description?, default?, reasoningEffort? }`, for chat models the code calls as `context.models.<name>`. Each name is bound to a platform model (`provider:model`) at registration: `--bind <name>=<provider:model>`, else `default`. `reasoningEffort` (`none` … `max`) applies to whichever model the name is bound to. The platform holds the provider keys. |
| `secrets` | Names the code reads from `context.secrets`. Each must be set as an environment variable on the host at registration. |

Control flow, state, retries, fan-out and human gates live in the code. None of
it is mirrored in the manifest.

### The graph export

The `graph` export is a compiled LangGraph — whatever `StateGraph#compile()` or
`entrypoint(...)` returns — or a function `(runtime) => compiled` producing one.
Two rules:

- **No checkpointer.** Compile without one; the host injects its durable
  checkpointer at run time. An export whose `checkpointer` is set fails
  registration.
- **No agentdock runtime import.** The artifact only depends on LangGraph,
  LangChain, optionally `agentdock-patterns`, and its own packages.

```ts
import { END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';

const Input = z.object({ email: z.string(), text: z.string() });
const Output = z.object({ reply: z.string() });

const graph = new StateGraph({ input: Input, output: Output, state: Input.extend(Output.shape) })
  .addNode('draft', async (state, config) => {
    const out = await config.context.agents.writer.invoke({ messages: [{ role: 'user', content: state.text }] });
    return { reply: String(out.messages.at(-1)?.content) };
  })
  .addEdge(START, 'draft')
  .addEdge('draft', END)
  .compile();

export default graph;
```

Give `addConditionalEdges` a path map; without one LangGraph has to assume the
branch can reach every node, and the drawn topology says so.

### The injected context

Every node receives the host's context as `config.context`; in the functional
API read it with `getConfig().context`.

| Member | Type | Purpose |
| --- | --- | --- |
| `context.agents.<name>` | `Runnable<{ messages: BaseMessageLike[] }, { messages: BaseMessage[]; structuredResponse? }>` | A bound agent. Internal agents run in-process as native child graphs, external ones over A2A. `structuredResponse` is present when the agent declares an output schema. |
| `context.workflows.<name>` | `Runnable<Json, Json>` | A bound registered workflow: task input in, final output out. Runs as a subgraph with its own bindings. |
| `context.tools.<name>` | `StructuredToolInterface` (`@langchain/core/tools`) | A bound integration tool as a LangChain tool: `await tool.invoke(args)` runs it on the platform and returns its result, or hand it to a model. Arguments are validated against the catalog schema; every call is reported as step progress. |
| `context.models.<name>` | `BaseChatModel` (`@langchain/core`) | A bound platform model, built with the platform's provider keys. Messages may carry images and files as standard content blocks; they reach the provider in its own format. Every call is reported as step progress with its usage. |
| `context.secrets.<name>` | `string` | Values for the manifest's declared secret names. |
| `context.run` | `{ workflowId, runId, taskId, contextId }` | Identity of this run. |

Type it locally; the docs are the contract, not an import. For `StateGraph`,
declare a `context` schema so `config.context` is typed and validated:

```ts
type Agent = Runnable<{ messages: BaseMessageLike[] }, { messages: BaseMessage[] }>;
const Context = z.object({ agents: z.object({ writer: z.custom<Agent>() }) });
new StateGraph({ input, output, state, context: Context });
```

For the functional API, `getConfig().context` is `Record<string, any>`; read the
members into a local type:

```ts
type Ctx = { agents: { research: Agent; writer: Agent } };
const agents = (): Ctx['agents'] => getConfig().context?.agents;
```

Annotating a node parameter as `LangGraphRunnableConfig<Ctx>` does not compile
under strict function types unless the graph declares a matching `context`
schema, because LangGraph types the parameter from the graph. Use it for helper
functions you pass the config into.

Locally you pass `context` yourself when invoking (see below); on the platform
the runtime builds it from the workflow's bindings.

### The injected checkpointer

The host runs the graph with `configurable.__pregel_checkpointer` set to its
durable checkpointer, the same mechanism LangGraph Platform uses. The graph
never sees it at compile time. One LangGraph thread per A2A task, so a resumed
task rejoins its own checkpoint. To reproduce this locally:

```ts
graph.invoke(input, {
  configurable: { thread_id: 'local', __pregel_checkpointer: new MemorySaver() },
  context: { agents: { writer } },
});
```

## Dependencies

The artifact is a package: `package.json` declares what the code imports,
`bun.lock` pins it. `bun install` in the folder produces the lockfile; pushing
without one is rejected.

`@langchain/langgraph`, `@langchain/core`, `langchain` and `agentdock-patterns`
are **host-provided**. Declare them as `peerDependencies`, never `dependencies`:
a second copy of LangGraph inside the artifact breaks every `instanceof` the
runtime relies on, and registration rejects it. `@langchain/langgraph` must be
declared as a peer so the host can check its version; the server compares each
declared peer range against its installed version with semver and refuses an
artifact the host cannot satisfy. `agentdock-patterns` ships with agentdock
rather than the npm registry, so it is also listed as optional in
`peerDependenciesMeta`; `bun install` then records the range without fetching
it.

Running an artifact through the SDK or CLI applies the same rule locally: if the
folder's own `node_modules` holds a copy of a host-provided package that is not
the one the runtime loaded, the import is refused. Install artifact dependencies
with `bun install --omit=peer` and let the peers resolve from the surrounding
project (the repo's or your project's `node_modules`).

On the server, deployment writes the uploaded files to a staging folder,
validates, then runs

```
bun install --frozen-lockfile --production --omit=peer --ignore-scripts
```

and moves the result into `.agentdock/artifacts/<source hash>`. Host packages
resolve through symlinks in `.agentdock/artifacts/node_modules`, so every
artifact shares the host's single instance. The source hash covers every file in
the folder including `bun.lock` (never `node_modules`), so a dependency bump is a
new deployment. Runs verify the hash before importing; a folder whose sources no
longer match its recorded hash fails to run.

**Registered workflow code runs in the server process with its privileges.**
Pushing a folder is deploying code; the registry is the trust boundary.

## Bindings

Registration resolves every name under `agents`, `workflows`, `tools` and
`models` to one concrete target and stores the result on the workflow. A name matches exactly
one registered agent (internal before external), workflow, or catalog tool of
that name (`publish_post` matches the tool `publish_post` of whichever
integration exposes it). Anything unresolved or ambiguous fails the push with
every problem listed. Disambiguate with an explicit id; for tools that is the
catalog id, `tools.<integration>.<owner>.<connection>.<tool>`:

```
agentdock push my-workflow --bind writer=<agent id> --bind publish_post=<tool id>
```

A model name binds to `--bind <name>=<provider:model>`, or to its manifest
`default` when no `--bind` names it; a model with neither fails the push. The
provider must have a key configured on the platform when the run starts.

Bound tools run through the platform's integration gateway with the integration's own
credentials, outside any agent's tool policy: pushing a workflow that binds a
tool is granting it that tool.

A workflow cannot bind to itself. Declared `secrets` must exist as environment
variables on the host, or the push fails rather than a run at 3am.

Registration also imports the graph and records what it declares about itself:
its topology (nodes, edges, which edges are branches), which the web UI draws
with live node status in the run inspector, and its input/output JSON Schemas
where the manifest omits them. Node bodies are never parsed. `StateGraph` draws;
a functional-API workflow builds its shape while it runs and has no topology to
draw.

## Local development

```ts
import { createAgent } from 'langchain';
import graph from './workflow.ts';

const writer = createAgent({ model: 'openai:gpt-5.6-luna', systemPrompt: 'Write short support replies.' });
await graph.invoke({ email: 'ada@acme.com', text: '…' }, { context: { agents: { writer } } });
```

Any runnable over `{ messages }` satisfies an agent binding, so tests can pass a
`RunnableLambda`; any LangChain `tool()` satisfies a tool binding, any chat
model a model binding. Add
`__pregel_checkpointer` when the graph uses `interrupt()`.

`agentdock new <name> [--agent <name>…] [--tool <name>…]` scaffolds an artifact
folder under `workflows/`: manifest with `$schema`, `package.json` with the host
packages as peers at the platform's versions, a `StateGraph` with Zod
input/output schemas, a typed `context` schema for the agents and tools, one
node per bound agent, and a README with the commands below.

`agentdock check [folders…]` validates without uploading and reports what the
platform will see: the derived input/output JSON Schemas, the topology (steps
and edges, branches marked), where each manifest agent resolves locally, and
warnings (missing lockfile, unbound agents, unset secrets, no input contract).
Without folders it checks every workflow in the project. `--json` prints the
same as an array of reports.

`agentdock run <folder> <input>` runs the artifact the way the platform does —
in-memory checkpointer, event timeline, agent runs recorded. Each manifest agent
name resolves to `agents/<name>.agent.yaml` in the project, or to
`--agent name=<file|url>` (a local agent config or an A2A URL); `--secret
NAME=value` supplies declared secrets, falling back to the environment. Manifest
tools are bound against the tool catalog of the platform the project points at
and execute there (`--tool name=<tool id>` when several integrations expose the
same tool name): integrations and their credentials live on the platform, so a
local run calls them remotely rather than reimplementing them. Manifest models
bind to their `default`, or to `--model name=<provider:model>`, with the
provider keys of the local environment. `input`
is text, a JSON object, or `@path` to read from a file. An `interrupt()` is
answered from `--answer <json>` (repeatable, consumed in order) or, on a
terminal, interactively; unanswered, the run ends `input-required` with the
request printed. `--verbose` adds step inputs and outputs; `--json` emits every
event and a final `{"type":"result",…}` line as newline-delimited JSON for
scripts and coding agents.

`agentdock invoke <workflow> <input>` does the same against a registered
workflow over A2A, with the same `--answer`, `--verbose` and `--json` flags, and
`agentdock runs [run-id] [--workflow <name>]` lists server runs or shows one with
its steps and events.

## The CLI

`agentdock` below is the repository's CLI: run it as `bun run cli -- <command>`
from the repository root, or define an alias as described in the README.

The sync unit is a project folder mirroring the platform:

```
my-project/
  agentdock.project.json      ← project file: API base URL
  package.json                ← host packages as devDependencies so artifacts resolve them locally
  agents/<name>.agent.yaml    ← agent config, mirrors CreateAgentInput (integrations and tool grants included)
  workflows/<name>/           ← artifacts
  .agentdock/                 ← local state: ids and revisions of what was pulled or pushed
```

| Command | Effect |
| --- | --- |
| `agentdock login` / `logout` / `whoami` | Browser device flow; completes a platform session and stores it locally. |
| `agentdock init [--api <url>]` | Creates the project in the current directory, with a `package.json` declaring the host-provided packages so local runs resolve them at the platform's versions (`agentdock-patterns` as a `file:` link to the host's copy). |
| `agentdock pull [names…]` | Downloads agents and workflows (sources come back from the deployed artifact) and records their revisions. Everything when no names are given. |
| `agentdock status` | Compares local files against the recorded state. |
| `agentdock new <name> [--agent <name>…] [--tool <name>…] [--description <text>]` | Scaffolds an artifact folder under `workflows/`. |
| `agentdock check [folders…] [--json]` | Validates artifacts without uploading and reports contracts, topology, binding resolution and warnings. Every workflow in the project when no folder is given. |
| `agentdock run <folder> <input> [--agent …] [--tool …] [--model …] [--secret …] [--answer <json>…] [--verbose] [--json]` | Runs an artifact locally, see above. |
| `agentdock invoke <workflow> <input> [--answer <json>…] [--verbose] [--json]` | Runs a registered workflow over A2A and streams its events; answers interrupts like `run`. |
| `agentdock runs [run-id] [--workflow <name>] [--limit <n>] [--verbose] [--json]` | Lists recent server runs, or shows one run with its steps and events. |
| `agentdock push [names…] [--force] [--bind name=id…]` | Uploads agents and artifacts, selected by folder slug or manifest name. Rejected when the server revision moved since the last pull or push; `--force` skips the check. `--bind` disambiguates workflow bindings and binds manifest models (`name=provider:model`). An agent's `integrations` block provisions what the server lacks; anything it still cannot serve is listed under the agent, with an authorisation link for OAuth connections. |
| `agentdock agents` / `workflows` / `send` | List what is registered; send a message to an agent. |

Every push of an existing name records a new revision; `workflow_revisions` is
append-only, so every manifest the workflow ever ran under stays inspectable.
Runs already in flight keep the deployment they started on. That deployment
fixes the definitions of the bound agents and of every agent they may reach
through `send_task` (and those agents' targets in turn), so a delegation inside
the run uses the same definitions as the agents it binds.

An agent file declares its integrations completely, so a project pushes to a
fresh server without touching the integrations UI first:

```yaml
integrations:
  github:
    endpoint: https://api.githubcopilot.com/mcp/
    auth: { template: oauth }
    connection: { owner: org, name: default }
    tools:
      list_issues: native
      create_issue: codemode
  linear:
    endpoint: https://mcp.linear.app/mcp
    connection: { owner: user, name: default }
    tools:
      "*": codemode
```

`endpoint` is what the integration is discovered from. `connection` names the
organisation connection the agent's calls go through, or `user` for each
caller's own account. `auth` picks the integration's auth method when the
server has to open the connection itself; `secrets` maps its values to server
environment variable names, so a file never holds a credential. Tool names map
to `native` (in the model's tool set) or `codemode` (reachable from
`executeTs`), and `"*"` grants every tool of the connection.

## Execution

- `packages/sdk/src/workflows/load.ts` — reads and validates the folder, hashes it, imports the export.
- `packages/sdk/src/workflows/bindings.ts` — turns resolved bindings into the runnables under `context.agents` / `context.workflows` and the LangChain tools under `context.tools`.
- `packages/sdk/src/workflows/tool-invoker.ts` — the `WorkflowToolInvoker` service a bound tool calls; `packages/api/src/workflows/tool-invoker.ts` binds it to the integration gateway, the CLI binds it to the platform's `POST /tools/execute`.
- `packages/sdk/src/workflows/runtime.ts` — builds the context, injects the checkpointer, drives the graph, maps its stream onto durable events.
- `packages/sdk/src/workflows/step-paths.ts` — maps a LangGraph namespace onto the step and execution it belongs to.
- `packages/sdk/src/workflows/activity.ts` — the callbacks that report a bound agent's tool calls and every model call as step progress.
- `packages/sdk/src/workflows/executor.ts` — adapts that to the A2A `AgentExecutor` interface.
- `packages/api/src/workflows/deploy.ts` — server-side deployment and dependency install.
- `packages/api/src/workflows/langgraph-checkpointer.ts` — the durable checkpointer, backed by the database.

The runtime streams the graph with `streamMode: ['tasks', 'updates', 'custom', 'values']`
and `subgraphs: true`. `tasks` gives every node a start and an end without the
artifact reporting anything; `updates` carries interrupts and the last output;
`custom` surfaces `getWriter()` chunks as step progress; `values` supplies the
final output.

### Steps

A step is a node the graph view draws. A node of a compiled subgraph that was
added as a node is drawn inside a frame named after it, under the path
`<parent>:<node>` (`desk:research`), and runs as a step of that id; the
subgraph node itself (`desk`) is a step too, the frame. Whatever runs inside a
step that the graph does not draw — a bound agent's own graph, a child
workflow's nodes, a subgraph called from inside a node body — folds into that
step as progress. In the functional API every `task` is a step.

Each run of a step is an execution, and every step event carries its
`executionId` (the LangGraph task id). A loop that comes back to a node or a
`Send` fan-out to it gives one step several executions; the step row stays one
row, its status is that of its executions (failed, then waiting, then running,
then the latest), and the run snapshot reports how many there were as
`executions`. The run view badges such a node `×N`, and `N running` while
parallel executions are in flight; its details list the runs.

Activity is attributed to the step whose task made it: a bound agent, tool or
model reads the step from LangGraph's runnable config (`checkpoint_ns`, and the
callback metadata of a model call) rather than from the event stream, because
the stream lags execution.

### What a step reports

All of it arrives as `step-progress` on the calling step, with the state below
and the payload in `data`:

| State | When | `data` |
| --- | --- | --- |
| `a2a-send`, `a2a-status`, `a2a-message`, `a2a-task` | An external agent is called over A2A. | The A2A exchange. |
| `a2a-artifact` | A bound agent streams output. | `text` for assistant text, or `args` fragments with `toolCall` for a tool call's arguments, which is how an agent with an output contract streams its structured answer. |
| `agent-tool-call`, `agent-tool-result`, `agent-tool-error` | A bound internal agent's own loop calls one of its tools. | `agentId`, `toolName`, `toolCallId`, and `input`, `output` or `error`. |
| `agent-delegation` | A `send_task` subagent of a bound agent reports. | `agentId` and the relayed `send-task-progress` part as `event` (`taskId`, `agentName`, `state`, `text`, and its own loop event, nested again per delegation level). |
| `model-call` | A model call of a bound agent or a bound model ends. | `agentId` or `modelName`, `model`, `usage` (token counts, `null` when the provider reports none), `toolCalls`, `reasoningEstimated`. |
| `model-token` | A bound model streams text. | `modelName`, `text`. |
| `tool-call`, `tool-result`, `tool-error` | A bound integration tool is called. | `tool`, `name`, and `input`, `output` or `error`. |

A bound internal agent call is also recorded as its own agent run, linked to the
workflow run and the step that made it, with its tool calls in the run's
history. An eval whose target is a workflow reads its model calls (usage and
cost, subagents' included) and its tool calls from these events.

## Run state

Runs use these statuses: `submitted`, `working`, `input-required`, `completed`,
`failed`, `canceled`.

Steps use: `pending`, `running`, `waiting`, `completed`, `failed`, `canceled`.

A workflow's step set is only known once it runs, so step rows are created on
first sight.

## Events

`run-started`, `run-completed`, `run-failed`, `run-canceled`, `step-started`,
`step-progress`, `step-completed`, `step-failed`, `human-input-requested`,
`human-input-resolved`.

Every event is persisted before being mirrored onto the A2A event bus, so a
client reacting to the stream always finds the row already written.

## Human input

`interrupt()` inside the graph becomes an A2A `input-required` task plus a
pending action row. Answering it — a data part carrying
`{ type: 'workflow-human-input-response', actionId, response }` on the same
`taskId` — resumes the graph from its checkpoint with a LangGraph `Command`.

The interrupt payload is read for `title`, `description`, `input` and
`responseSchema`, which drive the prompt the UI renders; anything else in it is
passed through untouched.

## A2A invocation

Workflows have A2A card and task URLs just like agents, and the web chat target
list includes both. The card advertises the manifest's (or derived) `input`
schema as the task contract; tasks that do not satisfy it are rejected before a
run is created.

A task's first message can point the run's MCP integrations at other servers
through its metadata; the run's bound agents and bound tools then reach them
there, e.g. an eval case's own copy of a service. See
[A2A events](a2a-events.md#pointing-a-runs-integrations-elsewhere). A bound tool
whose server stays unreachable after its retries fails with
`WorkflowToolInvokeError`, so a node `retryPolicy` decides what happens next.

Cancellation is cooperative; external side effects already committed cannot be
rolled back. Put side effects in LangGraph tasks or nodes and use idempotency
keys at external services: checkpointing does not make an external side effect
and a database checkpoint one transaction.
