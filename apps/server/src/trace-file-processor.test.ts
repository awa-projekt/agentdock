import * as OtelTracer from '@effect/opentelemetry/OtelTracer';
import * as OtelResource from '@effect/opentelemetry/Resource';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { describe, expect, it } from '@effect/vitest';
import { TraceFile, TraceRecord } from '@integragents/observability';
import { SpanStatusCode } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import * as Schema from 'effect/Schema';
import { traceFileSpanProcessor } from './trace-file-processor';

const decodeRecords = Schema.decodeUnknownEffect(Schema.Array(Schema.fromJsonString(TraceRecord)));

const recordNamed = (records: ReadonlyArray<TraceRecord>, name: string) =>
  records.find((record) => record.name === name);

describe('traceFileSpanProcessor', () => {
  it.effect('writes Effect and OpenTelemetry spans, their logs, and their failures to the trace file', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = `${yield* fs.makeTempDirectoryScoped()}/api.trace.ndjson`;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const traceFile = yield* TraceFile;
          const provider = new BasicTracerProvider({
            spanProcessors: [traceFileSpanProcessor('agentdock-test', traceFile)],
          });
          const tracing = OtelTracer.layer.pipe(
            Layer.provide(Layer.succeed(OtelTracer.OtelTracerProvider, provider)),
            Layer.provide(OtelResource.layer({ serviceName: 'agentdock-test' })),
          );

          yield* Effect.logInfo('inside the child').pipe(
            Effect.withSpan('Test.child', { attributes: { 'agent.id': 'assistant' } }),
            Effect.withSpan('Test.parent'),
            Effect.provide(Layer.merge(tracing, Logger.layer([Logger.tracerLogger]))),
          );
          yield* Effect.fail('upstream refused').pipe(
            Effect.withSpan('Test.failing'),
            Effect.ignore,
            Effect.provide(tracing),
          );

          const library = provider.getTracer('ai').startSpan('ai.generateText', { attributes: { 'ai.model.id': 'm' } });
          library.recordException(new Error('rate limited'));
          library.setStatus({ code: SpanStatusCode.ERROR, message: 'rate limited' });
          library.end();

          yield* traceFile.flush;
        }).pipe(Effect.provide(TraceFile.layer(path))),
      );

      const lines = (yield* fs.readFileString(path)).trim().split('\n');
      const records = yield* decodeRecords(lines);
      const parent = recordNamed(records, 'Test.parent');

      expect(recordNamed(records, 'Test.child')).toMatchObject({
        service: 'agentdock-test',
        traceId: parent?.traceId,
        parentSpanId: parent?.spanId,
        outcome: 'success',
        attributes: { 'agent.id': 'assistant' },
        events: [{ name: 'inside the child' }],
      });
      expect(recordNamed(records, 'Test.failing')).toMatchObject({ outcome: 'failure' });
      expect(recordNamed(records, 'Test.failing')?.cause).toContain('upstream refused');
      expect(recordNamed(records, 'ai.generateText')).toMatchObject({
        outcome: 'failure',
        attributes: { 'ai.model.id': 'm' },
        events: [],
      });
      expect(recordNamed(records, 'ai.generateText')?.cause).toContain('rate limited');
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
});
