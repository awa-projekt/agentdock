import { assert, describe } from '@effect/vitest';

import { oxlintRuleHarness } from '../test/harness.ts';

const rule = oxlintRuleHarness('agentdock/no-manual-effect-runtime-in-tests', { filename: 'fixture.test.ts' });

describe('agentdock/no-manual-effect-runtime-in-tests', () => {
  rule.valid(
    'allows @effect/vitest effect tests',
    `
      import { it } from '@effect/vitest';
      import * as Effect from 'effect/Effect';

      it.effect('runs an Effect', () => Effect.succeed('ok'));
    `,
  );

  for (const method of ['runPromise', 'runSync', 'runFork', 'runPromiseExit', 'runCallback'] as const) {
    rule.invalid(
      `reports Effect.${method}`,
      `
        import * as Effect from 'effect/Effect';

        test('runs an Effect', () => {
          Effect.${method}(Effect.succeed('ok'));
        });
      `,
      (output) => {
        assert.match(output, /Use @effect\/vitest with it\.effect/);
      },
    );
  }

  rule.invalid(
    'reports ManagedRuntime.make',
    `
      import * as Layer from 'effect/Layer';
      import * as ManagedRuntime from 'effect/ManagedRuntime';

      test('makes a runtime', () => {
        ManagedRuntime.make(Layer.empty);
      });
    `,
  );
});

const productionRule = oxlintRuleHarness('agentdock/no-manual-effect-runtime-in-tests');

describe('agentdock/no-manual-effect-runtime-in-tests outside tests', () => {
  productionRule.valid(
    'allows production runtime boundaries',
    `
      import * as Effect from 'effect/Effect';

      export const main = () => Effect.runPromise(Effect.void);
    `,
  );
});
