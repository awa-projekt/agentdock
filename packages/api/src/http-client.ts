import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import type * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Schema from 'effect/Schema';

/** Non-2xx response from {@link getJson}, carrying the status and body for diagnostics. */
export class HttpStatusError extends Schema.TaggedError<HttpStatusError>()('HttpStatusError', {
  url: Schema.String,
  status: Schema.Number,
  body: Schema.String,
}) {}

const filterOk = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300
    ? Effect.succeed(response)
    : Effect.flatMap(response.text.pipe(Effect.orElseSucceed(() => '')), (body) =>
        Effect.fail(new HttpStatusError({ url: response.request.url, status: response.status, body })),
      );

/**
 * Fetch a JSON document over the Effect {@link HttpClient} service.
 *
 * Fails with an `HttpClientError` or {@link HttpStatusError} on transport
 * failures or non-2xx responses. Requires an `HttpClient` in context — provided
 * once at the api layer root via `FetchHttpClient.layer` (see `handlers.ts`).
 * The parsed body is returned untyped; callers narrow it to their expected
 * shape.
 *
 * Prefer this over raw `fetch` so the network dependency is explicit in the
 * effect's requirements and picks up the shared tracing policy.
 */
export const getJson = (url: string, options?: { readonly headers?: Record<string, string> }) =>
  HttpClient.get(url, options).pipe(
    Effect.flatMap(filterOk),
    Effect.flatMap((response) => response.json),
  );
