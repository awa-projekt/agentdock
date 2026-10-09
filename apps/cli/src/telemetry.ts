import * as NodeOS from 'node:os';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { recordingTracer, TraceFile } from '@integragents/observability';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import * as Tracer from 'effect/Tracer';
import { optionalSetting } from './project';

const traceFilePath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const stateHome = Option.getOrElse(yield* optionalSetting('XDG_STATE_HOME'), () =>
    path.join(NodeOS.homedir(), '.local', 'state'),
  );
  return path.join(stateHome, 'agentdock', 'cli.trace.ndjson');
});

/** Every span of an invocation lands in the CLI trace file; the API continues the same trace. */
export const TelemetryLive = Layer.unwrap(
  Effect.map(traceFilePath, (path) =>
    Layer.effect(
      Tracer.Tracer,
      Effect.gen(function* () {
        const file = yield* TraceFile;
        return recordingTracer(Tracer.nativeTracer, 'agentdock-cli', file.record);
      }),
    ).pipe(Layer.provideMerge(TraceFile.layer(path))),
  ),
).pipe(Layer.provide(NodeServices.layer));

/** Names the invocation by its subcommand only; arguments and flag values can carry secrets. */
export const commandSpan = (argv: ReadonlyArray<string>) =>
  Effect.withSpan('Cli.command', {
    attributes: { 'cli.command': argv.find((argument) => !argument.startsWith('-')) ?? '' },
  });

export const flushTraces = Effect.gen(function* () {
  const file = yield* TraceFile;
  yield* file.flush;
});
