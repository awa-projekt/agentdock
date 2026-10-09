# AGENTS.md

Use effect vitest and run tests via vitest not bun test

When testing against a real LLM, always use `openai:gpt-6-luna` with low reasoning effort. Only do bigger real model runs (other or larger models, higher reasoning effort, many calls) after verifying with the user.

Don't add any backwards compatibility shims for any changes.

Database migrations are managed with Drizzle Kit: edit `packages/db/src/schema.ts`, run `bun run db:generate` to create a migration, and it auto-applies on server start (or run `bun run db:reset` to rebuild locally). Commit the generated SQL and snapshot.

code is very cheap to write. do not give time estimates with agents code is practically instant to generate therefore unless stated otherwise time to implement is not a blocker

you have repos in .references like effect-smol, effect-atom. if you are given a git url clone it into that directory to explore it. if you need to know about good patterns look in there

Most of the time i have the dev server already running in a separate tmux pane, so check before trying to start one yourself.

ALWAYS kill your the dev server if you started one and are done with your task.

## Running the dev server

`bun run dev` starts the api and the dashboard together and prints both URLs. Ctrl-C stops both.

When you start a dev server in a worktree, use `bun run dev:no-auth` unless the task touches auth. A fresh
worktree database has no users, and every checkout shares the `127.0.0.1` session cookie, so logging into a
worktree dashboard logs you out of the main checkout.

Ports are derived from the checkout, never configured: the main checkout uses 38123/38124 and every
linked worktree hashes its own path into a stable pair of its own, so several checkouts can run at the
same time. Do not put ports in `.env` and do not pick free ports by hand.

- `bun run urls` prints both URLs, `--json` for machine use, `--ports` for `api,web`.
- `bun run kill` kills whatever still listens on this checkout's ports.
- `AGENTDOCK_PORT_BASE` pins the api port (the dashboard takes the next one) if you ever need to.

In a fresh worktree, before `bun run dev`: `bun install`, link the root env file
(`ln -s <main checkout>/.env .env`), and `bun run db:reset` once. The database is a cwd-relative file, so
each checkout already has its own.

Do not overwrite the minimum age when installing packages.

<!-- effect-solutions:start -->
## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.

## Local Effect Source

The Effect v4 repository is cloned to `~/.local/share/effect-solutions/effect` for reference.
Use this to explore APIs, find usage examples, and understand implementation details when the documentation isn't enough.
<!-- effect-solutions:end -->

## Lint

`bun run lint` runs Biome plus Oxlint and must stay clean; CI enforces it together with
`bun run typecheck`, `bun run knip` and `bun run test`. Oxlint's own `correctness`
category is off, so Biome owns general linting and Oxlint only hosts these plugins:

- `tools/oxlint/anti-slop` (vendored, replaced wholesale on upgrade; never edit) — rejects
  unparsed boundaries (`unknown` parameters/returns, `Record<string, unknown>`), runtime
  `typeof` narrowing, conditional empty-object spreads, widening, and type assertions
  without a `// SAFETY:` comment stating the checked invariant.
- `tools/oxlint/agentdock` (project-owned, each rule has a test that runs the real oxlint
  binary over a fixture):
  - `namespace-node-imports` — `import * as NodeFS from 'node:fs'` with the canonical alias
    (`NodeFSP`, `NodePath`, `NodeCrypto`, `NodeChildProcess`, …).
  - `no-inline-schema-compile` — `Schema.decodeUnknownSync(X)(input)` inside a function
    rebuilds the codec per call; hoist `const decodeX = Schema.decodeUnknownSync(X)` to
    module scope.
  - `no-manual-effect-runtime-in-tests` — tests use `@effect/vitest` (`it.effect`,
    `it.layer`), never `Effect.runPromise`/`runSync`/`ManagedRuntime.make`.
  - `no-workspace-service-constructor-imports` — extends the vendored Effect rule across
    workspace packages and the `@/*` alias; its package list is hardcoded, add new
    workspace packages to it.

Do not silence rules with disable comments or config changes; fix the code. The Effect
language-service diagnostics in `tsconfig.json` are part of `bun run typecheck` and follow
the same policy: `@effect-diagnostics` off-comments exist only at the ConfigProvider,
checkout-port derivation, drizzle-kit, vitest bootstrap and esbuild dev-server boundaries.
