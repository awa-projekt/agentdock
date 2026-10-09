[Deutsch](README.md) | English

# AgentDock

AgentDock is a TypeScript workspace for registering, running and managing AI agents and LangGraph workflows. It uses Bun for package management and Node.js for runtime execution, and consists of:
- an API server that registers agents and workflows and exposes them over A2A JSON-RPC endpoints
- a web UI for agents, chat, integrations, workflows, triggers, approvals, evals and traces
- a CLI for logging in, scaffolding and pushing agents and workflows, and sending tasks to them
- a shared SDK (`packages/sdk`) with the schemas, API client and workflow runtime
- `agentdock-patterns` (`packages/patterns`), multi-agent patterns for workflows (router, pipeline, parallel, orchestrator, review loops)

> **About the name:** Other projects called AgentDock, or something similar, exist. They are unrelated to this one: we didn't know of them when we created and named it, and they were not used as a reference.

## Features

- Agent registry; every agent is exposed as an A2A target with an agent card.
- Agents take every part of a message: text, files (images, audio, documents) and data.
- Workflows as plain LangGraph code folders, validated, run locally and pushed with the CLI, and exposed as A2A targets. They call bound agents, integration tools and platform models, and can build on the multi-agent patterns of `agentdock-patterns`.
- MCP and OpenAPI integrations with OAuth connect flows, per-agent tool grants, and tool-call approvals. A run can point its MCP integrations at other servers, e.g. an eval case's own server.
- Skills, agent-to-agent communication rules, and models from OpenAI, Anthropic, Google, xAI, Mistral, DeepSeek and Groq.
- Schedule, webhook and email triggers, and Discord and Teams channels.
- Eval sessions with datasets and graders.
- An MCP endpoint (`<api url>/mcp`) so coding agents such as Claude Code, Codex and OpenCode can manage the instance.
- Local SQLite persistence and sample agents via the seed script.
- Every span recorded to a local NDJSON trace file, plus optional OpenTelemetry export through standard `OTEL_*` environment variables.

## Requirements

