# AgentDock

AgentDock is a TypeScript workspace that uses Bun for package management and Node.js for runtime execution:
- running an API server that registers agents and graph workflows
- exposing agents and workflows over A2A JSON-RPC endpoints
- managing agents, MCP tool sources, communication rules, workflows, and chat sessions from a web UI
- managing agents and sending/querying tasks from a CLI

## Features

- Agent registry with create, update, list, and remove operations.
- A2A agent cards and JSON-RPC task endpoints for every agent.
- Workflow registry with graph-based workflows exposed as A2A endpoints.
- Web UI for agent management, chat, MCP sources, communication graph, and workflow editing.
- MCP source probing, OAuth start flow, and per-agent executor source management.
- Persisted local SQLite data plus sample agents and workflows via the seed script.
- Optional OpenTelemetry trace export through standard `OTEL_*` environment variables.

## Basic Setup

```bash
bun install
```

## Common Commands

```bash
bun run server      # start the API server
bun run web         # start the web UI
bun run cli --help  # show CLI commands
bun run db:seed     # seed sample agents and workflows
bun run db:reset    # reset the local database
bun run test        # run the Vitest suite
bun run typecheck   # run TypeScript checks
```

## Environment

Create a local `.env` from the example file and add an API key:

```bash
cp .env.example .env
```

Then edit `.env` and set:

```bash
OPENAI_API_KEY=your-openai-api-key
```

The seeded agents use `openai:gpt-5.4-mini` by default, so the API key is required before chatting with agents or running workflows that call agents.

## Start The API Server

```bash
bun run api
```

`bun run server` is equivalent to `bun run api`.

The API starts on `http://127.0.0.1:38123` by default. API docs are available at `http://127.0.0.1:38123/docs`.

## Start The UI

In a second terminal, run:

```bash
bun run web
```

The UI starts on `http://127.0.0.1:3001` by default and proxies API, A2A, and OAuth callback requests to the API server.

## Seed Sample Data

After the API has initialized the database tables, seed example agents and workflows:

```bash
bun run db:seed
```

If you want a clean local database, reset it first:

```bash
bun run db:reset
```

## Basic CLI Commands

List agents:

```bash
bun run cli -- list-agents
```

Add an agent:

```bash
bun run cli -- add-agent writer "writes drafts" "be concise" "openai:gpt-5.4-mini"
```

Update an agent from JSON:

```bash
bun run cli -- update-agent <agent-id> '{"name":"writer","description":"writes drafts","instructions":"be concise","model":"openai:gpt-5.4-mini","tools":[],"skillIds":[],"communication":{"allowAll":false,"allowedAgentIds":[]},"version":"0.1.0","capabilities":{"pushNotifications":false,"streaming":true},"defaultInputModes":["text/plain"],"defaultOutputModes":["text/plain"]}'
```

Remove an agent:

```bash
bun run cli -- remove-agent <agent-id>
```

Send a message to an agent id:

```bash
bun run cli -- send-message <agent-id> "Summarize this project"
```

Use a non-default API URL:

```bash
AGENTDOCK_API_URL=http://127.0.0.1:38123 bun run cli -- list-agents
```

## Stuff

OpenAPI certificate error (only use for dev):
NODE_TLS_REJECT_UNAUTHORIZED=0 bun run api
