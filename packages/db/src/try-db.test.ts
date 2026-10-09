import { describe, expect, it } from '@effect/vitest';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import { tryDbWith } from './try-db';

class StoreError extends Data.TaggedError('StoreError')<{ readonly cause: unknown }> {}

const tryDb = tryDbWith((cause) => new StoreError({ cause }));

const statementFailing = (times: number, message: string) => {
  let attempts = 0;
  return {
    attempts: () => attempts,
    run: () =>
      tryDb(async () => {
        attempts += 1;
        if (attempts <= times) throw new Error(message);
        return 'ok';
      }),
  };
};

describe('tryDbWith', () => {
  it.live('retries a busy statement until it succeeds', () =>
    Effect.gen(function* () {
      const statement = statementFailing(2, 'SQLITE_BUSY: the database file is locked');
      expect(yield* statement.run()).toBe('ok');
      expect(statement.attempts()).toBe(3);
    }),
  );

  it.live('gives up after the busy backoff is exhausted', () =>
    Effect.gen(function* () {
      const statement = statementFailing(99, 'database is locked');
      yield* Effect.flip(statement.run());
      expect(statement.attempts()).toBe(6);
    }),
  );

  it.effect('fails a non-busy statement without retrying', () =>
    Effect.gen(function* () {
      const statement = statementFailing(99, 'no such table: item');
      const error = yield* Effect.flip(statement.run());
      expect(error).toBeInstanceOf(StoreError);
      expect(statement.attempts()).toBe(1);
    }),
  );
});
