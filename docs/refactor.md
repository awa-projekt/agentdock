# Backend Refactor Review

## Backend Scope

This review treats backend as `apps/server`, `packages/api`, `packages/db`, `packages/executor-storage-*`, and backend-facing `packages/sdk` API/A2A/tool/workflow files.

Excluded: `apps/web`, `node_modules`, `.references`, and docs-only issue notes.

## Biggest Refactor Targets

| File | Lines | Why it stands out |
|---|---:|---|
| `packages/api/src/executor/service.ts` | 901 | God service for executor setup, plugins, auth, OAuth, secrets, sources, policies, tool creation. |
| `packages/executor-storage-drizzle/src/adapter.ts` | 903 | Vendored adapter, `@ts-nocheck`, many casts, dialect logic, retry logic, query compiler in one file. |
| `packages/api/src/a2a/session-store.ts` | 741 | Task store, context history, session projection, eval summary/detail logic, persistence all mixed. |
| `packages/sdk/src/api/schemas.ts` | 674 | Large shared API schema surface. Probably acceptable, but it is the canonical contract and should not be duplicated elsewhere. |
| `packages/db/src/schema.ts` | 508 | Large but acceptable as DB source of truth. Risk comes from duplicated raw SQL elsewhere. |
| `packages/api/src/mcp/server.ts` | 414 | MCP server duplicates route schemas and service orchestration. |

## Main Findings

1. `packages/api/src/db/init.ts:4` manually duplicates the database schema as raw `CREATE TABLE` SQL while `packages/db/src/schema.ts:3` is the Drizzle source of truth. This is the biggest drift risk.

2. `packages/db/drizzle/0000_big_stingray.sql:1` is tiny/stale compared to the live schema. `ensureDatabaseTables()` is effectively a second migration system.

3. `packages/api/src/db/init.ts:74` creates executor tables manually but misses indexes declared in `packages/db/src/schema.ts`. DB behavior/performance depends on which path initialized the DB.

4. `packages/executor-storage-drizzle/src/adapter.ts:1` and `packages/executor-storage-file/src/adapter.ts:1` use `// @ts-nocheck` in storage-critical code. This hides integration breakage.

5. `packages/executor-storage-file/src/adapter.ts:2` says storage-file but delegates to storage-drizzle. Combined with `packages/executor-storage-file/package.json` publishing as `@executor-js/storage-file`, this looks like a compatibility shim.

6. `packages/api/src/executor/service.ts:56`, `packages/api/src/executor/service.ts:394`, and `packages/api/src/executor/service.ts:399` use broad `any`/`unknown` casts around the central executor object. That suggests the executor/plugin typing boundary is not clean.

7. `packages/api/src/executor/service.ts:375` stores per-agent executor handles in an unbounded in-memory `Map`. Similar unbounded maps exist in `packages/api/src/a2a/session-store.ts` and `packages/api/src/mcp/server.ts`.

8. `packages/api/src/a2a/session-store.ts:326` persists messages with `void persistContextMessage(...)`. DB write failures are silently dropped and can race in-memory state.

9. `packages/api/src/a2a/session-store.ts` loads full task/message/session sets for listing and hydration. This will become expensive quickly.

10. `packages/api/src/skills/service.ts:136` shells out to `npx skills add <source>`. Fine for trusted local use, risky if reachable from untrusted input.

11. `packages/api/src/skills/service.ts:43` hand-parses YAML frontmatter with regex. This will break on normal YAML cases.

12. `packages/api/src/mcp/server.ts:21` duplicates API schemas in Zod while `packages/sdk/src/api/schemas.ts` has canonical Effect schemas.

13. `packages/api/src/mcp/server.ts:135` duplicates communication-policy sync logic from `packages/api/src/handlers/agents.ts`.

14. `packages/sdk/src/routes.ts:5` builds paths without `encodeURIComponent`; IDs containing `/`, `?`, `#` can break routing.

15. `apps/server/src/index.ts:89` hard-codes port `38123`. No env override.

16. `apps/server/src/index.ts:22` creates a new log file every start with no rotation/retention.

17. `apps/server/src/observability.ts:29` has a single global `warnOnce`, so one OTEL warning suppresses later distinct warnings.

18. `packages/api/src/executor/service.ts:109` stores secrets as plaintext blob values in SQLite.

19. `packages/api/src/executor/service.ts:393` allows HTTP OAuth endpoints. Probably okay for local dev, risky for anything exposed.

20. `packages/api/src/a2a/router.ts` trusts `Host` and `x-forwarded-proto` for public URL generation.

## File Overview

