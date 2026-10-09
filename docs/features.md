# Features

## Agent Registry

Agents are persisted records with an id, visibility, name, description, color, model, reasoning effort, instructions, integrations with their tool grants, skills, communication policy, version, capabilities, default input/output modes, and optional input and output contracts. An agent with an output contract answers with structured JSON instead of text. Agents run on LangChain/LangGraph.

Core operations:

- List agents.
- Create agents.
- Update agents.
- Remove agents.
- Read internal agent details.
- Expose every agent as an A2A target and an AG-UI endpoint.

External A2A agents can be registered by URL and are then reachable like local ones.

## Communication Policy

Agents can be configured to allow communication with all agents or only selected agent ids. The communication graph UI presents and edits these relationships.

## Skills

Skills store reusable instructions or capability documents. They include name, description, content, license, compatibility, allowed tools, source metadata, and timestamps. Built-in skills ship with the server, cannot be replaced or removed, and are published at `/.well-known/agent-skills/` for `npx skills add <agentdock url>`.

An agent's config maps each assigned skill to a mode: `inject` puts the skill into the system prompt of every session, `on-demand` lists it by description and the agent loads it with `load_skill` when a task matches.

Core operations:

- List skills.
- Create skills.
- Pull skills from a source.
- Delete skills.

## MCP Access

Every operation above is also an MCP tool. Coding agents such as Claude Code, Codex and OpenCode connect to `<api url>/mcp` and sign in through the server's OAuth flow as an admin; no API key is involved. The built-in assistant reaches the same server at `/mcp/internal` with a token the server issues at startup. The dashboard's setup page shows the per-harness commands and lists the connected clients.

## Provider Keys And Models

Provider key APIs manage configured model providers without exposing secret material in list responses, and can check that a `provider:model` id answers before it is used. Custom OpenAI-compatible and Azure OpenAI endpoints can be added beside the built-in providers. The model catalog powers UI model selection and agent configuration.

## Chat And Sessions

The web UI can chat with both agents and workflows through A2A URLs. Agents take every part of a message: text, files (images, audio, documents) and data, over A2A and AG-UI alike. Sessions track target identity, title, active branch, summary, usage, metadata, and timestamps. Branches support edit/regenerate/fork style histories.

## Evals

Evals measure agents and workflows on datasets of tasks. The design follows Anthropic's "Demystifying evals for
AI agents" and "A statistical approach to model evaluations".

- **Datasets** hold cases: an input, an optional reference answer, tags (for suites such as `regression` and
  `capability`) and free-form JSON metadata. Datasets import from CSV/TSV, JSON or JSONL with a column mapping,
  export to JSONL, and grow from chat sessions (Evals → Sessions → Add to dataset).
- **Graders** are stored as JSON config and shared across datasets. Code checks: exact match, contains, regex,
  valid JSON (optionally against a JSON Schema), JSON match with per-field partial credit, numeric tolerance,
  Levenshtein similarity, tool calls (required, forbidden, order, call budget) and latency. LLM judges take a rubric
  template (`{{input}}`, `{{output}}`, `{{expected}}`, `{{transcript}}`, `{{metadata.key}}`), a judge model, and
  either labelled verdicts with scores or a numeric scale. The judge answers through structured output with its
  reasoning before its verdict and may answer `UNKNOWN` instead of guessing. Presets cover common cases, including
  autoevals' factuality classifier. Any grader can be tried on a hand-written sample before it is saved.
- **Runs** send every selected case to the target once per trial, each in a fresh context, and grade every
  answer. Agents run in-process (their runs are recorded with the `eval` origin, outside chat sessions), and
  workflows run over A2A. Before a run starts, every model it will call (the agent's and each judge's) must have
  a provider key. Runs report the pass rate with its standard error and 95% interval, clustered by case; pass@k
  and pass^k; per-grader pass rates, mean scores, unscored grades and judge cost; and errored trials apart from
  failures. A run can be canceled, re-graded with other graders without calling the target again, and compared
  with another run of the same dataset through a paired difference.
- **Baselines**: every run is compared with the previous finished run of the same dataset and target (a re-grade
  with its source run) through the paired difference over shared cases. The verdict is `regressed` or `improved`
  only when the 95% interval excludes zero; case regressions, cost and latency per trial are reported either way.
- **Spend**: the agent loop reports every model call's usage, and a trial prices each call from the model catalog
  when it is recorded: uncached input, cache reads, cache writes and output, with the thinking share of output
  broken out (estimated where the provider bills thinking inside output without counting it). Spend is split by
  loop phase (tool-use steps, the final answer, subagents reached through `send_task`) and by model, per trial and
  per run, beside what the LLM judges cost. Errored trials keep what they spent; re-grades spend nothing on the
  target. A workflow trial reads the same from its run's step events: every model call of its bound agents,
  bound models and their subagents, and every tool call its agents and bound tools made, so tool-call graders
  apply to workflows too.
