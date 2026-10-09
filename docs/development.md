# Development

## TypeScript And Runtime

AgentDock is TypeScript-first and uses Bun for workspace package management. Runtime scripts execute with Node and `tsx`.

## Testing And Checks

Tests use Vitest with `@effect/vitest`; run them with Vitest, not `bun test`:

```bash
bun run test
```

The other checks CI runs:

```bash
bun run typecheck     # TypeScript plus Effect language-service diagnostics
bun run format:check  # Biome formatting
bun run lint          # Biome and Oxlint (including the plugins under tools/oxlint)
bun run knip          # unused files, exports and dependencies
```

Database migrations are managed with Drizzle Kit: edit `packages/db/src/schema.ts`, run `bun run db:generate`, and commit the generated SQL and snapshot. Migrations apply on server start.

## Where To Make Changes

| Change | Primary Location |
| --- | --- |
| New API endpoint | `packages/sdk/src/api/http.ts`, then `packages/api/src/handlers`. |
| New schema | `packages/sdk/src/schemas`. |
| New persistent field | `packages/db/src/schema.ts` and relevant services. |
| Agent behavior | `packages/api/src/agents` and A2A handlers. |
| Workflow runtime | `packages/sdk/src/workflows` (loading, bindings, runtime) and `packages/api/src/workflows` (deployment, checkpointing). |
| Multi-agent pattern | `packages/patterns/src`, with its docs in `docs/patterns.md`. |
| Web view | `apps/web/src/views` and shared UI under `apps/web/src/components`. |
| CLI command | `apps/cli/src/commands`, registered in `apps/cli/src/index.ts`. |

## API Contract Pattern

The SDK owns the public contract. Add or update Effect schemas first, wire the HTTP API definition, then implement the handler and service layer. This keeps server code, web code, CLI code, and external SDK consumers aligned.

## Workflows

Workflows are LangGraph code folders, not a node model owned by AgentDock. The artifact format, injected context and CLI loop are described in [Workflows](workflows.md); working examples live in `apps/examples/workflows`.

## Effect Guidance

The codebase uses Effect v4. If you have the `effect-solutions` CLI installed, consult its guides with `effect-solutions list` and `effect-solutions show <topic>` before writing new Effect code. `node --import tsx scripts/pull-references.ts` clones reference repositories (Effect, effect-atom and others) into the git-ignored `.references/` directory for reading.

## Documentation

The published docs live under `docs/` and are built with MkDocs (`mkdocs.yml`); see [Operations](operations.md#docs-deployment).
