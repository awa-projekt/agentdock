import * as Schema from 'effect/Schema';

/** A request the server could not complete; the trace id finds its spans and logs. */
export class ApiFailure extends Schema.TaggedError<ApiFailure>()('ApiFailure', {
  message: Schema.String,
  traceId: Schema.String,
}) {}

export const describeApiFailure = (failure: ApiFailure): string => `${failure.message} (trace ${failure.traceId})`;