| File | Lines | Purpose |
|---|---:|---|
| `apps/server/src/index.ts` | 121 | Node HTTP server bootstrap, request conversion, MCP routing, DB ensure, internal MCP bootstrap. |
| `apps/server/src/handlers.ts` | 50 | Creates/closes server handlers for HTTP and MCP. |
| `apps/server/src/observability.ts` | 100 | OpenTelemetry/exporter setup and logging warnings. |
| `apps/server/package.json` | 23 | Server package dependencies/scripts. |
| `apps/server/tsconfig.json` | 29 | Server TS config. |
| `apps/server/README.md` | 15 | Server package notes. |
| `packages/api/index.ts` | 1 | Public barrel export. |
| `packages/api/src/live.ts` | 26 | Composes API, A2A, executor routes and CORS. |
| `packages/api/src/handlers.ts` | 40 | Composes backend service layers. |
| `packages/api/src/routes.ts` | 15 | API route constants. |
| `packages/api/src/api.ts` | 1 | API barrel. |
| `packages/api/src/db/init.ts` | 108 | Manual table creation/bootstrap. High drift risk. |
| `packages/api/src/tracing.ts` | 17 | Shared tracing helpers/layer. |
| `packages/api/src/agents/api.ts` | 1 | Agents API barrel. |
| `packages/api/src/agents/schemas.ts` | 35 | Agent input/output schemas/types. |
| `packages/api/src/agents/service.ts` | 125 | Agent CRUD/listing service. |
| `packages/api/src/agents/communication-policy.ts` | 163 | Agent-to-agent communication rule sync/evaluation. |
| `packages/api/src/agents/internal-agents.config.ts` | 28 | Internal agent definitions. |
| `packages/api/src/agents/internal-agent-bootstrap.ts` | 29 | Ensures internal agents exist. |
| `packages/api/src/handlers/agents.ts` | 195 | HTTP handlers for agents. |
| `packages/api/src/handlers/skills.ts` | 64 | HTTP handlers for skills. |
| `packages/api/src/handlers/executor.ts` | 110 | HTTP handlers for executor source/tool actions. |
| `packages/api/src/handlers/workflows.ts` | 66 | HTTP handlers for workflows. |
| `packages/api/src/handlers/sessions.ts` | 43 | HTTP handlers for sessions. |
| `packages/api/src/handlers/traces.ts` | 28 | HTTP handlers for traces. |
| `packages/api/src/handlers/general.ts` | 8 | Health/root/general handlers. |
| `packages/api/src/skills/service.ts` | 197 | Skill import/listing/storage service. |
| `packages/api/src/executor/service.ts` | 901 | Executor registry, source CRUD, auth/OAuth, tool policies, execution tool creation. |
| `packages/api/src/executor/schemas.ts` | 64 | Executor API schemas/types. |
| `packages/api/src/executor/router.ts` | 53 | Executor HTTP route wiring. |
| `packages/api/src/executor/api.ts` | 1 | Executor API barrel. |
| `packages/api/src/executor-plugin-modules.d.ts` | 7 | Local executor plugin module declarations. |
| `packages/api/src/mcp/server.ts` | 414 | MCP server exposing backend capabilities as tools. |
| `packages/api/src/a2a/router.ts` | 183 | A2A HTTP/JSON-RPC/SSE routing. |
| `packages/api/src/a2a/handlers.ts` | 57 | A2A handler creation. |
| `packages/api/src/a2a/session-store.ts` | 741 | Persistent A2A task/context/session/eval store. |
| `packages/api/src/a2a/state.ts` | 23 | A2A shared state/service tag. |
| `packages/api/src/workflows/service.ts` | 105 | Workflow CRUD/list service. |
| `packages/api/src/workflows/schemas.ts` | 21 | Workflow schemas/types. |
| `packages/api/src/workflows/a2a.ts` | 75 | Workflow A2A bridge/execution. |
| `packages/api/src/workflows/executor.ts` | 1 | Workflow executor barrel. |
| `packages/api/src/workflows/api.ts` | 1 | Workflow API barrel. |
| `packages/api/src/sessions/schemas.ts` | 20 | Session response schemas/types. |
| `packages/api/src/sessions/api.ts` | 1 | Sessions API barrel. |
| `packages/api/src/traces/service.ts` | 212 | Trace querying/projection service. |
| `packages/api/src/traces/schemas.ts` | 14 | Trace schemas/types. |
| `packages/api/src/traces/api.ts` | 1 | Traces API barrel. |
| `packages/api/src/general/api.ts` | 1 | General API barrel. |
| `packages/api/package.json` | 43 | API package dependencies/scripts. |
| `packages/api/tsconfig.json` | 31 | API TS config. |
| `packages/api/README.md` | 15 | API package notes. |
| `packages/db/src/schema.ts` | 508 | Drizzle schema source of truth. |
| `packages/db/src/index.ts` | 10 | DB connection/schema exports. |
| `packages/db/drizzle.config.ts` | 11 | Drizzle config. |
| `packages/db/drizzle/0000_big_stingray.sql` | 18 | Existing migration, appears stale/incomplete. |
| `packages/db/package.json` | 21 | DB package dependencies/scripts. |
| `packages/db/tsconfig.json` | 29 | DB TS config. |
| `packages/db/README.md` | 15 | DB package notes. |
| `packages/executor-storage-drizzle/src/adapter.ts` | 903 | Drizzle-backed executor storage adapter. |
| `packages/executor-storage-drizzle/src/index.ts` | 19 | Drizzle storage exports. |
| `packages/executor-storage-drizzle/package.json` | 17 | Storage package metadata. |
| `packages/executor-storage-file/src/adapter.ts` | 40 | File package adapter shim/delegation. |
| `packages/executor-storage-file/src/blob-store.ts` | 115 | SQLite blob store implementation. |
| `packages/executor-storage-file/src/index.ts` | 23 | File storage exports. |
| `packages/executor-storage-file/package.json` | 19 | Local `@executor-js/storage-file` package metadata. |
| `packages/sdk/src/api/http.ts` | 275 | Effect HttpApi contract. |
| `packages/sdk/src/api/schemas.ts` | 674 | Shared request/response schemas. |
| `packages/sdk/src/api/client.ts` | 117 | API client wrapper. |
| `packages/sdk/src/api/index.ts` | 3 | API exports. |
| `packages/sdk/src/routes.ts` | 34 | Shared route path helpers. |
| `packages/sdk/src/schema.ts` | 16 | Shared schema helpers. |
| `packages/sdk/src/index.ts` | 7 | SDK public exports. |
| `packages/sdk/src/a2a/executor.ts` | 356 | A2A agent execution and streaming bridge. |
| `packages/sdk/src/a2a/events.ts` | 132 | A2A event conversion/helpers. |
| `packages/sdk/src/a2a/history.ts` | 46 | A2A context history helpers. |
| `packages/sdk/src/a2a/agent_card.ts` | 32 | A2A agent card helpers. |
| `packages/sdk/src/a2a/effect/rest-handler.ts` | 243 | Effect REST handler for A2A. |
| `packages/sdk/src/a2a/effect/json-rpc-handler.ts` | 96 | Effect JSON-RPC handler for A2A. |
| `packages/sdk/src/a2a/effect/agent-card-handler.ts` | 44 | Agent card HTTP handler. |
| `packages/sdk/src/a2a/effect/shared.ts` | 97 | Shared A2A handler utilities. |
| `packages/sdk/src/a2a/effect/sse.ts` | 20 | SSE helpers. |
| `packages/sdk/src/a2a/effect/types.ts` | 9 | A2A Effect types. |
| `packages/sdk/src/a2a/effect/index.ts` | 4 | A2A Effect exports. |
| `packages/sdk/src/tools/a2a/operations.ts` | 136 | A2A tool operation definitions. |
| `packages/sdk/src/tools/a2a/registry.ts` | 74 | A2A tool registry. |
| `packages/sdk/src/tools/a2a/tools.ts` | 48 | A2A tool declarations. |
| `packages/sdk/src/tools/a2a/index.ts` | 3 | A2A tool exports. |
| `packages/sdk/src/tools/executor/tools.ts` | 36 | Executor tool declarations. |
| `packages/sdk/src/tools/executor/index.ts` | 1 | Executor tool exports. |
| `packages/sdk/src/tools/default.ts` | 11 | Default tool set exports. |
| `packages/sdk/src/tools/skills.ts` | 24 | Skill tool declarations. |
| `packages/sdk/src/tools/index.ts` | 4 | Tool exports. |
| `packages/sdk/src/workflows/executor.ts` | 338 | Workflow execution helpers. |
| `packages/sdk/src/workflows/index.ts` | 1 | Workflow exports. |
| `packages/sdk/package.json` | 27 | SDK package metadata. |
| `packages/sdk/tsconfig.json` | 32 | SDK TS config. |
| `packages/sdk/README.md` | 7 | SDK notes. |

## Recommended Refactor Order

1. Make DB schema single-source: remove or minimize `packages/api/src/db/init.ts`, align migrations/schema/bootstrap.
2. Split `packages/api/src/executor/service.ts` into executor lifecycle, source CRUD, auth/OAuth, tool policy, and tool factory modules.
3. Remove `@ts-nocheck` from storage adapters, starting with small typed boundary wrappers.
4. Split `packages/api/src/a2a/session-store.ts` into task persistence, context persistence, session projections, and eval projections.
5. Replace duplicated Zod schemas in `packages/api/src/mcp/server.ts` with shared SDK schemas or derived validators.
6. Add cache eviction/TTL for executor handles, task stores, context stores, and MCP sessions.
7. Encode all route IDs in SDK route helpers and use those helpers everywhere.
