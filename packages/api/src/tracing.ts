import * as Effect from 'effect/Effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';

export const withHttpRootSpan =
  <A, E, R>(spanName: string) =>
  (effect: Effect.Effect<A, E, R | HttpServerRequest.HttpServerRequest>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const pathname = new URL(request.url, 'http://localhost').pathname;

      yield* Effect.annotateCurrentSpan({
        'http.request.method': request.method.toUpperCase(),
        'url.full': request.url,
        'url.path': pathname,
      });

      return yield* effect;
    }).pipe(Effect.withSpan(spanName));
