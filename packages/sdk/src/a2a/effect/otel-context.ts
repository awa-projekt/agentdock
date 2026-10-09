import { type Context, context as otelContext, trace as otelTrace, TraceFlags } from '@opentelemetry/api';
import * as Effect from 'effect/Effect';

/**
 * Capture an OpenTelemetry context that carries the current Effect span, so
 * non-Effect code (e.g. the Vercel AI SDK resolving its tracer through the
 * @opentelemetry/api global) parents its spans under the surrounding request
 * span. Falls back to the active context when no Effect span is present.
 */
export const currentOtelContext: Effect.Effect<Context> = Effect.currentSpan.pipe(
  Effect.map((span) =>
    otelTrace.setSpanContext(otelContext.active(), {
      traceId: span.traceId,
      spanId: span.spanId,
      traceFlags: TraceFlags.SAMPLED,
    }),
  ),
  Effect.catch(() => Effect.succeed(otelContext.active())),
);

export const runWithOtelContext = <T>(context: Context, fn: () => T): T => otelContext.with(context, fn);

/**
 * Wrap an async iterable so every pull runs inside the given OTel context.
 * The a2a request handler starts agent execution lazily on the first pull,
 * outside the Effect span scope — without this, LLM spans would start new
 * root traces instead of nesting under the a2a transport span.
 */
export const iterateWithOtelContext = <T>(context: Context, source: AsyncIterable<T>): AsyncIterable<T> => ({
  [Symbol.asyncIterator]() {
    const iterator = source[Symbol.asyncIterator]();
    const wrapped: AsyncIterator<T> = {
      next: (...args) => otelContext.with(context, () => iterator.next(...args)),
    };
    if (iterator.return) {
      wrapped.return = (value) => otelContext.with(context, () => iterator.return!(value));
    }
    if (iterator.throw) {
      wrapped.throw = (error) => otelContext.with(context, () => iterator.throw!(error));
    }
    return wrapped;
  },
});
