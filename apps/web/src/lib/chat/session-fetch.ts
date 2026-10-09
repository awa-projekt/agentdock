import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as Stream from 'effect/Stream';

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * The fetch the A2A client runs on, backed by Effect's `HttpClient`, sending
 * the dashboard's session cookie along: the built-in assistant only answers
 * the signed-in admin.
 */
export const fetchWithSession: typeof fetch = (input, init) => {
  const request = new Request(input, init);
  return Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(HttpClientRequest.fromWeb(request));
      return new Response(NULL_BODY_STATUSES.has(response.status) ? null : Stream.toReadableStream(response.stream), {
        status: response.status,
        headers: new Headers(Object.entries(response.headers)),
      });
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { credentials: 'include' }),
    ),
    { signal: request.signal },
  );
};
