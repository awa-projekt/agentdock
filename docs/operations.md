# Operations

## Server

Run the API server with:

```bash
bun run api
```

In the main checkout the API is reached at `http://127.0.0.1:38123` (linked worktrees get their own port; `bun run urls` prints it). The server binds to `127.0.0.1` unless `AGENTDOCK_SERVER_HOST` says otherwise (set it to `0.0.0.0` to reach the API and web UI from other machines; the web server reads `AGENTDOCK_WEB_HOST`, falling back to `AGENTDOCK_SERVER_HOST`), writes log files under `logs/`, and exposes MCP at `/mcp` for external clients (OAuth, admins only) and at `/mcp/internal` for the built-in assistant (a token issued at startup).

## Web UI

Run the web UI with:

```bash
bun run web
```

The UI listens on the port after the API's, `http://127.0.0.1:38124` in the main checkout. It only serves the UI; the browser calls the API directly.

## Observability

The server registers a single global tracer provider, so Effect spans and the spans libraries emit through `@opentelemetry/api` (LangChain/LangGraph through AgentDock's `agentdock.langgraph.*` callback spans, better-auth) share one pipeline and stitch into one trace per request.

- **Spans** are always appended to `logs/api.trace.ndjson`, one finished span per line, with or without a collector.
- **Logs** go to the console and `logs/api.log`. A log emitted inside a span is also stored on that span as an event, so it lands in the trace file with the span's `traceId`.
- **OTLP export** switches on when `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) is set.
- **The CLI** appends its spans to `$XDG_STATE_HOME/agentdock/cli.trace.ndjson` (default `~/.local/state`) and sends `traceparent` to the API, so one command is one trace across both files. Server-side A2A calls (triggers, workflow agent steps) propagate the same way.
- **Failures:** an API request that fails unexpectedly answers `500` with an `ApiFailure` carrying the request's `traceId`. The dashboard and the CLI print it as `(trace <id>)`.

Trace files rotate at 10 MiB and five older files are kept (`.1` … `.5`). The health check at `/` is not traced.

| Variable | Effect |
| --- | --- |
| `AGENTDOCK_LOG_LEVEL` | Minimum level for console logs and span events (`Debug`, `Info` (default), `Warn`, `Error`, …) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL of an OTLP/HTTP collector; `/v1/traces` is appended |
| `OTEL_SERVICE_NAME` | Service name on exported spans and trace file records (default `agentdock-api`) |

### Reading trace files

Each line is a `TraceRecord` from `@integragents/observability`: `service`, `name`, `kind`, `traceId`, `spanId`, `parentSpanId`, `start`, `durationMs`, `outcome` (`success`, `failure` or `interrupted`), `cause` (the pretty-printed cause or exception stack when the span failed), `attributes`, and `events` (logs, with `attributes["effect.logLevel"]`).

```sh
# Everything one request or command did, across CLI and API
jq -c --arg t <traceId> 'select(.traceId == $t) | {service, name, durationMs, outcome}' \
  logs/api.trace.ndjson ~/.local/state/agentdock/cli.trace.ndjson

# Why it failed
jq -r --arg t <traceId> 'select(.traceId == $t and .outcome == "failure") | .name + "\n" + .cause' logs/api.trace.ndjson

# Recent failures of any kind
jq -c 'select(.outcome == "failure") | {start, name, traceId, cause: .cause[0:200]}' logs/api.trace.ndjson | tail

# Warnings and errors logged inside spans
jq -c '.events[] | select(.attributes["effect.logLevel"] | IN("WARN", "ERROR")) | {time, name}' logs/api.trace.ndjson | tail

# Slowest spans
jq -s -c 'sort_by(-.durationMs) | .[0:10][] | {name, durationMs, traceId}' logs/api.trace.ndjson

# LLM calls with their model and duration
jq -c 'select(.name == "agentdock.langgraph.llm") | {name, model: .attributes["gen_ai.request.model"], durationMs}' logs/api.trace.ndjson | tail
```

The trace file holds the same attributes as the exported spans, including prompts and completions (`gen_ai.*` attributes) on `agentdock.langgraph.llm` spans. Request headers are recorded with `authorization` and `cookie` redacted.

### Adding spans and logs

- **Name spans `Service.method`**, e.g. `TriggerDispatcher.dispatch`, with `Effect.fn('Service.method')`. HTTP spans are named by the server (`GET /agents/:agentId`) and the client (`http.client POST`).
- **Put spans at boundaries**, not around every helper: API and MCP entry points, store calls, upstream calls, CLI commands.
- **Attach identifiers as attributes** with `Effect.annotateCurrentSpan`, using dotted keys such as `agent.id`, `workflow.id` and `trigger.id`. Never attach secrets or argument values.
- **Log with `Effect.logInfo` / `logWarning` / `logError` inside the span it belongs to**, so the log reaches the trace file. Put an error's tag in `Effect.annotateLogs({ 'error.tag': … })`.
- **Libraries that only accept a `fetch`** get `httpClientFetch(context)` from `agentdock-sdk`, which sends through the context's `HttpClient` and so gets a client span and trace headers. `tracedA2aClientFactory` builds an A2A client on it.

### Collector, Tempo, Grafana and Langfuse

The repository includes Docker configuration for a local collector, Tempo, Grafana, and Langfuse under `docker/`. Start it with:

```bash
docker compose -f docker/compose.yaml up -d
```

It publishes the collector on `4317`/`4318`, Tempo on `3200`, Grafana on `3301`, Langfuse on `3000` and MinIO on `9090`/`9091`. All of it uses fixed development credentials and Grafana grants anonymous admin access, so keep it on a development machine. Typical local observability flow:

```text
AgentDock server -> OpenTelemetry collector -> Tempo -> Grafana   (all traces)
                                            -> Langfuse           (LLM spans only)
```

The collector fans out: Tempo receives every span, while a filter forwards only AgentDock's LangGraph spans (`agentdock.langgraph.chain`, `.llm` and `.tool.*`) to Langfuse for LLM-specific analysis (prompts, completions, token usage, cost). Each agent run's root `agentdock.langgraph.chain` span becomes the Langfuse trace. All ports of the compose stack are published on `127.0.0.1` only, since its credentials are throwaway defaults and Grafana allows anonymous admin access. The Langfuse dev project is auto-provisioned by compose (`pk-lf-agentdock-dev` / `sk-lf-agentdock-dev`, login `dev@agentdock.local` / `agentdock-dev` at `http://localhost:3000`); override the keys with `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`.

The web UI's `/traces` view and the `/traces` API endpoints are read from Tempo (`TEMPO_URL`, default `http://127.0.0.1:3200`) and are scoped to agent, workflow, tool, and LLM activity (`agentdock.a2a.*`, `agentdock.workflow.*`, `agentdock.tools.*` and `agentdock.langgraph.*` spans). Without Tempo running the view stays empty. Full application traces are inspected in Grafana at `http://localhost:3301`.

## Database Reset

Drizzle migrations apply on server start. If local data is still incompatible with the current schema, reset it; the reset re-seeds the sample agents:

```bash
bun run db:reset
```

## Docs Deployment

MkDocs is configured at the repository root with `mkdocs.yml`. It needs Python with `mkdocs-material` and `pymdown-extensions`. Build locally with:

```bash
pip install mkdocs-material pymdown-extensions
mkdocs build --strict   # writes the site to public/
mkdocs serve            # live preview at http://127.0.0.1:13400
```

`.gitlab-ci.yml` contains a GitLab Pages job that runs the same build on the default branch and publishes `public/`.

## Security Notes

- Do not commit `.env` files or provider secrets.
- Provider key APIs should return metadata only, not secret values.
- OAuth callback and credential flows should be tested against the API server URL used by the web UI proxy.