- **Gates** rerun a dataset (optionally narrowed by tags and a limit) against an agent whenever the agent's
  instructions, model, reasoning effort or skills change, including changes made while the server was down. A
  burst of edits settles for a few seconds into one run, a new run cancels the gate's run still in progress, and a
  gate that cannot start (e.g. a missing API key) records why.
- **Human review** marks a trial pass or fail with a note. Each grader's agreement with those reviews shows how
  far its verdicts can be trusted.

## Workflows

A workflow is a folder of LangGraph code: a manifest (`agentdock.workflow.json`)
and a `workflow.ts` that exports a compiled graph. The CLI pushes the folder
(`POST /workflows`), the server installs it as a new revision, and every
workflow is exposed as an A2A target. The manifest names the agents, workflows,
integration tools and platform models the code calls; registration binds each
to a concrete target. Runs store run state, per-step state and an event
history: nodes of embedded subgraphs are steps of their own, a step that runs
again in a loop or fan-out records each execution, and the activity of bound
agents, tools and models (tool calls, model calls with usage) is reported on
the step that made it. `interrupt()` pauses a run for human input. See
[Workflows](workflows.md).

Multi-agent structures (router, pipeline, parallel, voting, map-reduce,
orchestrator-workers, evaluator-optimizer) come from `agentdock-patterns`, which
the host provides to every workflow. See [Multi-agent patterns](patterns.md).

## Triggers

Triggers start a task on an agent or workflow from a cron schedule, an inbound
webhook (`POST /triggers/:triggerId/webhook` with a shared secret), or new
email in a polled mailbox. Each firing is recorded with its task id and error.

## Channels

Channel accounts connect Discord and Teams bots. Bindings route an account's
messages to an agent or workflow, optionally only on mention or from listed
users; each platform conversation maps to one A2A context, and a task waiting
for input is answered from the same conversation.

## Integrations

Integrations expose external tools to agents and workflows. They are served by
the embedded integrations gateway (`@integragents/gateway-core`, see
`packages/api/src/gateway`). AgentDock supports:

- MCP and OpenAPI integrations, discovered from a URL or found through registry search.
- OAuth start and completion flows, including user-owned connections.
- Static credential and OAuth credential management.
- Per-agent tool grants declared in the agent config: integration endpoint, connection, and tool modes (`native` or `codemode`). Codemode tools are reached from TypeScript the agent passes to the `executeTs` tool, which runs in a QuickJS sandbox (`packages/api/src/gateway/codemode.ts`).
- Per-tool decisions (run immediately or require approval), an approval queue, and an audit log of every call.
- Tool results with images, audio, video, files and resources (MCP content blocks) reach the model in its provider's format: inside the tool result for OpenAI's Responses API and Anthropic, as a user message right after it for Chat Completions, Mistral and Gemini. The chat shows them as media.
- Unreachable MCP servers are retried, then fail the run instead of answering the model with an error.
- A run can point MCP integrations at other servers through its first message's metadata, e.g. an eval case's own server. See [A2A events](a2a-events.md#pointing-a-runs-integrations-elsewhere).

## Observability And Traces

The server can export OpenTelemetry data through standard `OTEL_*` environment variables and also writes spans to `logs/api.trace.ndjson`. Model and tool calls are traced from LangChain/LangGraph callbacks as `agentdock.langgraph.*` spans. Trace APIs read from Tempo (`TEMPO_URL`); the trace UI lists agent and workflow traces and shows their detail.

## Web UI

The UI provides views for:

- Setup and sign-in.
- Agent list, creation and editing.
- Agent communication graph.
- Chat with agents and workflows.
- Workflow registry (folder upload and graph view) and run history.
- Triggers and channels.
- Integrations, per-agent tools, the caller's own connections, and approvals.
- Provider keys and model choices.
- Skills.
- Evals: runs, datasets, graders, gates and sessions.
- Traces.

## CLI

The CLI (`apps/cli`) runs as `bun run cli -- <command>` from the repository root.

| Command | Purpose |
| --- | --- |
| `login`, `logout`, `whoami` | Sign in through the browser device flow, sign out, show the user. |
| `init` | Create a project in the current directory. |
| `pull`, `push`, `status` | Sync agents and workflows between the project and the server. |
| `new`, `check`, `run` | Scaffold, validate, and run a workflow folder locally. |
| `invoke`, `runs` | Run a registered workflow over A2A; list or inspect server runs. |
| `agents`, `workflows` | List what is registered. |
| `send` | Send a message to an agent over A2A and stream the reply. |

See [Workflows](workflows.md#the-cli) for flags and the project layout.
