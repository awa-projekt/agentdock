import * as NodeSdk from '@effect/opentelemetry/NodeSdk';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { Layer } from 'effect';

type ExportResult = {
  readonly code: number;
  readonly error?: Error;
};

const optionalEnv = (name: string): string | null => process.env[name] ?? null;

const resolveOtlpTraceEndpoint = (): string | null => {
  const tracesEndpoint = optionalEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT');

  if (tracesEndpoint) {
    return tracesEndpoint;
  }

  const baseEndpoint = optionalEnv('OTEL_EXPORTER_OTLP_ENDPOINT');

  if (baseEndpoint) {
    return `${baseEndpoint.replace(/\/$/, '')}/v1/traces`;
  }

  return null;
};

const warnOnce = (message: string, error?: unknown): void => {
  if (warnOnce.didWarn) {
    return;
  }
  warnOnce.didWarn = true;
  console.warn(message, error instanceof Error ? error.message : error ?? '');
};
warnOnce.didWarn = false;

const checkCollectorOnce = (endpoint: string): void => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);

  void fetch(endpoint, {
    method: 'POST',
    body: new Uint8Array(),
    signal: controller.signal,
  })
    .catch((error) => {
      warnOnce(`[otel] Collector is not reachable at ${endpoint}; trace export failures will be ignored.`, error);
    })
    .finally(() => clearTimeout(timeout));
};

const nonFatalExporter = (delegate: SpanExporter): SpanExporter => ({
  export: (spans: ReadableSpan[], resultCallback: (result: ExportResult) => void) => {
    try {
      delegate.export(spans, (result) => {
        if (result.code !== 0) {
          warnOnce('[otel] Trace export failed; further export failures will be ignored.', result.error);
          resultCallback({ code: 0 });
          return;
        }

        resultCallback(result);
      });
    } catch (error) {
      warnOnce('[otel] Trace export threw; further export failures will be ignored.', error);
      resultCallback({ code: 0 });
    }
  },
  shutdown: async () => {
    try {
      await delegate.shutdown();
    } catch (error) {
      warnOnce('[otel] Trace exporter shutdown failed; ignoring.', error);
    }
  },
  forceFlush: async () => {
    try {
      await delegate.forceFlush?.();
    } catch (error) {
      warnOnce('[otel] Trace exporter flush failed; ignoring.', error);
    }
  },
});

export const ObservabilityLive = (() => {
  const otlpTraceEndpoint = resolveOtlpTraceEndpoint();
  if (!otlpTraceEndpoint) {
    return Layer.empty;
  }

  checkCollectorOnce(otlpTraceEndpoint);

  const serviceName = optionalEnv('OTEL_SERVICE_NAME') ?? 'agentdock-api';

  return NodeSdk.layer(() => ({
    resource: { serviceName },
    spanProcessor: [new BatchSpanProcessor(nonFatalExporter(new OTLPTraceExporter({ url: otlpTraceEndpoint })))],
  }));
})();
