# API Surface

The authoritative API definition is `packages/sdk/src/api/http.ts`. The server implements that definition through Effect HTTP API handlers in `packages/api/src/handlers`. A2A, AG-UI, webhook, OAuth and MCP routes sit outside it and are added as plain routes (`packages/api/src/**/router.ts`, `packages/api/src/mcp/routes.ts`, `apps/server/src/handlers.ts`).

The server serves an interactive reference for the typed API at `/docs` and its OpenAPI document at `/docs/openapi.json`.

## General

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Health check. |
| `GET` | `/models` | List available model identifiers. |
| `GET` | `/schemas/workflow-manifest.json` | JSON Schema of `agentdock.workflow.json`. |
| `GET` | `/events` | Server-sent change feed: names the resources (agents, workflows, runs, …) written since the client subscribed. |

## Provider Keys

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/provider-keys` | List provider key metadata. |
| `PUT` | `/provider-keys/:provider` | Set a provider key. |
| `DELETE` | `/provider-keys/:provider` | Remove a provider key. |
| `POST` | `/provider-keys/validate-model` | Check that a `provider:model` id answers with the configured key. |

## Agents

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/agents` | List agents. |
| `POST` | `/agents` | Create an agent. |
| `PUT` | `/agents/:agentId` | Update an agent. |
| `GET` | `/agents/:agentId/internals` | Read internal agent details. |
| `DELETE` | `/agents/:agentId` | Remove an agent. |
| `GET` | `/agents/external` | List external A2A agents. |
| `POST` | `/agents/external` | Register an external A2A agent by URL. |
| `PUT` | `/agents/external/:agentId` | Update an external A2A agent. |
| `DELETE` | `/agents/external/:agentId` | Remove an external A2A agent. |
| `GET` | `/agents/:agentId/allowed-targets` | Agents this agent may call, with their A2A URLs. |
| `GET` | `/agent-runs/:id` | Read one agent run record. |

## Skills

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/skills` | List skills. |
| `POST` | `/skills` | Create a skill. |
| `POST` | `/skills/pull` | Pull skills from a source. |
| `DELETE` | `/skills/:skillId` | Remove a skill. |
| `GET` | `/.well-known/agent-skills/index.json` | Index of the built-in skills for `npx skills add`. |
| `GET` | `/.well-known/agent-skills/:skillId/SKILL.md` | One built-in skill document. |

## Workflows

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/workflows` | List workflows. |
| `POST` | `/workflows` | Register a workflow artifact; an existing manifest name gets a new revision. |
| `DELETE` | `/workflows/:workflowId` | Remove a workflow. |
| `GET` | `/workflows/:workflowId/artifact` | Download the deployed artifact's files. |
| `GET` | `/workflows/runs` | List workflow runs. |
| `GET` | `/workflows/runs/:runId` | Read a workflow run snapshot with its steps. |
| `GET` | `/workflows/runs/:runId/events` | List workflow run events. |
| `GET` | `/workflows/runs/:runId/agent-runs` | List the agent runs a workflow run made. |

See [Workflows](workflows.md) for the artifact format.

## A2A And AG-UI

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/agents/:agentId/a2a/.well-known/agent-card.json` | Agent card. |
| `POST` | `/agents/:agentId/a2a` | A2A JSON-RPC endpoint for an agent. |
| `GET` | `/workflows/:workflowId/a2a/.well-known/agent-card.json` | Workflow card. |
| `POST` | `/workflows/:workflowId/a2a` | A2A JSON-RPC endpoint for a workflow. |
| `POST` | `/agents/:agentId/ag-ui` | Run an agent over the AG-UI protocol (SSE). |
| `POST` | `/workflows/:workflowId/ag-ui` | Run a workflow over the AG-UI protocol (SSE). |

Route helpers live in `agentdock-sdk/routes`. The A2A event stream is described in [A2A Events](a2a-events.md).

## Triggers And Channels

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/triggers` | List triggers. |
| `POST` | `/triggers` | Create a schedule, webhook or email trigger. |
| `PUT` | `/triggers/:triggerId` | Update a trigger. |
| `DELETE` | `/triggers/:triggerId` | Remove a trigger. |
| `POST` | `/triggers/:triggerId/webhook` | Fire a webhook trigger; authenticated with the `x-trigger-secret` header. |
| `GET` | `/channels/accounts` | List Discord and Teams bot accounts. |
| `POST` | `/channels/accounts` | Add an account. |
| `PUT` | `/channels/accounts/:accountId` | Update an account. |
| `DELETE` | `/channels/accounts/:accountId` | Remove an account. |
| `GET` | `/channels/accounts/status` | Connection status of every account. |
| `GET` | `/channels/bindings` | List bindings from accounts to agents or workflows. |
| `POST` | `/channels/bindings` | Add a binding. |
| `PUT` | `/channels/bindings/:bindingId` | Update a binding. |
| `DELETE` | `/channels/bindings/:bindingId` | Remove a binding. |
| `POST` | `/channels/:accountId/webhook` | Inbound Teams activity for an account. |

## Integrations

