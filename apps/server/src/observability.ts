import * as OtelTracer from '@effect/opentelemetry/OtelTracer';
import * as OtelResource from '@effect/opentelemetry/Resource';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import { TraceFile } from '@integragents/observability';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ObservabilityConfig, ObservabilityConfigLive } from 'api';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as HttpBody from 'effect/http/HttpBody';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as Layer from 'effect/Layer';
import * as References from 'effect/References';
import { traceFileSpanProcessor } from './trace-file-processor';

const traceFilePath = 'logs/api.trace.ndjson';

type ExportResult = {
  readonly code: number;
  readonly error?: Error;
};

const warnOnce = (message: string, cause?: unknown): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (warnOnce.didWarn) {
      return Effect.void;
    }
    warnOnce.didWarn = true;
    return Effect.logWarning(message, cause instanceof Error ? cause.message : (cause ?? ''));
  });
warnOnce.didWarn = false;

// Probe the collector with an empty export request. Interruption (including
// the timeout) tears the request down, so no manual AbortController is needed.
const checkCollector = (endpoint: string): Effect.Effect<void> =>
  HttpClient.execute(HttpClientRequest.post(endpoint, { body: HttpBody.uint8Array(new Uint8Array()) })).pipe(
    Effect.timeout('500 millis'),
    Effect.asVoid,
    Effect.tapError((error) =>
      warnOnce(`[otel] Collector is not reachable at ${endpoint}; trace export failures will be ignored.`, error),
    ),
    Effect.catchCause(() => Effect.void),
    Effect.provide(NodeHttpClient.layerUndici),
  );

const nonFatalExporter = (delegate: SpanExporter): SpanExporter => ({
  export: (spans: ReadableSpan[], resultCallback: (result: ExportResult) => void) => {
    try {
      delegate.export(spans, (result) => {
        if (result.code !== 0) {
          Effect.runFork(
            warnOnce('[otel] Trace export failed; further export failures will be ignored.', result.error),
          );
          resultCallback({ code: 0 });
          return;
        }

        resultCallback(result);
      });
    } catch (error) {
      Effect.runFork(warnOnce('[otel] Trace export threw; further export failures will be ignored.', error));
      resultCallback({ code: 0 });
    }
  },
  shutdown: async () => {
    try {
      await delegate.shutdown();
    } catch (error) {
      Effect.runFork(warnOnce('[otel] Trace exporter shutdown failed; ignoring.', error));
    }
  },
  forceFlush: async () => {
    try {
      await delegate.forceFlush?.();
    } catch (error) {
      Effect.runFork(warnOnce('[otel] Trace exporter flush failed; ignoring.', error));
    }
  },
});

const TracingLive = Layer.unwrap(
  Effect.gen(function* () {
    const { otlpTraceEndpoint, serviceName } = yield* ObservabilityConfig;
    const traceFile = yield* TraceFile;
    const exporters = otlpTraceEndpoint
      ? [new BatchSpanProcessor(nonFatalExporter(new OTLPTraceExporter({ url: otlpTraceEndpoint })))]
      : [];

    // One tracer provider for the whole process: registered globally so non-Effect
    // code resolving tracers via @opentelemetry/api reaches the trace file and the
    // exporter too, and consumed by Effect's tracer via OtelTracer.layerGlobal.
    // register() also installs the AsyncLocalStorage context manager that
    // propagates span parents across the Effect/Promise boundary.
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({ 'service.name': serviceName }),
      spanProcessors: [traceFileSpanProcessor(serviceName, traceFile), ...exporters],
    });
    provider.register();

    const ProviderShutdownLive = Layer.effectDiscard(
      Effect.addFinalizer(() =>
        Effect.tryPromise(() => provider.shutdown()).pipe(Effect.catchCause(() => Effect.void)),
      ),
    );

    // Probe the collector during layer construction: startup waits for the
    // result (at most 500ms), and by then module loading no longer blocks the
    // event loop, so a running collector answers well within the timeout.
    const CollectorCheckLive = otlpTraceEndpoint ? Layer.effectDiscard(checkCollector(otlpTraceEndpoint)) : Layer.empty;

    return Layer.mergeAll(
      OtelTracer.layerGlobal.pipe(Layer.provide(OtelResource.layer({ serviceName }))),
      ProviderShutdownLive,
      CollectorCheckLive,
    );
  }),
).pipe(
  Layer.provide(TraceFile.layer(traceFilePath)),
  Layer.provide(Layer.mergeAll(ObservabilityConfigLive, NodeFileSystem.layer)),
);

const LogLevelLive = Layer.unwrap(
  Effect.map(Config.LogLevel('AGENTDOCK_LOG_LEVEL').pipe(Config.withDefault('Info')), (level) =>
    Layer.succeed(References.MinimumLogLevel, level),
  ),
);

/** Every span lands in the trace file and, with an OTLP endpoint, the collector; logs below the level are dropped. */
export const ObservabilityLive = Layer.mergeAll(TracingLive, LogLevelLive);
