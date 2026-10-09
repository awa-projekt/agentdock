# Architecture

AgentDock is organized around a shared SDK, an Effect-powered API layer, a local SQLite database, and A2A-compatible runtime endpoints. Agents and workflows run on LangChain/LangGraph; integrations come from an embedded integrations gateway.

## Monorepo Boundaries

### `packages/sdk`

The SDK is the shared contract layer. It owns:

- Effect schemas for agents, skills, workflows, sessions, traces, providers, integrations, triggers, channels and evals.
- The typed `AgentdockApi` HTTP definition.
- `createAgentdockClient`, a typed client over Effect HTTP API.
- Route builders for agent and workflow URLs.
- A2A helpers for agent cards, events, history, and the agent and workflow task executors.
- The agent runtime: the LangGraph agent loop, model providers, tool resolution and OpenTelemetry instrumentation of LangChain callbacks.
- The workflow runtime: artifact loading, binding resolution (agents, workflows, tools and platform models), graph execution with nested steps and their executions, run store interface, task input parsing.
- AG-UI adapters and the local runtime the CLI uses to run workflows without a server.

### `packages/api`

The API package implements the server-side behavior behind SDK contracts. Its main composition point is `packages/api/src/handlers.ts`, which merges service layers for agents, workflows, communication policy, the durable A2A runtime, sessions, the integrations gateway, skills, provider keys, triggers, channels, evals, traces and MCP OAuth. `packages/api/src/live.ts` adds the A2A, AG-UI, webhook, OAuth callback and MCP OAuth routes and the CORS policy.

The integrations gateway is embedded from `@integragents/gateway-core`, `@integragents/host` and `@integragents/contracts` (`packages/api/src/gateway`). It owns the integration catalog, connections, credentials, tool policy, approvals and audit. Calls of a run whose first message points MCP integrations at other servers go through `packages/api/src/gateway/run-scoped-integrations.ts` instead (see [A2A events](a2a-events.md#pointing-a-runs-integrations-elsewhere)). `@executor-js/*` is used only for the QuickJS sandbox that runs codemode scripts (`packages/api/src/gateway/codemode.ts`).

### `packages/db`

The database package defines SQLite tables with Drizzle, holds the generated migrations in `packages/db/drizzle`, and applies them at startup. The schema stores registry data, agent and workflow runs, A2A executions and context, sessions, triggers, channels, evals, auth and MCP OAuth state. The gateway's own tables live in the same database; see [Data Model](data-model.md).

### `packages/patterns`

`agentdock-patterns`: graph-level multi-agent patterns (pipeline, router, parallel, voting, map-reduce, orchestrator-workers, evaluator-optimizer) as plain LangGraph factories over bound agents and platform models. It has no dependency on the rest of AgentDock. The server provides it to workflow artifacts like LangGraph itself; see [Multi-agent patterns](patterns.md).

### `apps/server`

The server app is the process entry point. It loads `.env`, applies database migrations, installs logging and OpenTelemetry, builds the routes with `createServerRoutes()` (`apps/server/src/handlers.ts`), and serves them with the Effect HTTP router. On top of the API routes it mounts `/api/auth/*` (better-auth), `/mcp` and `/mcp/internal`, and the API reference at `/docs`.

### `apps/web`

The web app is a React UI with TanStack Query. It manages browser routing locally and calls the API directly from the browser through `apps/web/src/lib/api.ts`; the API allows the dashboard origin through CORS. The web server (`apps/web/src/index.ts`) only builds and serves the HTML and assets, injecting the public API URL into the page. Views are split by feature: agents, chat, communication graph, workflows and runs, triggers, channels, integrations, tools, approvals, provider keys, skills, evals, and traces.

### `apps/cli`

The CLI is an Effect CLI application. It calls the HTTP API with the token stored by `login`, uses the A2A client SDK to stream agent and workflow tasks, and runs workflow folders locally through the SDK's local runtime.

## Request Flow

```text
HTTP request
  -> apps/server/src/index.ts
  -> createServerRoutes()
  -> Effect HTTP API handler group, or a plain route (A2A, AG-UI, MCP, auth, webhooks)
  -> service layer
  -> db, LangGraph runtime, integrations gateway, model provider, or Tempo
  -> HTTP response / SSE stream / A2A task event
```

Requests are handled by the Effect HTTP router on Node. The MCP and auth handlers expect Web `Request` objects, so their routes convert the incoming request before dispatching.

## Effect Layer Model

The API composes services with Effect layers, among them:

- `AgentRegistryLive` stores and retrieves agent definitions.
- `WorkflowRegistryLive` stores workflow registrations and revisions.
- `WorkflowRunStoreLive` persists workflow runs, steps, events and pending actions.
- `AgentCommunicationPolicyLive` checks which agents can call which other agents.
- `AgentA2aHandlersLive` and `WorkflowA2aHandlersLive` expose A2A task endpoints.
- `GraphRuntimeLive` runs A2A executions durably and recovers them after a restart.
- `SessionsServiceLive` tracks chat sessions and branches.
- `GatewayLive` embeds the integrations gateway on the platform database.
- `IntegrationCatalogLive` manages integrations, tools and credentials, and resolves each agent's declared integrations into gateway grants.
- `SkillRegistryLive` manages skill content and agent skill assignment.
- `ProviderKeyRegistryLive` manages provider API keys and custom providers.
- `TriggerRegistryLive`, `TriggerSchedulerLive` and `TriggerDispatcherLive` run triggers.
- `ChannelRegistryLive`, `ChannelGatewayLive` and `ChannelDispatcherLive` run chat channels.
- `EvalServiceLive` and `EvalGatesLive` run evals and regression gates.
- `TracesServiceLive` reads traces from Tempo for the UI.
- `McpOAuthLive` is the OAuth authorization server for external MCP clients.

## A2A Model

Agents and workflows are exposed as A2A targets:

- Agents have cards and JSON-RPC task endpoints under `/agents/:agentId/a2a`.
- Workflows have cards and JSON-RPC task endpoints under `/workflows/:workflowId/a2a`.
- The chat UI treats agents and workflows as selectable targets.
- The CLI creates an A2A client from an agent or workflow A2A URL and streams `message/stream` events.

See [A2A Events](a2a-events.md) for the event stream.

## MCP Endpoints

`/mcp` serves external MCP clients such as coding agents. They authorize through the server's OAuth flow as a signed-in admin and present an access token.

`/mcp/internal` serves the built-in assistant. On startup the server issues a random token and registers this endpoint (`http://127.0.0.1:<port>/mcp/internal`) as an internal integration connected with that token. The UI hides this internal integration so users only manage external integrations.

## Observability

The server exports OpenTelemetry spans through `OTEL_*` settings and writes them to `logs/api.trace.ndjson`. LLM and tool calls are traced from LangChain/LangGraph callbacks as `agentdock.langgraph.*` spans (`packages/sdk/src/agents/langgraph-otel.ts`). Trace data is not stored in the database: the trace APIs query Tempo at `TEMPO_URL`.

## Persistence Strategy

The persistence model is local SQLite. Schema changes go through Drizzle migrations in `packages/db/drizzle`, generated with `bun run db:generate` and applied automatically on server start (`packages/db/src/init.ts`). `bun run db:reset` drops every table, reapplies the migrations and seeds sample agents.
