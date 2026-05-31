import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { Effect, Layer } from 'effect';
import { AgentExecutorRegistry } from './service';
import { withHttpRootSpan } from '../tracing';

const popupHtml = (payload: Record<string, unknown>, ok: boolean, targetOrigin: string): string => `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>OAuth ${ok ? 'complete' : 'failed'}</title></head>
  <body>
    <p>${ok ? 'OAuth complete. You can close this window.' : 'OAuth failed. You can close this window.'}</p>
    <script>
      window.opener?.postMessage(${JSON.stringify({ type: 'agentdock:oauth-result', ok, payload })}, ${JSON.stringify(targetOrigin)});
      window.close();
    </script>
  </body>
</html>`;

export const ExecutorOAuthCallbackRoute = HttpRouter.add(
  'GET',
  '/oauth/callback',
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost:38123'}`);
    const agentId = url.searchParams.get('agentId');
    const state = url.searchParams.get('state');
    const webOrigin = url.searchParams.get('webOrigin') ?? `${url.protocol}//${url.host}`;
    const code = url.searchParams.get('code') ?? undefined;
    const error = url.searchParams.get('error') ?? undefined;

    if (!agentId || !state) {
      return HttpServerResponse.text(
        popupHtml({ error: 'Missing agentId or state' }, false, webOrigin),
        { contentType: 'text/html; charset=utf-8', status: 400 },
      );
    }

    const registry = yield* AgentExecutorRegistry;
    const result = yield* registry.completeOAuth(agentId, { state, ...(code ? { code } : {}), ...(error ? { error } : {}) }).pipe(
      Effect.map((payload) => ({ ok: true as const, payload })),
      Effect.catch((cause) => Effect.succeed({ ok: false as const, payload: { error: cause instanceof Error ? cause.message : String(cause) } })),
    );

    return HttpServerResponse.text(popupHtml(result.payload, result.ok, webOrigin), {
      contentType: 'text/html; charset=utf-8',
      status: result.ok ? 200 : 400,
    });
  }).pipe(
    Effect.withSpan('agentdock.executor.oauth.callback'),
    withHttpRootSpan('agentdock.http.request.executor.oauth.callback'),
  ),
);

export const AgentExecutorRoutes = Layer.mergeAll(ExecutorOAuthCallbackRoute);
