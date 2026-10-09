import * as NodeCrypto from 'node:crypto';
import {
  AgentdockApi,
  type AgentdockMcpHandle,
  AgentdockRouteDefinitions,
  Auth,
  AuthLive,
  CoreServices,
  createAgentdockMcpRequestHandler,
  McpOAuth,
  type McpRuntimeServices,
} from 'api';
import * as Effect from 'effect/Effect';
import * as HttpMiddleware from 'effect/http/HttpMiddleware';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServer from 'effect/http/HttpServer';
import type * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as HttpApiSwagger from 'effect/http-api/HttpApiSwagger';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';

class ServerHandlerCloseError extends Schema.TaggedError<ServerHandlerCloseError>()('ServerHandlerCloseError', {
  handler: Schema.Literal('mcp'),
  cause: Schema.Defect(),
}) {}

class ServerMcpRequestError extends Schema.TaggedError<ServerMcpRequestError>()('ServerMcpRequestError', {
  cause: Schema.Defect(),
}) {}

const routePathForSpan = (pathname: string): string => {
  const parts = pathname.split('/').filter((part) => part.length > 0);
  if (parts.length === 0) return '/';

  if (parts[0] === 'agents' && parts[1]) {
    parts[1] = ':agentId';
    const sessionsIndex = parts.indexOf('sessions');
    if (sessionsIndex >= 0 && parts[sessionsIndex + 1]) parts[sessionsIndex + 1] = ':sessionId';
    const skillsIndex = parts.indexOf('skills');
    if (skillsIndex >= 0 && parts[skillsIndex + 1]) parts[skillsIndex + 1] = ':skillId';
    const sourcesIndex = parts.indexOf('sources');
    if (sourcesIndex >= 0 && parts[sourcesIndex + 1]) parts[sourcesIndex + 1] = ':sourceId';
  } else if (parts[0] === 'workflows' && parts[1]) {
    parts[1] = ':workflowId';
  } else if (parts[0] === 'channels' && parts[1] && parts[2] === 'webhook') {
    parts[1] = ':accountId';
  } else if (parts[0] === 'skills' && parts[1] && parts[1] !== 'pull') {
    parts[1] = ':skillId';
  } else if (parts[0] === 'traces' && parts[1]) {
    parts[1] = ':traceId';
  } else if (parts[0] === 'evals' && parts[1] === 'sessions') {
    if (parts[2]) parts[2] = ':targetId';
    if (parts[3]) parts[3] = ':sessionId';
  } else if (parts[0] === 'evals' && parts[2]) {
    if (parts[1] === 'datasets') parts[2] = ':datasetId';
    if (parts[1] === 'datasets' && parts[3] === 'cases' && parts[4] && parts[4] !== 'remove') parts[4] = ':caseId';
    if (parts[1] === 'graders' && parts[2] !== 'test') parts[2] = ':graderId';
    if (parts[1] === 'runs') parts[2] = ':runId';
    if (parts[1] === 'runs' && parts[3] === 'trials' && parts[4]) parts[4] = ':trialId';
    if (parts[1] === 'gates') parts[2] = ':gateId';
  }

  return `/${parts.join('/')}`;
};

const httpServerSpanName = (request: { readonly method: string; readonly url: string }): string => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  return `${request.method.toUpperCase()} ${routePathForSpan(pathname)}`;
};

const toWebRequest = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const host = request.headers.host ?? '127.0.0.1:38123';
    const url = `http://${host}${request.originalUrl}`;
    const headers = new Headers({ ...request.headers });

    if (request.method === 'GET' || request.method === 'HEAD') {
      return new Request(url, { method: request.method, headers });
    }

    return new Request(url, {
      method: request.method,
      headers,
      body: yield* request.arrayBuffer,
    });
  });

const bearerToken = (request: HttpServerRequest.HttpServerRequest): string | undefined => {
  const match = request.headers.authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
};

const tokensMatch = (presented: string, expected: string): boolean => {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
};

