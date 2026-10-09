# Ticket triage

A `StateGraph` workflow artifact. `classify` runs a LangGraph agent with a
`lookup_customer` tool and a structured `Triage` result; high priority goes to
`escalate` (plain code), everything else to `draftReply`, which calls the
`writer` agent the host injects as `context.agents.writer`.

The folder imports nothing from agentdock. `agentdock.workflow.json` names the
agent the code expects; the platform binds that name to a registered agent when
you push.

## Run locally

Any runnable over `{ messages }` works as the writer. A `createAgent` from
`langchain` is the shortest path:

```ts
import { createAgent } from 'langchain';
import graph from './workflow.ts';

const writer = createAgent({
  model: 'openai:gpt-5.6-luna',
  systemPrompt: 'You write short, friendly support replies.',
});

const result = await graph.invoke(
  { email: 'ada@acme.com', text: 'Invoices export as blank PDFs since Monday.' },
  { context: { agents: { writer } } },
);
console.log(result.reply);
```

`OPENAI_API_KEY` must be set for the `classify` agent and the writer above.

Or let the CLI run the artifact the way the platform does, with a checkpointer
and event timeline. The `writer` name resolves to `agents/writer.agent.yaml` in
your project, or bind it explicitly:

```sh
agentdock run ./ticket-triage '{"email":"ada@acme.com","text":"..."}' --agent writer=./writer.agent.yaml
```

## Push to the platform

Inside an agentdock project (`agentdock init`), with this folder at
`workflows/ticket-triage/`:

```sh
bun install --omit=peer     # produces bun.lock; peers resolve from the surrounding project
agentdock check workflows/ticket-triage
agentdock push ticket-triage   # binds `writer` to the registered agent of that name
```

If more than one registered agent is called `writer`, bind explicitly:
`agentdock push ticket-triage --bind writer=<agent id>`.
