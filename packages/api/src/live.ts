import * as Effect from 'effect/Effect';
import * as HttpMiddleware from 'effect/http/HttpMiddleware';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import * as Layer from 'effect/Layer';
import { AgentA2aRoutes } from './a2a/router';
import { AgentAgUiRoutes } from './ag-ui/router';
import { AgentdockApi } from './api';
import { AuthLive } from './auth';
import { AuthMiddlewareLive } from './auth-middleware';
import { ChannelWebhookRoutes } from './channels/router';
import { CorsConfig, CorsConfigLive } from './config';
import { GatewayRoutes } from './gateway/router';
import { CoreHandlers, CoreServices } from './handlers';
import { McpOAuthRoutes } from './mcp/routes';
import { ServerFailuresLive } from './server-failures';
import { TriggerRoutes } from './triggers/router';

const ApiHandlers = CoreHandlers.pipe(Layer.provideMerge(ServerFailuresLive));

export const AgentdockApiLive = HttpApiBuilder.layer(AgentdockApi).pipe(Layer.provide(ApiHandlers));

const AgentdockHttpApiRoutes = HttpApiBuilder.layer(AgentdockApi, { openapiPath: '/docs/openapi.json' }).pipe(
  Layer.provide(ApiHandlers),
);

const AgentdockHttpRouterRoutes = Layer.mergeAll(
  AgentA2aRoutes,
  AgentAgUiRoutes,
  GatewayRoutes,
  ChannelWebhookRoutes,
  TriggerRoutes,
  McpOAuthRoutes,
).pipe(Layer.provideMerge(CoreServices));

export const AgentdockRouteDefinitions = Layer.mergeAll(
  AgentdockHttpApiRoutes,
  AgentdockHttpRouterRoutes,
  AuthMiddlewareLive,
  HttpRouter.middleware(
    Effect.gen(function* () {
      const config = yield* CorsConfig;
      return HttpMiddleware.cors({
        allowedOrigins: config.allowAllDevOrigins ? () => true : config.allowedOrigins,
        allowedMethods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'b3', 'traceparent', 'tracestate', 'baggage'],
        credentials: true,
      });
    }),
    { global: true },
  ),
).pipe(Layer.provide(Layer.orDie(AuthLive)), Layer.provide(Layer.orDie(CorsConfigLive)));

export const AgentdockRoutes = AgentdockRouteDefinitions.pipe(Layer.provideMerge(HttpRouter.layer));
