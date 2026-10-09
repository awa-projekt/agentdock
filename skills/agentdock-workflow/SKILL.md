---
name: agentdock-workflow
description: Rules for writing or changing a LangGraph workflow artifact so it can be pushed to agentdock. Use when creating a workflow folder, editing agentdock.workflow.json, a workflow.ts graph export, or when a push/check fails on registration. Covers manifest, graph export, injected context, dependencies and the CLI loop.
---

# agentdock-workflow

A workflow is ordinary LangGraph code in a folder. It imports nothing from
agentdock; the host injects everything through LangGraph's own `context` and
`configurable`. The full reference is `docs/workflows.md`; the working examples
are `apps/examples/workflows/{ticket-triage,market-brief,content-publisher}`.
Read the closest example before writing a new one.

## When to use

- Creating a new workflow folder or scaffolding one with `agentdock new`.
- Changing an existing manifest, graph export or dependency set.
- Diagnosing a rejected `agentdock check` or `agentdock push`.

## Artifact layout

```
my-workflow/
  agentdock.workflow.json   manifest
  package.json              own dependencies, host packages as peers
  bun.lock                  required; push is rejected without it
  workflow.ts               exports a compiled LangGraph (default export)
  lib/…                     anything else, imported normally
```

## Manifest rules

```json
{
  "$schema": "http://localhost:38123/schemas/workflow-manifest.json",
  "name": "Ticket triage",
  "description": "Classifies a ticket, escalates or drafts a reply.",
  "version": "0.2.0",
  "graph": "./workflow.ts:default",
  "agents": { "writer": { "description": "Writes the customer-facing reply." } },
  "tools": { "publish_post": { "description": "Publishes an approved post." } },
  "secrets": ["SLACK_TOKEN"]
}
```

- `name`, `description`, `version` are required. `name` identifies the workflow across pushes and is what other workflows bind to. Bump `version` on every change.
- `graph` is `<module>:<export>` relative to the folder; defaults to `./workflow.ts:default`.
- `input` / `output` are JSON Schemas. Omit them when the graph declares Zod `input`/`output` schemas; the registry derives them. Graphs built from plain `Annotation`s or the functional API declare nothing, so state them here or the task contract is open.
- `agents`, `workflows`, `tools` are maps of local name to `{ description? }`. The local name is what the code reads under `context.agents.<name>` etc. Never put a database id in the manifest; binding to a registered target happens at push. Ambiguous names are disambiguated with `agentdock push --bind name=id`.
- `secrets` lists names read from `context.secrets`; each must exist as an environment variable on the host.
- Control flow, retries, fan-out and human gates live in code only. Do not mirror them in the manifest.

## Graph export rules

The export is what `StateGraph#compile()` or `entrypoint()` returns, or a function `(runtime) => compiled`.

- **No checkpointer at compile time.** The host injects its durable checkpointer through `configurable.__pregel_checkpointer`. An export with `checkpointer` set fails registration.
- **No agentdock import.** Only LangGraph, LangChain and the artifact's own packages.
- Give `addConditionalEdges` a path map, otherwise the drawn topology claims every branch can reach every node.
- Human input is LangGraph `interrupt()`. Put `title`, `description`, `input` and `responseSchema` in the payload; they drive the UI prompt. Resume arrives as a `Command`.
- Side effects go in nodes or LangGraph tasks with idempotency keys at the external service. Checkpointing does not make an external call transactional.

## Injected context

Read as `config.context` in a node, `getConfig().context` in the functional API.

| Member | Type |
| --- | --- |
| `context.agents.<name>` | `Runnable<{ messages: BaseMessageLike[] }, { messages: BaseMessage[]; structuredResponse? }>` |
| `context.workflows.<name>` | `Runnable<Json, Json>` |
| `context.tools.<name>` | `StructuredToolInterface` from `@langchain/core/tools` |
| `context.secrets.<name>` | `string` |
| `context.run` | `{ workflowId, runId, taskId, contextId }` |

Type it locally; the docs are the contract, not an import. For a `StateGraph`
declare a `context` schema so it is typed and validated:

```ts
type Agent = Runnable<{ messages: BaseMessageLike[] }, { messages: BaseMessage[]; structuredResponse?: unknown }>;
const Context = z.object({
  agents: z.object({ writer: z.custom<Agent>() }),
  tools: z.object({ publish_post: z.custom<StructuredToolInterface>() }),
});
new StateGraph({ input: Input, output: Output, state: State, context: Context });
```

For the functional API read the members into a local type:

```ts
type Ctx = { agents: { writer: Agent } };
const agents = (): Ctx['agents'] => getConfig().context?.agents;
```

Do not annotate node parameters as `LangGraphRunnableConfig<Ctx>` unless the graph declares a matching `context` schema; it does not compile under strict function types.

## Dependency rules

- `@langchain/langgraph`, `@langchain/core` and `langchain` are host-provided. Declare them in `peerDependencies`, never `dependencies`. A second copy breaks `instanceof` in the runtime and registration rejects it. `@langchain/langgraph` must be declared so the host can semver-check it.
- Everything else the code imports goes in `dependencies` (for example `zod`).
- Run `bun install --omit=peer` in the folder to produce `bun.lock`; peers resolve from the surrounding project.
- Any file change including `bun.lock` changes the source hash and is a new deployment.

## Local run

```ts
graph.invoke(input, {
  configurable: { thread_id: 'local', __pregel_checkpointer: new MemorySaver() },
  context: { agents: { writer }, tools: { publish_post } },
});
```

Any runnable over `{ messages }` satisfies an agent binding; any LangChain `tool()` satisfies a tool binding. Add `__pregel_checkpointer` when the graph uses `interrupt()`.

## Workflow

1. `agentdock new <name> [--agent <name>…] [--tool <name>…]` scaffolds the folder under `workflows/` with peers at the platform's versions.
2. Write the graph. Declare Zod `input`/`output`/`context` schemas.
3. `bun install --omit=peer` in the folder.
4. `agentdock check <folder>` and fix every reported problem: derived schemas, topology, binding resolution, warnings for missing lockfile, unbound agents, unset secrets, no input contract.
5. `agentdock run <folder> <input> [--agent name=<file|url>] [--tool name=<id>] [--secret NAME=value] [--answer <json>…]` runs it the way the platform does. `input` is text, a JSON object or `@path`.
6. `agentdock push <name>` uploads. Use `--bind name=id` for ambiguous bindings, `--force` only when the remote revision moved intentionally.
7. `agentdock invoke <name> <input>` and `agentdock runs [run-id]` verify the registered workflow.

Pushed code runs inside the server process with its privileges. Treat a push as a deployment.
