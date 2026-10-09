import { assert, describe } from '@effect/vitest';

import { oxlintRuleHarness } from '../test/harness.ts';

const rule = oxlintRuleHarness('agentdock/no-inline-schema-compile');

describe('agentdock/no-inline-schema-compile', () => {
  rule.valid(
    'allows schema compilers hoisted to module scope',
    `
      import * as Schema from 'effect/Schema';

      const User = Schema.Struct({ name: Schema.String });
      const decodeUser = Schema.decodeUnknownEffect(User);

      export const parseUser = (input: unknown) => decodeUser(input);
    `,
  );

  rule.valid(
    'allows factory helpers that return a precompiled decoder',
    `
      import * as Schema from 'effect/Schema';

      export const makeParser = <A, I>(schema: Schema.Codec<A, I>) => {
        const decode = Schema.decodeUnknownEffect(schema);
        return (input: unknown) => decode(input);
      };
    `,
  );

  rule.valid(
    'allows compilers over schema parameters',
    `
      import * as Schema from 'effect/Schema';

      export const parseWith = <A, I>(schema: Schema.Codec<A, I>, input: unknown) =>
        Schema.decodeUnknownEffect(schema)(input);
    `,
  );

  rule.invalid(
    'reports schema compilers inside function bodies',
    `
      import * as Schema from 'effect/Schema';

      const User = Schema.Struct({ name: Schema.String });

      export const parseUser = (input: unknown) => Schema.decodeUnknownEffect(User)(input);
    `,
    (output) => {
      assert.match(output, /Hoist Schema\.decodeUnknownEffect/);
    },
  );

  rule.invalid(
    'reports inline schema literals',
    `
      import * as Schema from 'effect/Schema';

      export const parseUser = (input: unknown) =>
        Schema.decodeUnknownEffect(Schema.Struct({ name: Schema.String }))(input);
    `,
    (output) => {
      assert.match(output, /inline schema literal and the compiled function/);
    },
  );

  rule.invalid(
    'reports compilers over namespace members inside generators',
    `
      import * as Effect from 'effect/Effect';
      import * as Schema from 'effect/Schema';
      import * as Schemas from './schemas';

      export const load = Effect.gen(function* () {
        return yield* Schema.decodeUnknownEffect(Schemas.User)({});
      });
    `,
  );
});
