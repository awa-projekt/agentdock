import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApiSwagger } from 'effect/unstable/httpapi';
import { Data, Effect, Layer } from 'effect';
import {
  AgentdockApi,
  AgentdockRoutes,
  CoreServices,
  createAgentdockMcpRequestHandler,
} from '../../../packages/api/index';

export type ServerHandlers = {
  readonly http: {
    readonly handler: (request: Request) => Promise<Response>;
    readonly dispose: () => Promise<void>;
  };
  readonly mcp: ReturnType<typeof createAgentdockMcpRequestHandler>;
};

class ServerHandlerCloseError extends Data.TaggedError('ServerHandlerCloseError')<{
  readonly handler: 'http' | 'mcp';
  readonly cause: unknown;
}> {}

export const createServerHandlers = (): ServerHandlers => {
  const routes = AgentdockRoutes.pipe(
    Layer.provideMerge(HttpApiSwagger.layer(AgentdockApi, { path: '/docs' })),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
  );

  const http = HttpRouter.toWebHandler(routes) as ServerHandlers['http'];
  const mcp = createAgentdockMcpRequestHandler(CoreServices);

  return { http, mcp };
};

export const closeServerHandlers = (handlers: ServerHandlers): Effect.Effect<void> =>
  Effect.all(
    [
      Effect.tryPromise({
        try: () => handlers.http.dispose(),
        catch: (cause) => new ServerHandlerCloseError({ handler: 'http', cause }),
      }).pipe(Effect.ignore),
      Effect.tryPromise({
        try: () => handlers.mcp.close(),
        catch: (cause) => new ServerHandlerCloseError({ handler: 'mcp', cause }),
      }).pipe(Effect.ignore),
    ],
    { concurrency: 'unbounded' },
  ).pipe(Effect.asVoid);
