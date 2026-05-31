import { HttpRouter } from 'effect/unstable/http';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Layer } from 'effect';
import { AgentdockApi } from './api';
import { AgentA2aRoutes } from './a2a/router';
import { AgentExecutorRoutes } from './executor/router';
import { CoreHandlers, CoreServices } from './handlers';

export const AgentdockApiLive = HttpApiBuilder.layer(AgentdockApi).pipe(Layer.provide(CoreHandlers));

const AgentdockHttpApiRoutes = HttpApiBuilder.layer(AgentdockApi, { openapiPath: '/docs/openapi.json' }).pipe(
  Layer.provide(CoreHandlers),
);

const AgentdockHttpRouterRoutes = Layer.mergeAll(
  AgentA2aRoutes,
  AgentExecutorRoutes,
).pipe(Layer.provideMerge(CoreServices));

export const AgentdockRoutes = Layer.mergeAll(
  AgentdockHttpApiRoutes,
  AgentdockHttpRouterRoutes,
  HttpRouter.cors({
    allowedMethods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  }),
).pipe(Layer.provideMerge(HttpRouter.layer));
