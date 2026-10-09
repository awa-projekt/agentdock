# Content publisher

The workflow behind the [`content-publisher`](../../content-publisher) example
app: a `StateGraph` with a human-in-the-loop gate and an integration tool.

```
START ─▶ draft ─▶ review ─┬─ approve ─▶ publish ─▶ END
           ▲              ├─ revise ───┘ (back to draft, at most 3 rounds)
           └──────────────┴─ reject ──▶ reject ─▶ END
```

- `draft` asks the bound `content-writer` agent (`context.agents['content-writer']`)
  for `{ title, body, channel }`. The agent declares that as its output contract,
  so the answer arrives as `structuredResponse`. On a revision the previous draft
  and the reviewer's feedback ride along.
- `review` calls `interrupt()` with the article as `input` and the reviewer's
  response schema. The run pauses as an A2A `input-required` task; the app edits
  the draft and answers on the same task. `approved: true` publishes the edited
  article, feedback without approval goes back to `draft`, a bare rejection ends
  the run.
- `publish` calls the bound `publish_post` integration tool
  (`context.tools.publish_post`, a LangChain tool) and keeps the returned URL.
  If AgentDock holds the call for approval, `invoke` pauses the run on that
  approval and, once it is accepted, returns the held call's receipt.

Input is `{ brief }`, output `{ status, url?, article }`; both derive from the
Zod schemas. The agent and tool names are bound at push time: `content-writer`
is the seeded agent of that name and `publish_post` is the tool the mock
publishing platform exposes once it is added as an MCP integration. New
integration tools require approval by default, so `publish` pauses a second
time, after the review, until the call is answered with `{ "action": "accept" }`
or `{ "action": "decline" }` (declining fails the step). The reviewer already
approved the post, so set `publish_post` to **Allow** unless you want that
second gate.

## Run locally

```sh
bun install --omit=peer
agentdock check workflows/content-publisher
agentdock pull content-writer   # writes agents/content-writer.agent.yaml
agentdock run workflows/content-publisher '{"brief":"Announce our new dark mode"}' \
  --answer '{"approved":true}'
```

A local run executes the writer in-process, so the model's provider key
(`OPENAI_API_KEY` for the seeded agent) has to be set in your shell. Bound tools
always execute on the platform the project points at, so a local run needs the
MCP integration registered there; `--tool publish_post=<tool id>` picks one when
several integrations expose a `publish_post`. A local run cannot wait for a tool
approval: with `publish_post` still requiring one it fails with
`did not run: pending`.

## Push

```sh
agentdock push content-publisher
```
