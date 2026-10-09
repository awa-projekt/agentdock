# Getting Started

## Requirements

- Bun 1.3 or later for package management and scripts.
- Node.js 22 or later for runtime execution through `tsx` (CI uses Node.js 24).
- `bun` on the `PATH` of the API server, which installs pushed workflows' dependencies with it.
- A local `.env` file with provider keys for models you want to call.
- Optional: Docker for the observability stack under `docker/`.

## Install

```bash
bun install
```

If dependencies look stale after an update, rebuild the install tree:

```bash
rm -rf node_modules
bun install
```

## Configure Environment

Create `.env` from the example file:

```bash
cp .env.example .env
```

Set a session secret; the API does not start without it, even with auth disabled:

```bash
BETTER_AUTH_SECRET=a-long-random-string   # e.g. openssl rand -base64 32
```

Set at least one model provider key. Seeded agents default to OpenAI:

```bash
OPENAI_API_KEY=your-openai-api-key
```

Set a stable secret-encryption key before storing provider keys or integration credentials you want to keep. In development a built-in, publicly known key is used when it is unset; outside development it is required:

```bash
AGENTDOCK_SECRET_KEY=at-least-32-random-bytes
```

Existing local plaintext secrets can be encrypted once with:

```bash
bun run db:encrypt-secrets
```

## Run The API And Web UI

```bash
bun run dev
```

This starts both and prints their URLs. The main checkout uses `http://127.0.0.1:38123` for the API and `http://127.0.0.1:38124` for the web UI; linked git worktrees get their own port pair (`bun run urls` prints them). OpenAPI documentation is served at `<api url>/docs`.

Open the web UI and create an account. The first account on a fresh database becomes the admin; later sign-ups are regular users. For local work without logins, use `bun run dev:no-auth`.

The halves can also be started separately with `bun run api` and `bun run web:dev`. The web server only serves the UI; the browser talks to the API directly.

## Seed Local Data

```bash
bun run db:seed
```

This adds the sample agents `planner`, `writer`, `research` and `content-writer`. Reset the local database when schema changes break older local data; the reset seeds the sample agents again:

```bash
bun run db:reset
```

## Useful Commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the API and the web UI together. |
| `bun run dev:no-auth` | The same, with authentication disabled. |
| `bun run api` | Start the API server. |
| `bun run web` | Start the production-mode web server. |
| `bun run web:dev` | Start the web server with Node watch mode. |
| `bun run urls` | Print this checkout's API and web URLs. |
| `bun run cli -- --help` | Show CLI commands. |
| `bun run db:seed` | Seed sample agents. |
| `bun run db:reset` | Reset local SQLite data and re-seed. |
| `bun run test` | Run Vitest. |
| `bun run typecheck` | Run TypeScript checks. |

## Basic CLI Usage

```bash
bun run cli -- login
bun run cli -- agents
bun run cli -- send <agent-id> "Summarize this project"
```

Use a non-default API URL with `AGENTDOCK_API_URL`:

```bash
AGENTDOCK_API_URL=http://127.0.0.1:38123 bun run cli -- agents
```

Workflows are authored as folders and pushed with the CLI; see [Workflows](workflows.md).
