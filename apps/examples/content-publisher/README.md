# Content Studio — AI Content Publisher

An example product built **on top of** AgentDock (not a dashboard for it). A
writer gives a brief, an agent drafts a post, a human edits & approves it in a
rich editor, and a workflow publishes the approved version through a mock
publishing platform exposed as an MCP server.

It exists to show external developers the integration boundary they'd actually
work against:

- **Human-in-the-loop** — the workflow pauses on an `interrupt()` in its
  `review` step; the app surfaces the draft for editing and resumes the run
  with the human's decision. Feedback without approval sends the draft back to
  the writer.
- **Streaming** — the agent's draft streams in token-by-token over A2A.
- **A thin backend that owns AgentDock** — auth + a server-side A2A proxy, so
  the browser never needs a (CORS-exposed) line to AgentDock.
- **Observability** — a "Developer" drawer shows the raw workflow event stream
  the whole UI is built from, so you can see what else you could build.

```
 browser ──/api──▶ Hono backend ──A2A (SSE)──▶ AgentDock workflow
 (Vite)            (auth + proxy)               │
                                                │  apps/examples/workflows/content-publisher
                                                ├─ draft   → content-writer agent
                                                ├─ review  → interrupt()  (pauses ⏸)
                                                └─ publish → publish_post MCP tool ──▶ mock platform
```

## Architecture

| Piece | Path | Port | Role |
| --- | --- | --- | --- |
| Frontend | `src/` (Vite + React) | 5273 | UI; only ever talks to `/api`. |
| Backend | `server/` (Hono) | 8787 | Auth, and the only client of AgentDock's A2A endpoint. |
| Mock platform | `mcp/` (FastMCP) | 8910 | `publish_post` / `list_channels` tools over MCP. |
| AgentDock | (this repo) | 38123 (`bun run urls`) | Hosts the agents + workflow. |

## Setup

### 1. Install

This example is not part of the monorepo's workspaces and pins its own concrete
dependency versions. Its one link back into the repo is `server/config.ts`, which
imports `packages/sdk/src/config` and `packages/sdk/src/ports` to derive the
default AgentDock URL from the checkout it sits in; if you copy the folder out,
replace those imports and set a fixed `AGENTDOCK_URL`. Install from inside it
(the scripts need Node 22.9+ for `--env-file-if-exists`):

```bash
cd apps/examples/content-publisher
bun install   # or npm install / pnpm install
```

### 2. Start the mock publishing platform (MCP server)

```bash
cd apps/examples/content-publisher
cp .env.example .env
bun run mcp        # serves http://localhost:8910/mcp
```

### 3. Deploy the workflow to AgentDock

Start AgentDock from the repo root with `bun run dev` (or `bun run dev:no-auth`,
see step 5) and set `OPENAI_API_KEY` in the root `.env` for the seeded agent.

1. **Seed the agent.** From the repo root run `bun run db:seed`. The seed creates
   the `content-writer` agent with a structured output contract
   (`{ title, body, channel }`).
2. **Add the MCP source.** In the dashboard, add an MCP integration by URL,
   `http://localhost:8910/mcp`, with the slug `mock-publishing-platform` (or
   `POST /integrations/discover` with `{ "url", "slug" }`). It exposes
   `list_channels`, `publish_post` and `list_published`; the workflow binds
   `publish_post` by name.