- [Bun](https://bun.sh) 1.3 or later for package management and scripts.
- Node.js 22 or later for runtime execution (CI uses Node.js 24). The API server also needs `bun` on its `PATH`, because pushing a workflow installs its dependencies with Bun.
- An API key for at least one model provider. The seeded agents use OpenAI.
- Optional: Docker, for the local observability stack (see [Observability](#observability)).

## Basic Setup

```bash
git clone <repository url> agentdock
cd agentdock
bun install
```

`bun install` also installs a formatter-only Git pre-commit hook (via [lefthook](https://lefthook.dev)) that runs `biome format --write` on staged files and re-stages them. Linting and type checking are not run at commit time; CI covers them.

## Environment

Create a local `.env` from the example file:

```bash
cp .env.example .env
```

Then edit `.env` and set at least:

```bash
OPENAI_API_KEY=your-openai-api-key
BETTER_AUTH_SECRET=a-long-random-string   # e.g. the output of: openssl rand -base64 32
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | yes | Signs login sessions. The API does not start without it, even with auth disabled. |
| `OPENAI_API_KEY` | for the seeded agents | Provider key. `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY` and `GROQ_API_KEY` work the same way. Keys can also be stored in the UI. |
| `AGENTDOCK_SECRET_KEY` | outside development | Master key (at least 32 bytes) that encrypts stored provider keys and integration credentials. In development a built-in, publicly known key is used when it is unset (the API logs a warning), so set your own for anything you keep. |
| `AGENTDOCK_SERVER_HOST` | no | Interface the API and web server listen on. Defaults to `127.0.0.1`; set `0.0.0.0` to reach them from other machines. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | OTLP/HTTP collector to export spans to. The example value points at the Docker stack; without it running, the API logs a warning and carries on. |
| `TEMPO_URL` | no | Tempo instance the Traces view reads from. |
| `MS_GRAPH_TENANT_ID`, `MS_GRAPH_CLIENT_ID`, `MS_GRAPH_CLIENT_SECRET` | no | Microsoft Graph app for email triggers. |
| `AGENTDOCK_API_URL`, `AGENTDOCK_PUBLIC_API_URL`, `AGENTDOCK_WEB_ORIGIN` | no | Only needed when the app is not reached over `127.0.0.1`, e.g. a deployed environment. |

The seeded agents use `openai:gpt-5.6-luna` with low reasoning effort by default, so the OpenAI key is required before chatting with them or running workflows that call them.

Existing plaintext secrets in a local database can be encrypted once with `bun run db:encrypt-secrets`.

## Start The Dev Servers

```bash
bun run dev
```

This starts the API and the UI together and prints both URLs; Ctrl-C stops both. Open the UI and create an account: the first account on a fresh database becomes the admin, later sign-ups are regular users. To run locally without authentication, use `bun run dev:no-auth`. Either half can still be started on its own with `bun run api` and `bun run web:dev` (or `bun run api:no-auth` and `bun run web:dev:no-auth`).

Ports are derived from the checkout rather than configured: the main checkout uses `38123` for the API and
`38124` for the UI, while every linked git worktree hashes its own path into a stable port pair of its own,
so several checkouts can run at the same time. `bun run urls` prints them (`--json` for machine use) and
`bun run kill` frees them. Set `AGENTDOCK_PORT_BASE` to pin the API port; the UI takes the next one.

API docs are available at `<api url>/docs`. The UI calls the API directly from the browser; OAuth callbacks
go to the API as well.

## Seed Sample Data

Seed the sample agents (`planner`, `writer`, `research`, `content-writer`) and their communication rules:

```bash
bun run db:seed
```

To start over with a clean local database, run:

```bash
bun run db:reset
```

This drops every table, recreates the schema and seeds the sample agents again. The database is the file `agentdock.db` in the directory the server is started from.

If something stops working after pulling or updating the project, try `bun run db:reset`. Migrations are applied on server start, but an old local database can still break the app until it is reset.

## CLI

Run the CLI from the repository root with `bun run cli`:

```bash
bun run cli -- --help
```

| Command | Purpose |
| --- | --- |
| `login`, `logout`, `whoami` | Log in through the browser (device flow), log out, show the current user. |
| `agents`, `workflows` | List agents and workflows on the server. |
| `send <agent-id> <message>` | Send a message to an agent over A2A and stream the reply. |
| `init` | Create an AgentDock project (`agentdock.project.json`) in the current directory. |
| `pull`, `push`, `status` | Download, upload and compare the project's agents (`agents/<name>.agent.yaml`) and workflows. |
| `new <name>` | Scaffold a workflow folder. |
| `check [folders…]` | Validate workflow folders and report their contracts, topology and bindings. |
| `run <folder> <input>` | Run a workflow folder locally, without a server. |
| `invoke <workflow> <input>` | Run a registered workflow on the server and stream its events. |
| `runs [run-id]` | List workflow runs, or show one run with its steps and events. |

For example:

```bash
bun run cli -- login
bun run cli -- agents
bun run cli -- send <agent-id> "Summarize this project"
```

The CLI targets the API of the checkout it runs in. Point it somewhere else with:

```bash
AGENTDOCK_API_URL=http://127.0.0.1:38123 bun run cli -- agents
```

Inside a project created with `init`, the API URL in `agentdock.project.json` takes precedence.

There is no installed `agentdock` binary. To use the CLI from another directory, such as a workflow project, define an alias in the repository root:

```bash
alias agentdock="$PWD/node_modules/.bin/tsx $PWD/apps/cli/src/index.ts"
```

The workflow format, the CLI loop and the injected runtime context are described in [docs/workflows.md](docs/workflows.md), the multi-agent patterns in [docs/patterns.md](docs/patterns.md). Working examples are in [apps/examples](apps/examples).

## Observability

The API always appends its spans to `logs/api.trace.ndjson`. For a full local stack, start the Docker services:

```bash
docker compose -f docker/compose.yaml up -d
```

This runs an OpenTelemetry collector (`4317`/`4318`), Tempo (`3200`), Grafana (`http://localhost:3301`) and Langfuse (`http://localhost:3000`, login `dev@agentdock.local` / `agentdock-dev`). The in-app Traces view reads from Tempo. The stack uses fixed development credentials and anonymous Grafana admin access, so do not expose it beyond your machine. See [docs/operations.md](docs/operations.md) for details.

## Development

```bash
bun run test          # run the Vitest suite
bun run typecheck     # run TypeScript checks
bun run lint          # run Biome and Oxlint
bun run knip          # find unused files, exports and dependencies
bun run format        # format the repository with Biome
bun run format:check  # check formatting without writing
```

CI runs `typecheck`, `format:check`, `lint`, `knip` and `test` on every merge request and on the default branch.

More documentation lives in [docs/](docs/index.md) and can be built as a site with MkDocs (see [docs/operations.md](docs/operations.md#docs-deployment)).

## Troubleshooting

### Stale installs

If the API fails after dependency updates with an error that points at an old package version under `node_modules/.bun`, rebuild the install tree from the lockfile:

```bash
rm -rf node_modules
bun install
```

Bun can leave stale package directories in `node_modules/.bun` after transitive dependency or override changes. The lockfile may be correct while Node still resolves an old on-disk package until `node_modules` is recreated.

### Certificate errors behind a TLS-intercepting proxy

If calls to model providers fail with certificate errors because a proxy re-signs TLS traffic, point Node at the proxy's CA certificate:

```bash
NODE_EXTRA_CA_CERTS=/path/to/proxy-ca.pem bun run api
```

As a last resort during local development only, `NODE_TLS_REJECT_UNAUTHORIZED=0 bun run api` disables certificate checks entirely.

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 awa-projekt.
