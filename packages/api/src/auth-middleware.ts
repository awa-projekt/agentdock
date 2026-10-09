import { HOME_INTERNAL_AGENT_ID } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { Auth, AuthLive, type AuthUser } from './auth';
import { AuthConfig } from './config';

type AuthRole = 'admin' | 'user';
type SessionUser = Pick<AuthUser, 'id'> & {
  readonly email?: string | null;
  readonly name?: string | null;
  readonly role?: unknown;
};

class AuthSessionLookupError extends Schema.TaggedError<AuthSessionLookupError>()('AuthSessionLookupError', {
  cause: Schema.Defect(),
}) {}

const noAuthUser: SessionUser = {
  id: 'agentdock-no-auth-user',
  email: 'no-auth@agentdock.local',
  name: 'No Auth',
  role: 'admin',
};

const json = (status: number, error: string) => HttpServerResponse.jsonUnsafe({ error }, { status });

const headersFromRequest = (request: HttpServerRequest.HttpServerRequest): Headers => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(key, value);
  }
  return headers;
};

const roleFromUser = (user: SessionUser): AuthRole => (user.role === 'admin' ? 'admin' : 'user');

const pathFromRequest = (request: HttpServerRequest.HttpServerRequest): string =>
  new URL(request.url, `http://${request.headers.host ?? '127.0.0.1:38123'}`).pathname;

const internalAgentPath = new RegExp(`^/agents/${HOME_INTERNAL_AGENT_ID}/(?:a2a(?:/|$)|ag-ui$)`);

/**
 * Paths that authenticate their callers themselves or serve anyone: the MCP
 * endpoints check bearer tokens, the OAuth endpoints are how MCP clients get
 * them, and published agents answer A2A. The built-in assistant is not
 * public: it operates the instance with admin rights.
 */
const publicPath = (path: string): boolean =>
  path === '/' ||
  path === '/docs' ||
  path === '/docs/openapi.json' ||
  path.startsWith('/api/auth/') ||
  path === '/v1/oauth/callback' ||
  path === '/mcp' ||
  path === '/mcp/internal' ||
  path.startsWith('/.well-known/') ||
  path === '/oauth/register' ||
  path === '/oauth/authorize' ||
  path === '/oauth/token' ||
  (!internalAgentPath.test(path) && /^\/agents\/[^/]+\/a2a(?:\/|$)/.test(path)) ||
  /^\/workflows\/[^/]+\/a2a(?:\/|$)/.test(path) ||
  (!internalAgentPath.test(path) && /^\/agents\/[^/]+\/ag-ui$/.test(path)) ||
  /^\/workflows\/[^/]+\/ag-ui$/.test(path) ||
  /^\/triggers\/[^/]+\/webhook$/.test(path) ||
  /^\/channels\/[^/]+\/webhook$/.test(path);

const userAllowedPath = (method: string, path: string): boolean => {
  if (method === 'GET' && (path === '/events' || path === '/integrations' || path === '/me/connections')) {
    return true;
  }

  if (method === 'GET' && /^\/oauth-sessions\/[^/]+$/.test(path)) {
    return true;
  }

  if ((method === 'POST' || method === 'DELETE') && /^\/me\/connections\/[^/]+(?:\/[^/]+)?$/.test(path)) {
    return true;
  }

  return false;
};

export const getSessionUser = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const config = yield* AuthConfig;
    if (config.disabled) return noAuthUser;

    const { auth } = yield* Auth;
    return yield* Effect.tryPromise({
      try: () => auth.api.getSession({ headers: headersFromRequest(request) }),
      catch: (cause) => new AuthSessionLookupError({ cause }),
    }).pipe(
      Effect.map((session) => session?.user ?? null),
      Effect.catch(() => Effect.succeed(null)),
    );
  });

const AuthMiddleware = HttpRouter.middleware(
  Effect.gen(function* () {
    const config = yield* AuthConfig;
    const { auth } = yield* Auth;

    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = pathFromRequest(request);
        const method = request.method.toUpperCase();

        if (config.disabled || method === 'OPTIONS' || publicPath(path)) {
          return yield* httpEffect;
        }

        const user = yield* Effect.tryPromise({
          try: () => auth.api.getSession({ headers: headersFromRequest(request) }),
          catch: (cause) => new AuthSessionLookupError({ cause }),
        }).pipe(
          Effect.map((session) => session?.user ?? null),
          Effect.catch(() => Effect.succeed(null)),
        );
        if (!user) {
          return json(401, 'Authentication required');
        }

        const role = roleFromUser(user);
        if (role === 'admin' || userAllowedPath(method, path)) {
          return yield* httpEffect;
        }

        return json(403, 'Admin access required');
      });
  }),
  { global: true },
);

export const AuthMiddlewareLive = AuthMiddleware.pipe(Layer.provide(Layer.orDie(AuthLive)));
