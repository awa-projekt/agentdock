---
name: agentdock
description: How to inspect, build and operate an Agentdock instance through its MCP tools - agents, skills, integrations and tool grants, workflows, approvals, sessions, evals and traces. Use whenever a task involves creating or changing anything in Agentdock or finding out why an agent or workflow behaved the way it did.
---

# Operating Agentdock

Agentdock hosts AI agents and workflows. Every agent is an A2A endpoint, gets
its tools from integrations the server connects, and can carry skills. The
Agentdock MCP tools are the control plane for all of it. They act with admin
rights on a live instance, so read before you write and ask before you delete.

## Ground rules

- Look before you change: `list_agents`, `list_skills`, `list_integrations`
  and `list_workflows` show the current state. Never guess ids or slugs.
- `add_agent` and `update_agent` take the complete agent. To change one field,
  read the agent first and send it back whole with that field changed.
  Pass the agent's `revision` as `expectedRevision` so a concurrent edit is
  refused instead of overwritten.
- Removing an agent, workflow, skill or integration cannot be undone. Name
  what will be removed and get a yes first.
- Credentials never go into agent configs or chat. A person connects OAuth
  integrations in the dashboard; `start_integration_oauth` returns the URL
  they must open.

## Agents

An agent is:

- `name`, `description`, `instructions`, `version` (e.g. `0.1.0`), and an
  optional `color` (`#rrggbb`).
- `model` as `provider:model`, e.g. `openai:gpt-5.6-luna` or
  `anthropic:claude-sonnet-5`, and an optional `reasoningEffort`.
- `integrations`: the tools it gets (see below).
- `skills`: a map from skill id to `inject` or `on-demand` (see below).
- `communication`: `{ allowAll, allowedAgentIds }`, the agents it may delegate
  to with `send_task`. Keep it narrow; delegation targets must exist.
- `capabilities` (`{ pushNotifications: false, streaming: true }`),
  `defaultInputModes` and `defaultOutputModes` (`["text/plain"]`), and
  optional `inputContract`/`outputContract` holding a JSON Schema string
  when callers need structured input or a guaranteed output shape.

Write instructions as the agent's job description: what it is for, what it
must never do, and when to hand off. Tool usage belongs in tool descriptions
and skills, not in instructions.

`get_agent_internals` shows the final system prompt an agent runs with
(instructions plus injected skills plus the on-demand skill list), its active
tools and the model's limits. Use it to verify a change landed as intended.

## Tools: integrations and grants

An integration is one URL (MCP endpoint, OpenAPI document or Google Discovery
document). The flow is:

1. `discover_integration` registers it and reports the auth methods it offers.
2. Connect it: `connect_integration` for a static credential or no auth,
   `start_integration_oauth` when it uses OAuth (a person finishes in the
   browser).
3. Grant tools in the agent's `integrations` block:

```json
{
  "github": {
    "endpoint": "https://api.githubcopilot.com/mcp/",
    "connection": { "owner": "org", "name": "default" },
    "tools": { "*": "codemode", "create_issue": "native" }
  }
}
```

- `connection.owner` is `org` (one shared connection) or `user` (every person
  connects their own account).
- `tools` maps tool names, or `*` for all, to `native` (the model calls it
  directly) or `codemode` (reachable only from the agent's `executeTs`
  TypeScript sandbox, which suits many tools or multi-step data work).
- Omit tools an agent does not need. `list_agent_tools` shows each tool's
  resulting mode and any declaration the server cannot resolve.
- An optional `auth: { template, secrets }` lets the server connect on its own,
  where `secrets` maps credential fields to server environment variable names.

Calls that need a human's approval freeze; `list_pending_approvals` shows them.

## Skills

A skill is a SKILL.md document: YAML frontmatter with `name` (lowercase,
hyphenated) and `description`, then the instructions. `add_skill` stores one
from content, `pull_skills` imports from a repository or package.

Assign skills through the agent's `skills` map:

- `inject`: the full skill is in the system prompt of every session. Use it
  for what a specialized agent needs on every turn.
- `on-demand`: only the description is listed; the agent loads the skill with
  `load_skill` when a task matches. Use it for occasional procedures, so the
  prompt stays small.

Built-in skills, like this one, ship with the server and cannot be changed.

## Workflows

Workflows are LangGraph code in a folder with an `agentdock.workflow.json`
manifest. `register_workflow` deploys a folder on the server's machine as an
immutable revision; registering the same manifest name again adds a revision.
Follow the `agentdock-workflow` skill, when available, to write one.

## Debugging

- `list_sessions` and `delete_session` cover an agent's chat sessions.
- `list_traces` and `get_trace` show what an agent or workflow actually did:
  model calls, tool calls, errors and timing. Start here when behaviour is
  surprising, then fix the cause in instructions, skills or tool grants.
- `list_eval_sessions` and `get_eval_session` show saved chat sessions to turn
  into eval cases.

## Evals

Measure a change instead of eyeballing it. Build a dataset with
`create_eval_dataset`/`add_eval_cases` from real failures (20 to 50 cases is a
good start), including cases where a behaviour should not happen. Grade with
code checks where possible and an `llm-judge` per dimension where not
(`create_eval_grader`). `start_eval_run` calls the agent and every judge once
per case and trial, which costs tokens: run a few cases with `limit` first.
Then read the trials in `get_eval_run`, not just the pass rate, and treat
differences inside the reported error bars as noise. Each run is compared with
the previous run of the same dataset and agent (`baseline`), and reports what
the agent spent per trial, split by tool-use steps, the answer and subagents.
To catch regressions as you iterate, `create_eval_gate` reruns a suite
whenever the agent's instructions, model, reasoning effort or skills change.