const unauthorized = (challenge: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: 'An MCP credential is required' },
    { status: 401, headers: { 'www-authenticate': challenge, 'access-control-expose-headers': 'www-authenticate' } },
  );

/**
 * `/mcp` serves coding agents that authorized through this server's OAuth
 * flow as a signed-in admin. `/mcp/internal` serves the built-in assistant,
 * which the gateway connects with the `internalToken` issued at startup.
 */
export const createServerRoutes = ({ internalToken }: { readonly internalToken: string }) => {
  const handleAuthRequest = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const webRequest = yield* toWebRequest(request);
      const { auth } = yield* Auth;
      const response = yield* Effect.tryPromise({
        try: () => auth.handler(webRequest),
        catch: (cause) => new ServerMcpRequestError({ cause }),
      });
      return HttpServerResponse.fromWeb(response);
    }).pipe(
      Effect.catch((error) =>
        Effect.logError(error).pipe(Effect.as(HttpServerResponse.text('Internal Server Error', { status: 500 }))),
      ),
    );

  const serveMcp = (mcp: AgentdockMcpHandle, request: HttpServerRequest.HttpServerRequest, owner: string) =>
    Effect.gen(function* () {
      const webRequest = yield* toWebRequest(request);
      const response = yield* Effect.tryPromise({
        try: () => mcp.handleRequest(webRequest, owner),
        catch: (cause) => new ServerMcpRequestError({ cause }),
      });
      return HttpServerResponse.fromWeb(response);
    });

  const handleMcpRequest = (mcp: AgentdockMcpHandle) => (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const oauth = yield* McpOAuth;
      const token = bearerToken(request);
      if (token === undefined) return unauthorized(oauth.challenge());
      const principal = yield* oauth.authenticate(token);
      if (principal === undefined) return unauthorized(oauth.challenge('invalid_token'));
      return yield* serveMcp(mcp, request, `user:${principal.userId}`);
    }).pipe(
      Effect.catch((error) =>
        Effect.logError(error).pipe(Effect.as(HttpServerResponse.text('Internal Server Error', { status: 500 }))),
      ),
    );

  const handleInternalMcpRequest = (mcp: AgentdockMcpHandle) => (request: HttpServerRequest.HttpServerRequest) => {
    const token = bearerToken(request);
    if (token === undefined || !tokensMatch(token, internalToken)) return Effect.succeed(unauthorized('Bearer'));
    return serveMcp(mcp, request, 'internal').pipe(
      Effect.catch((error) =>
        Effect.logError(error).pipe(Effect.as(HttpServerResponse.text('Internal Server Error', { status: 500 }))),
      ),
    );
  };

  const mcpRoutes = Layer.unwrap(
    Effect.gen(function* () {
      const mcp = createAgentdockMcpRequestHandler(yield* Effect.context<McpRuntimeServices>());
      yield* Effect.addFinalizer(() =>
        Effect.tryPromise({
          try: () => mcp.close(),
          catch: (cause) => new ServerHandlerCloseError({ handler: 'mcp', cause }),
        }).pipe(Effect.ignore),
      );
      return Layer.mergeAll(
        HttpRouter.add('*', '/mcp', handleMcpRequest(mcp)),
        HttpRouter.add('*', '/mcp/internal', handleInternalMcpRequest(mcp)),
      );
    }),
  ).pipe(Layer.provide(CoreServices));

  const authRoutes = HttpRouter.add('*', '/api/auth/*', handleAuthRequest);

  return Layer.mergeAll(AgentdockRouteDefinitions, authRoutes, mcpRoutes).pipe(
    Layer.provideMerge(HttpApiSwagger.layer(AgentdockApi, { path: '/docs' })),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
    Layer.provideMerge(Layer.succeed(HttpMiddleware.SpanNameGenerator)(httpServerSpanName)),
    Layer.provideMerge(HttpRouter.layer),
    Layer.provideMerge(HttpMiddleware.layerTracerDisabledForUrls(['/'])),
    Layer.provide(Layer.orDie(AuthLive)),
  );
};