3. **Allow `publish_post`.** New integration tools require approval by default,
   which adds a second pause after the editorial review: AgentDock holds the
   `publish_post` call and the app shows an **Approve call / Decline** step for
   it (see [the two gates](#how-the-human-in-the-loop-contract-works)). The
   editor already approves each post, so for this demo set `publish_post` to
   **Allow** on the integration (or `PUT /tools/<tool id>/decision` with
   `{ "decision": "allow" }`).
4. **Push the workflow.** The workflow is a LangGraph artifact in
   [`apps/examples/workflows/content-publisher`](../workflows/content-publisher).
   Put that folder under `workflows/` of an agentdock project (`agentdock init`)
   and push it:

   ```bash
   agentdock push content-publisher
   ```

   Registration binds `content-writer` to the seeded agent and `publish_post`
   to the MCP tool of that name. The graph is:

   | Step | What it does |
   | --- | --- |
   | `draft` | asks `context.agents['content-writer']` for `{ title, body, channel }`; on a revision it gets the previous draft and the feedback |
   | `review` | `interrupt()` titled `Review & approve post`, with the article as `input`; the app resumes with the edited article plus `approved` |
   | `publish` | calls `context.tools.publish_post` with the approved article and returns the URL |
   | `reject` | ends the run without publishing |

   Input contract: a data part `{ "brief": "…" }`. Response schema of the
   `review` gate (this is what the editor fills in):

   ```json
   {
     "type": "object",
     "properties": {
       "approved": { "type": "boolean" },
       "title":    { "type": "string" },
       "body":     { "type": "string" },
       "channel":  { "type": "string", "enum": ["blog", "twitter", "linkedin", "newsletter"] },
       "feedback": { "type": "string" }
     },
     "required": ["approved"]
   }
   ```

   `approved: true` publishes the (edited) article. `approved: false` with
   `feedback` sends it back to the writer for another round (at most three);
   without feedback it ends the run as rejected.

5. Point the app at the workflow. Either set `WORKFLOW_ID` in `.env`, **or** just
   run the app and use the in-app **⚙ settings panel** (top-right) — it lists the
   workflows from your AgentDock so you can pick one without copying ids. The
   AgentDock URL is configurable there too; both are seeded from env and applied
   at runtime. The workflow's A2A endpoint is public, but listing workflows is an
   admin call, so the picker only fills in when AgentDock runs with
   `bun run dev:no-auth`; with auth on, paste the id.

### 4. Run the app

```bash
bun run dev        # starts the Hono backend + Vite (the app itself)
```

The mock MCP server from step 2 keeps running separately — it's a backing
service wired into AgentDock, not part of the app, so `dev` doesn't start it.

Open http://localhost:5273 and sign in with a demo user
(`editor@example.com` / `demo123`).

## How the human-in-the-loop contract works

This is the part worth copying. AgentDock speaks A2A, and a run can pause at
two gates. Both are an `input-required` pause answered by a message on the same
task (see `server/a2a.ts` + `server/relay.ts`):

| Gate | Raised by | Decides | Answer |
| --- | --- | --- | --- |
| Editorial review | the workflow's `review` step calling `interrupt()` | the content: approve (with edits), revise, reject | `{ approved, title?, body?, channel?, feedback? }` |
| Tool approval | AgentDock's gateway, when `publish_post` is set to require approval | whether the `publish_post` call runs | `{ action: "accept" }` or `{ action: "decline" }` |

The editorial gate:

1. **Start** — send a task with a data part `{ brief }`. The run streams back
   `working`, the draft token by token as `step-progress` events with
   `state: 'a2a-artifact'`, the finished article as the `draft` step's output,
   then pauses with `state: 'input-required'` carrying
   `{ type: 'workflow-human-input-request', actionId, title, input, responseSchema }`.
2. **Resume** — send a second message on the **same `taskId`/`contextId`** with
   a data part:

   ```json
   {
     "type": "workflow-human-input-response",
     "actionId": "<from step 1>",
     "response": { "approved": true, "title": "…", "body": "…", "channel": "blog" }
   }
   ```

   The workflow resumes from its checkpoint; `response` is what `interrupt()`
   returns inside the `review` step, which merges the edits into the article
   before `publish` hands it to the `publish_post` tool.

The tool approval, only when `publish_post` requires one:

3. **Held call** — `publish` calls `publish_post`, the gateway holds the call
   and the run pauses again. The request looks like the editorial one, but its
   `interrupts[0].value` is `{ type: 'workflow-tool-approval-request', tool: { path, args } }`
   and its `actionId` is the gateway approval's id. The app shows it as its own
   step (`awaiting-approval`) instead of the review editor.
4. **Decide** — answer on the same task with
   `{ "type": "workflow-human-input-response", "actionId": "<from step 3>", "response": { "action": "accept" } }`.
   AgentDock decides the approval with it: `accept` runs the held call, the
   resumed `publish` step calls the tool again and gets that call's receipt
   back instead of publishing twice. `decline` fails the step. Any other
   response counts as `accept`, so a decline has to say `decline`.

An admin can also decide the call in AgentDock's approvals queue. That runs (or
declines) it, but the run stays paused until its pending action is answered,
from this app or the workflow run view in the dashboard.

Everything the UI shows — status, the live draft, the gate, the published URL —
is derived from the run's event stream. Open the **Developer** drawer to watch
it live.

## Notes & limitations

- State is **in-memory** on both the backend and the mock MCP server; restarts
  reset everything. AgentDock remains the source of truth for runs.
- Auth is a hardcoded demo (`server/auth.ts`). Swap the user list + session
  store for real ones; the `requireAuth` shape stays the same.
- The markdown renderer (`src/lib/markdown.ts`) is intentionally tiny. For
  richer rendering, swap in `streamdown` (already in the repo catalog).
- For fully typed run events on the backend, import `WorkflowRunEvent` from
  `agentdock-sdk/schemas` instead of the local `WorkflowEvent` alias.
