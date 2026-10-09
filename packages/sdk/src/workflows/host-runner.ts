import * as Effect from 'effect/Effect';

export interface HostRunner<R> {
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, R>) => Promise<A>;
}

/**
 * Captures the current services so plain-promise callbacks handed to LangGraph
 * (graph nodes, checkpoint hooks, executor options) can discharge Effects on
 * the host runtime without the artifact knowing Effect exists.
 */
export const hostRunner = <R = never>(): Effect.Effect<HostRunner<R>, never, R> =>
  Effect.map(Effect.context<R>(), (context) => ({
    runPromise: (effect) => Effect.runPromiseWith(context)(effect),
  }));
