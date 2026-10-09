import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

export type DbErrorFactory<E> = (cause: unknown) => E;

type DbAttemptFailure = { readonly cause: unknown; readonly busy: boolean };

/**
 * SQLite serializes writers process-wide, so a statement issued while another
 * process holds the write lock fails with `SQLITE_BUSY` once the connection's
 * busy timeout elapses. Every such failure is transient: retrying the statement
 * after a short backoff is the documented remedy.
 */
const busyBackoff = Schedule.exponential('25 millis');
const BUSY_RETRIES = 5;

/** Flattens an error and its `cause` chain into one message, the form sqlite drivers need to be read through. */
export const causeMessage = (cause: unknown): string => {
  if (!(cause instanceof Error)) return String(cause);
  return cause.cause === undefined ? cause.message : `${cause.message}; cause: ${causeMessage(cause.cause)}`;
};

const isBusy = (cause: unknown): boolean => {
  const message = causeMessage(cause);
  return message.includes('SQLITE_BUSY') || message.includes('database is locked');
};

/**
 * Runs a database statement as an Effect, retrying the transient busy failures
 * and mapping anything else onto the caller's domain error.
 */
export const tryDbWith =
  <E>(makeError: DbErrorFactory<E>) =>
  <A>(statement: () => Promise<A>): Effect.Effect<A, E> =>
    Effect.tryPromise({
      try: statement,
      catch: (cause): DbAttemptFailure => ({ cause, busy: isBusy(cause) }),
    }).pipe(
      Effect.retry({ schedule: busyBackoff, times: BUSY_RETRIES, while: (failure) => failure.busy }),
      Effect.mapError((failure) => makeError(failure.cause)),
    );
