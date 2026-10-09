# AgentDock

AgentDock is a TypeScript monorepo for building, running, and managing A2A-compatible agents and LangGraph workflows. It provides a local API server, a web UI, a CLI, a shared SDK, SQLite persistence, MCP and OpenAPI tool integrations, and optional OpenTelemetry tracing.

## What It Provides

- Agent registry with create, update, list, delete, skill assignment, communication policy, and A2A exposure.
- Workflow registry for LangGraph code folders that are also exposed as A2A task targets, with bound agents, tools and platform models.
- `agentdock-patterns`, multi-agent patterns (router, pipeline, parallel, orchestrator, review loops) that workflows import from the host.
- Web UI for agents, chat, workflows and runs, tools, integrations, approvals, triggers, channels, provider keys, skills, eval sessions, and traces.
- CLI for logging in, syncing agents and workflows with a local project, running workflows locally, and streaming A2A messages.
- Integration management for MCP and OpenAPI sources through an embedded gateway, with OAuth connect flows, per-agent tool grants and approvals.
- Schedule, webhook and email triggers, and Discord and Teams channels.
- Local SQLite persistence through Drizzle schemas.
- Shared `agentdock-sdk` schemas, route helpers, A2A helpers, API client, and workflow runtime primitives.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `apps/server` | Node HTTP server, Effect runtime wiring, logs, observability, and request dispatch. |
| `apps/web` | React web UI served by a small Node app. |
| `apps/cli` | Effect CLI for login, project sync (`pull`/`push`/`status`), workflow scaffolding, checks and local runs, and A2A message streaming. |
| `packages/api` | HTTP handlers, service layers, A2A handlers, workflow deployment and execution services, the integration gateway. |
| `packages/sdk` | Public schemas, typed API client, route builders, A2A utilities, workflow graph execution code. |
| `packages/db` | Drizzle SQLite schema and database initialization. |
| `packages/patterns` | `agentdock-patterns`, multi-agent workflow patterns over LangGraph. |
| `apps/examples` | Standalone example apps and example workflow folders. |
| `scripts` | Dev server launcher, port printing, local database reset, seed data, secret encryption, and reference pulling. |
| `docker` | Local observability stack configuration for OpenTelemetry, Tempo, Grafana, and Langfuse. |

## Runtime Shape

```text
Web UI / CLI / A2A clients
          |
          v
apps/server HTTP server on :38123
          |
          v
packages/api handlers and Effect service layers
          |
          +--> packages/db SQLite tables
          +--> packages/sdk schemas, routes, workflow runtime
          +--> integration gateway (MCP, OpenAPI) and MCP server
          +--> LangChain / LangGraph model providers
```

Start with [Getting Started](getting-started.md), then read [Architecture](architecture.md) for the system model.
