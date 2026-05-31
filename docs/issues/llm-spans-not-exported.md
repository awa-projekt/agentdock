# LLM Spans From Vercel AI SDK Not Reaching Tempo

## Summary

The new in-app Traces view (`/traces`) shows A2A, HTTP, and Effect spans from Tempo, but the LLM-level spans that Vercel AI SDK emits when `experimental_telemetry.isEnabled` is `true` never arrive. Confirmed by inspecting `GET http://127.0.0.1:3200/api/search/tags?scope=span` — zero `ai.*` or `gen_ai.*` tag names are present, even after triggering an A2A `message/send` that ran `streamText` end-to-end.

## Root Cause

`@effect/opentelemetry/NodeSdk` constructs a local `NodeTracerProvider` and wires it into the Effect tracer service, but never calls `provider.register()`. Vercel AI SDK resolves its tracer through the standard `@opentelemetry/api` global (`trace.getTracer("ai")`), which without a registered provider returns a no-op tracer. As a result the AI SDK records nothing.

Relevant locations:
- `apps/server/src/observability.ts` — sets up `NodeSdk.layer({ spanProcessor: [...] })`, no global registration.
- `packages/sdk/src/a2a/executor.ts:145-164` — `streamText({ ..., experimental_telemetry: { isEnabled: true, recordInputs: true, recordOutputs: true, ... } })`.
- `@effect/opentelemetry/src/NodeSdk.ts` (beta.59) — `layerTracerProvider` builds the `NodeTracerProvider` but does not `.register()` it.

## Options

### Option A — Register a global tracer provider in `observability.ts`

Add a second small SDK init alongside the Effect layer that creates a `NodeTracerProvider` with the same OTLP exporter, calls `.register()`, and lets AI SDK find it. About 15 lines.

Sketch:

```ts
// apps/server/src/observability.ts
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

// inside ObservabilityLive setup, after building the exporter:
const globalProvider = new NodeTracerProvider({
  resource: /* same resource attributes */,
  spanProcessors: [new BatchSpanProcessor(nonFatalExporter(new OTLPTraceExporter({ url: otlpTraceEndpoint })))],
});
globalProvider.register();
```

Trade-offs:
- Pro: zero code changes inside the SDK; AI SDK spans (model, prompt, completion, finish reason, token usage) show up automatically with full `ai.*` attributes.
- Con: two parallel tracer providers in the process. Effect-managed spans and AI SDK spans live in separate trace trees unless context propagation is wired through. Acceptable for an MVP — they still land in Tempo on the same service.

### Option B — Emit `gen_ai.*` semconv attributes ourselves around `streamText`

In `packages/sdk/src/a2a/executor.ts`, wrap the `streamText` call with an `Effect.withSpan('agentdock.a2a.llm', { attributes: { ... } })` and after the stream completes, attach attributes following the OpenTelemetry GenAI semantic conventions:

- `gen_ai.system = "openai"` (or parsed from `this.model`)
- `gen_ai.request.model`
- `gen_ai.response.model`
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`
- A `gen_ai.content.prompt` / `gen_ai.content.completion` event for the inputs/outputs

Trade-offs:
- Pro: keeps a single tracer provider, spans nest cleanly under the surrounding A2A span, no dependency on AI SDK's internal telemetry quirks.
- Pro: gives us a stable schema the Traces view can target without chasing AI SDK changes.
- Con: ~30-50 lines in the executor; we own the data extraction (read `usage`, collect text deltas, capture finish reason from `fullStream`).

## Recommendation

Start with Option A for the immediate payoff — once we see AI SDK's `ai.*` attributes landing, decide whether to also do Option B for a clean schema. Both can coexist: Option A gives free fidelity, Option B gives a stable contract.

## Touchpoints If Pursued

- `apps/server/src/observability.ts` — global provider registration.
- `packages/sdk/src/a2a/executor.ts` — optional semconv wrapper.
- `apps/web/src/TracesView.tsx` — `LLM_ATTRIBUTE_KEYS` already covers both `ai.*` and `gen_ai.*`; no changes needed.
