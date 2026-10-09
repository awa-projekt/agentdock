import { ServerFailures } from 'agentdock-sdk/api';
import { ApiFailure } from 'agentdock-sdk/schemas';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

/** The trace this request runs in, which is what an operator looks the failure up by. */
const currentTraceId: Effect.Effect<string> = Effect.currentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => 'untraced'),
);

const isUnexpected = <E>(cause: Cause.Cause<E>): boolean => Cause.hasDies(cause) && !Cause.hasFails(cause);

export const ServerFailuresLive = Layer.succeed(ServerFailures)((httpEffect) =>
  Effect.catchCauseIf(httpEffect, isUnexpected, (cause) =>
    Effect.logError('Unhandled request failure', cause).pipe(
      Effect.andThen(currentTraceId),
      Effect.flatMap((traceId) =>
        Effect.fail(new ApiFailure({ message: 'The server could not complete this request', traceId })),
      ),
    ),
  ),
);
