import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import { jsonFlag, type OutputOptions, verboseFlag } from './output';

const parsed = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const seen: Array<OutputOptions> = [];
    const probe = Command.make('probe', { json: jsonFlag, verbose: verboseFlag }, (options) =>
      Effect.sync(() => void seen.push(options)),
    );
    yield* Command.runWith(probe, { version: '0.0.0' })(args);
    return seen;
  }).pipe(Effect.provide(NodeServices.layer));

describe('output flags', () => {
  it.effect('are off when omitted', () =>
    Effect.gen(function* () {
      expect(yield* parsed([])).toEqual([{ json: false, verbose: false }]);
    }),
  );

  it.effect('turn on when given', () =>
    Effect.gen(function* () {
      expect(yield* parsed(['--json', '-v'])).toEqual([{ json: true, verbose: true }]);
    }),
  );
});
