import { OAuthFlowSessions } from '@integragents/gateway-core';
import type { JsonObject } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Layer from 'effect/Layer';
import { ServerConfig } from '../config';
import { ChangeFeed } from '../events/service';
import { withHttpRootSpan } from '../tracing';

const popupHtml = (payload: JsonObject, ok: boolean, targetOrigin: string): string => `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>OAuth ${ok ? 'complete' : 'failed'}</title></head>
  <body>
    <p>${ok ? 'Account connected. You can close this window.' : 'Authorization failed. You can close this window.'}</p>
    <script>
      window.opener?.postMessage(${JSON.stringify({ type: 'agentdock:oauth-result', ok, payload })}, ${JSON.stringify(targetOrigin)});
      window.close();
    </script>
  </body>
</html>`;

const html = (body: string, status: number) =>
  HttpServerResponse.text(body, { contentType: 'text/html; charset=utf-8', status });

/** The redirect target every OAuth flow the gateway starts names: `<api base>/v1/oauth/callback`. */
const OAuthCallbackRoute = HttpRouter.add(
  'GET',
  '/v1/oauth/callback',
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { webOrigin } = yield* ServerConfig;
    const url = new URL(request.url, 'http://localhost');
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error_description') ?? url.searchParams.get('error');
    if (state === null || code === null || error !== null) {
      return html(
        popupHtml({ error: error ?? 'The provider did not return an authorization code' }, false, webOrigin),
        400,
      );
    }
    const oauth = yield* OAuthFlowSessions;
    const completed = yield* oauth.completeByState(state, { code }).pipe(
      Effect.map((session) =>
        session === undefined
          ? { ok: false as const, payload: { error: 'This callback matches no authorization in progress' } }
          : session.state.status === 'failed'
            ? { ok: false as const, payload: { error: session.state.message } }
            : { ok: true as const, payload: { sessionId: session.id, integration: session.integration } },
      ),
      Effect.catch((failure) => Effect.succeed({ ok: false as const, payload: { error: failure.message } })),
    );
    if (completed.ok) yield* ChangeFeed.use((changes) => changes.publish('integrations'));
    return html(popupHtml(completed.payload, completed.ok, webOrigin), completed.ok ? 200 : 400);
  }).pipe(
    Effect.withSpan('agentdock.gateway.oauth.callback'),
    withHttpRootSpan('agentdock.http.request.gateway.oauth.callback'),
  ),
);

export const GatewayRoutes = Layer.mergeAll(OAuthCallbackRoute);
