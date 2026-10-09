# Example client applications

This directory holds **standalone example apps that consume AgentDock** — not
dashboards for managing it (that's `apps/web`), but the kind of product you'd
ship to end users on top of the agents and workflows you build in AgentDock.

Each example talks to AgentDock purely over its public **A2A** surface
(`POST /workflows/:id/a2a`, `POST /agents/:id/a2a`) through a thin backend of
its own, so it demonstrates the integration boundary an external team would
actually work against: auth, CORS, streaming, and human-in-the-loop.

| Example | What it shows |
| --- | --- |
| [`content-publisher`](./content-publisher) | Human-in-the-loop editorial review. An agent drafts a post from a brief, a human edits & approves it in a rich editor, then a workflow publishes it via a mock MCP tool. Includes a developer drawer that surfaces the raw workflow event stream. |

The [`workflows`](./workflows) folder holds workflow artifacts (`ticket-triage`,
`market-brief`, `content-publisher`, and `support-desk`, a router with a review
loop from `agentdock-patterns`) that are pushed to AgentDock rather than run
beside it. Their READMEs use the `agentdock` CLI; see the CLI section of the
root README for how to run it, and `docs/workflows.md` for the format.

Each example app is **self-contained**: it is *not* a monorepo workspace member and
pins its own concrete dependency versions, so a developer can copy the folder
out of this repo and run it as-is. Install and run from inside the example's
own directory, not from the repo root.

## Adding a new example

1. Create `apps/examples/<name>` with its own standalone `package.json` (concrete
   versions — no `catalog:` or `workspace:*`). Don't add it to the root
   `workspaces`; keep it independent.
2. Keep the backend thin — its job is auth + proxying A2A so the browser never
   needs a direct (CORS-exposed) line to AgentDock.
3. Add a row to the table above.
