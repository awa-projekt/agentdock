import type { ChangedResource, ServerEvent } from 'agentdock-sdk/schemas';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as PubSub from 'effect/PubSub';
import * as Stream from 'effect/Stream';

const COALESCE_WINDOW = '100 millis';
const COALESCE_LIMIT = 512;

export type ChangeFeedService = {
  readonly publish: (...resources: ReadonlyArray<ChangedResource>) => Effect.Effect<void>;
  /** Publishes once the effect ends, however it ends: a failed write may still have written part of its change. */
  readonly touches: (
    ...resources: ReadonlyArray<ChangedResource>
  ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly events: Stream.Stream<ServerEvent>;
};

export const ChangeFeed = Context.Service<ChangeFeedService>('@agentdock/api/ChangeFeed');

export const ChangeFeedLive = Layer.effect(
  ChangeFeed,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<ChangedResource>();
    const publish = (...resources: ReadonlyArray<ChangedResource>) =>
      PubSub.publishAll(pubsub, resources).pipe(Effect.asVoid);

    return ChangeFeed.of({
      publish,
      touches:
        (...resources) =>
        (self) =>
          Effect.ensuring(self, publish(...resources)),
      events: Stream.unwrap(
        Effect.map(PubSub.subscribe(pubsub), (subscription) =>
          Stream.fromSubscription(subscription).pipe(
            Stream.groupedWithin(COALESCE_LIMIT, COALESCE_WINDOW),
            Stream.filter((resources) => resources.length > 0),
            Stream.map((resources): ServerEvent => ({ _tag: 'Changed', resources: [...new Set(resources)] })),
            Stream.prepend([{ _tag: 'Subscribed' } satisfies ServerEvent]),
          ),
        ),
      ),
    });
  }),
);