An integration is a URL that leads to an API: an MCP endpoint or an OpenAPI
document. Discovery registers it and reports the auth methods it offers;
connecting it captures its tools.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/integrations` | List integrations, their connections, and every reachable tool. |
| `POST` | `/integrations/registry/search` | Search a public integrations registry for MCP and OpenAPI surfaces. |
| `POST` | `/integrations/discover` | Register an integration from a URL. |
| `DELETE` | `/integrations/:slug` | Remove an integration, its connections and its grants. |
| `POST` | `/integrations/:slug/connections` | Connect with a static credential, or with no auth. |
| `POST` | `/integrations/:slug/connections/oauth` | Start an OAuth connection. |
| `DELETE` | `/integrations/:slug/connections/:name` | Remove a connection. |
| `POST` | `/integrations/:slug/connections/:name/refresh` | Re-capture a connection's tools. |
| `GET` | `/oauth-sessions/:sessionId` | Read an OAuth session in progress. |
| `POST` | `/oauth-sessions/:sessionId/client` | Supply an OAuth client the provider requires. |
| `GET` | `/v1/oauth/callback` | Where every OAuth flow redirects back to. |
| `POST` | `/tools/execute` | Run one tool under policy. |
| `PUT` | `/tools/:toolId/decision` | Let a tool run immediately, or make it ask a human. |

## Your Own Connections

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/me/connections` | List the integrations an agent reaches through the caller's own account. |
| `POST` | `/me/connections/:slug` | Connect the caller's own account with a static credential. |
| `POST` | `/me/connections/:slug/oauth` | Start an OAuth connection for the caller. |
| `DELETE` | `/me/connections/:slug/:name` | Remove one of the caller's connections. |

## Agent Tool Configuration

Agents are deny-by-default: an agent reaches only the tools its own config
declares. The `integrations` block of an agent names each integration by its
endpoint, the connection the agent's calls go through, and the tools it gets in
`native` or `codemode` mode (`*` for all of them). Creating or updating an agent
registers integrations that are missing, opens org connections that need no
person (no auth, or a key named by server environment variable), and projects
the result onto the agent's gateway access profile. `${AGENTDOCK_URL}` in an
endpoint stands for this server's own origin.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/agents/:agentId/tools` | Every catalog tool with the mode the agent's config gives it, plus declarations the server cannot resolve (unknown endpoint, missing or OAuth connection, unknown tool). |

## Approvals And Audit

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/approvals` | List frozen tool calls, filtered by status. |
| `POST` | `/approvals/:approvalId/approve` | Approve a frozen call and run it. |
| `POST` | `/approvals/:approvalId/deny` | Deny a frozen call. |
| `GET` | `/audit` | List every tool call the gateway ran, denied or froze. |

## Sessions

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/evals/sessions` | List chat sessions across targets. |
| `GET` | `/evals/sessions/:targetId/:sessionId` | Read a session with its messages. |
| `GET` | `/agents/:agentId/sessions` | List sessions for an agent. |
| `DELETE` | `/agents/:agentId/sessions/:sessionId` | Delete a session. |

## Evals

All paths are under `/evals`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`, `POST` | `/evals/datasets` | List or create datasets. |
| `GET`, `PUT`, `DELETE` | `/evals/datasets/:datasetId` | Read, update or remove a dataset. |
| `POST` | `/evals/datasets/:datasetId/cases` | Add cases. |
| `PUT` | `/evals/datasets/:datasetId/cases/:caseId` | Update a case. |
| `POST` | `/evals/datasets/:datasetId/cases/remove` | Remove cases. |
| `GET`, `POST` | `/evals/graders` | List or create graders. |
| `POST` | `/evals/graders/test` | Try a grader on a sample without saving it. |
| `PUT`, `DELETE` | `/evals/graders/:graderId` | Update or remove a grader. |
| `GET`, `POST` | `/evals/runs` | List runs or start one. |
| `GET`, `DELETE` | `/evals/runs/:runId` | Read or remove a run. |
| `POST` | `/evals/runs/:runId/cancel` | Cancel a run. |
| `POST` | `/evals/runs/:runId/regrade` | Re-grade a run with other graders. |
| `PUT` | `/evals/runs/:runId/trials/:trialId/review` | Record a human review of a trial. |
| `GET`, `POST` | `/evals/gates` | List or create regression gates. |
| `PUT`, `DELETE` | `/evals/gates/:gateId` | Update or remove a gate. |
| `POST` | `/evals/gates/:gateId/run` | Run a gate now. |

## Traces

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/traces` | List traces with optional query filters. |
| `GET` | `/traces/:traceId` | Read trace detail. |

## Auth And MCP Access

| Method | Path | Purpose |
| --- | --- | --- |
| `*` | `/api/auth/*` | Dashboard and CLI sign-in (better-auth), including the device flow. |
| `GET` | `/mcp-access` | The MCP and skills URLs plus the MCP clients the caller has authorized. |
| `DELETE` | `/mcp-access/grants/:grantId` | Revoke an MCP client's authorization. |
| `GET` | `/mcp-access/requests/:requestId` | Read a pending MCP authorization request. |
| `POST` | `/mcp-access/requests/:requestId` | Approve or deny it. |
| `*` | `/mcp` | MCP endpoint for external clients; requires an OAuth access token. |
| `*` | `/mcp/internal` | MCP endpoint for the built-in assistant; requires the token issued at startup. |
| `GET` | `/.well-known/oauth-authorization-server` | OAuth authorization server metadata. |
| `GET` | `/.well-known/oauth-protected-resource/mcp` | Protected resource metadata for `/mcp`. |
| `POST` | `/oauth/register` | Dynamic client registration. |
| `GET` | `/oauth/authorize` | Start an authorization; sends the person to the consent page. |
| `POST` | `/oauth/token` | Exchange a code or refresh token. |

## Typed Client

Use `createAgentdockClient` from `agentdock-sdk/api` for application code that wants typed API calls instead of manual `fetch` usage.
