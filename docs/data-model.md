# Data Model

AgentDock stores local state in SQLite (libSQL) with Drizzle schemas from
`packages/db/src/schema.ts`. The database file defaults to `agentdock.db` and is
set with `DB_FILE_NAME`.

## Agents And Skills

| Table | Stores |
| --- | --- |
| `agents` | Agent definitions: name, description, color, model, reasoning effort, instructions, integrations with their tool grants, skills with their modes, communication config, capabilities, input/output modes, optional input and output contracts, and a revision that rejects stale pushes. |
| `external_a2a_agents` | External A2A agents registered by endpoint URL, with their card metadata. |
| `agent_communication_rules` | Explicit source-agent to target-agent permissions. |
| `skills` | Skill metadata and content. |
| `agent_runs` | Every agent run regardless of origin (`a2a`, `ag-ui`, `sdk`, `eval`, `delegation`, `workflow`): status, status history, messages, artifacts, and the workflow run and step or parent task it belongs to. |

## Providers

| Table | Stores |
| --- | --- |
| `provider_keys` | API keys for built-in model providers. |
| `custom_providers` | OpenAI-compatible or Azure OpenAI endpoints with their base URL, key and query parameters. |

## Sessions And A2A Context

| Table | Stores |
| --- | --- |
| `sessions` | Chat session metadata, target, active branch, summary, usage, lifecycle timestamps. |
| `session_branches` | Branch metadata and fork points for edit/regenerate/fork histories. |
| `a2a_context_messages` | Ordered A2A context messages per target, context and branch. |
| `graph_executions` | Durable A2A executions of agents and workflows: deployment, request message, task snapshot, status, and the lease used to recover work after a restart. |
| `graph_execution_events` | Ordered A2A events per execution; streams are served from these rows. |

## Workflows And Runs

| Table | Stores |
| --- | --- |
| `workflows` | Registered code workflows: artifact folder path, manifest snapshot, source hash, LangGraph topology for the visualizer, resolved bindings, deployed revision. |
| `workflow_revisions` | Append-only revisions, one per registration, so every manifest a workflow ran under stays inspectable. |
| `workflow_runs` | Run id, workflow id, A2A task and context ids, status, input, output, error, executed source hash, timestamps. |
| `workflow_steps` | Per-step status, label, input, output, error and timestamps, keyed by the step's path (`team:research` for a node of an embedded subgraph). Rows are created on first sight of a step; a step that runs again in a loop or fan-out keeps one row, and its executions are counted from the run's events. |
| `workflow_run_events` | Ordered event stream for runs and steps. |
| `workflow_pending_actions` | Pending and resolved human-input requests (interrupts and tool approvals) per run and step. |
| `workflow_tool_calls` | Durable ledger of codemode `tools.*` calls, which a script paused for approval replays from. |
| `langgraph_checkpoints` | LangGraph checkpoints per thread and namespace. |
| `langgraph_checkpoint_writes` | Pending LangGraph channel writes per checkpoint. |

## Triggers And Channels

| Table | Stores |
| --- | --- |
| `triggers` | Schedule (cron), webhook and email triggers: target agent or workflow, task template, spec, next and last run, last error. |
| `trigger_firings` | One row per firing with its task id, source, status and error. |
| `email_poll_state` | Per-mailbox watermark for email triggers. |
| `channel_accounts` | Discord and Teams bot accounts with their credentials. |
| `channel_bindings` | Which agent or workflow answers which messages of an account, with mention and user filters. |
| `channel_threads` | Maps a platform conversation to the A2A context that continues it, plus any task waiting on input. |
| `channel_state_subscriptions`, `channel_state_locks`, `channel_state_entries`, `channel_state_list_items`, `channel_state_queue_items` | Chat SDK state adapter storage, scoped per channel account. |

## Evals

| Table | Stores |
| --- | --- |
| `eval_datasets` | Dataset name, description and default grader ids. |
| `eval_cases` | Cases per dataset in order: input, reference answer, metadata and tags. |
| `eval_graders` | Grader name, description and JSON config. |
| `eval_runs` | Run target, status, trigger, baseline run, trial and concurrency settings, plus snapshots of the dataset name and graders. |
| `eval_trials` | One row per case and trial: case snapshot, status, output, grades, pass verdict, target spend and human review. |
| `eval_gates` | Regression gates: dataset, agent, run settings, and the agent's watched settings as of the gate's last run. |

Runs and trials snapshot what they ran with, so editing or deleting a dataset or grader leaves past results intact.

## Auth And MCP OAuth

| Table | Stores |
| --- | --- |
| `auth_user`, `auth_session`, `auth_account`, `auth_verification` | Dashboard sign-in (better-auth): users with their role, sessions, credentials, verification tokens. |
| `auth_device_code` | Device-authorization state for `agentdock login` in the CLI. |
| `mcp_oauth_clients` | MCP clients known to the server's OAuth authorization server, registered dynamically or by client metadata document. |
| `mcp_oauth_requests` | Authorizations waiting for a signed-in person to approve or deny them. |
| `mcp_oauth_grants` | A person's revocable authorization for a client to act for them over MCP. |
| `mcp_oauth_tokens` | Authorization codes and access/refresh tokens, stored as SHA-256 hashes; refresh tokens rotate per family. |
| `orgs`, `users` | Organisation and user records referenced by `org_id`/`user_id` columns. Not read by the current code. |

## Integration Tables

The embedded integrations gateway (`@integragents/gateway-core`) owns its own
tables and applies its own migrations on start: `gateway_*` for clients, access
profiles, approval policies, approvals, OAuth state and audit; `integration`,
`connection`, `tool`, `credential`, `spec_document`, `oauth_client` and
`oauth_flow` for the catalog. The platform adds:

- `gateway_principals` mapping an agent, workflow, or the platform itself to its gateway client and access profile.

Trace data is not stored in the database. The trace APIs read spans from Tempo
(`TEMPO_URL`), and the server also writes spans to `logs/api.trace.ndjson`.

## Migrations

Drizzle migrations live in `packages/db/drizzle`. After changing
`schema.ts`, generate a migration:

```bash
bun run db:generate
```

The server applies pending migrations on start (`packages/db/src/init.ts`). To
rebuild the local database from scratch and seed it again:

```bash
bun run db:reset
```
