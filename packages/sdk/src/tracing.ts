import type * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as Stream from 'effect/Stream';

const nullBodyStatuses = new Set([101, 103, 204, 205, 304]);

/**
 * A `fetch` for libraries that insist on one, backed by the context's
 * `HttpClient`: each request is a client span under the span current in
 * `context` and carries its trace headers.
 */
export const httpClientFetch =
  (context: Context.Context<HttpClient.HttpClient>): typeof fetch =>
  (input, init) => {
    const request = new Request(input, init);
    return Effect.runPromiseWith(context)(
      Effect.gen(function* () {
        const response = yield* HttpClient.execute(HttpClientRequest.fromWeb(request));
        const body = nullBodyStatuses.has(response.status)
          ? null
          : yield* Stream.toReadableStreamEffect(response.stream);
        return new Response(body, { status: response.status, headers: response.headers });
      }),
      { signal: request.signal },
    );
  };
