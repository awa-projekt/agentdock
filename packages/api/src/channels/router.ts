import * as Effect from 'effect/Effect';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Layer from 'effect/Layer';
import { withHttpRootSpan } from '../tracing';
import { ChannelGateway } from './gateway';

const toWebRequest = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const host = request.headers.host ?? '127.0.0.1:38123';
    const protocol = request.headers['x-forwarded-proto'] ?? 'http';
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(key, value);
    }
    return new Request(new URL(request.originalUrl, `${protocol}://${host}`), {
      method: request.method,
      headers,
      body: yield* request.arrayBuffer,
    });
  });

const TeamsWebhookRoute = HttpRouter.add(
  'POST',
  '/channels/:accountId/webhook',
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const accountId = params.accountId;
    yield* Effect.annotateCurrentSpan({ 'channel.account.id': accountId ?? 'unknown', 'channel.platform': 'teams' });
    if (!accountId) {
      return HttpServerResponse.jsonUnsafe({ error: 'Channel account not found.' }, { status: 404 });
    }
    const request = yield* HttpServerRequest.HttpServerRequest;
    const gateway = yield* ChannelGateway;
    return HttpServerResponse.fromWeb(yield* gateway.handleWebhook(accountId, yield* toWebRequest(request)));
  }).pipe(
    Effect.withSpan('agentdock.channels.teams.webhook'),
    withHttpRootSpan('agentdock.http.request.channels.teams.webhook'),
  ),
);

export const ChannelWebhookRoutes = Layer.mergeAll(TeamsWebhookRoute);
