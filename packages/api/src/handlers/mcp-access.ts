import { McpAccessError, McpAccessNotFoundError } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import { AgentdockApi } from '../api';
import { getSessionUser } from '../auth-middleware';
import { McpOAuth, type McpOAuthError } from '../mcp/oauth';
import { withHttpRootSpan } from '../tracing';

const signedInUserId = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const user = yield* getSessionUser(request);
  if (!user) return yield* new McpAccessError({ message: 'Sign in to manage MCP access' });
  return user.id;
});

const toAccessError = (error: McpOAuthError) =>
  error.notFound
    ? new McpAccessNotFoundError({ message: error.message })
    : new McpAccessError({ message: error.message });

export const mcpAccessHandler = HttpApiBuilder.group(AgentdockApi, 'mcpAccess', (handlers) =>
  handlers
    .handle('getMcpAccess', () =>
      Effect.gen(function* () {
        const oauth = yield* McpOAuth;
        const grants = yield* oauth.listGrants(yield* signedInUserId);
        return { mcpUrl: oauth.resource, skillsUrl: oauth.issuer, grants };
      }).pipe(
        Effect.catchTag('McpOAuthError', (error) => Effect.fail(toAccessError(error))),
        withHttpRootSpan('agentdock.http.request.mcp-access.get'),
      ),
    )
    .handle('revokeMcpGrant', ({ params }) =>
      Effect.gen(function* () {
        const oauth = yield* McpOAuth;
        return { revoked: yield* oauth.revokeGrant(yield* signedInUserId, params.grantId) };
      }).pipe(
        Effect.catchTag('McpOAuthError', (error) => Effect.fail(toAccessError(error))),
        withHttpRootSpan('agentdock.http.request.mcp-access.revoke'),
      ),
    )
    .handle('getMcpAuthorizationRequest', ({ params }) =>
      McpOAuth.use((oauth) => oauth.getRequest(params.requestId)).pipe(
        Effect.catchTag('McpOAuthError', (error) => Effect.fail(toAccessError(error))),
        withHttpRootSpan('agentdock.http.request.mcp-access.request'),
      ),
    )
    .handle('decideMcpAuthorizationRequest', ({ params, payload }) =>
      Effect.gen(function* () {
        const oauth = yield* McpOAuth;
        return { redirect: yield* oauth.decide(params.requestId, yield* signedInUserId, payload.approve) };
      }).pipe(
        Effect.catchTag('McpOAuthError', (error) => Effect.fail(toAccessError(error))),
        withHttpRootSpan('agentdock.http.request.mcp-access.decide'),
      ),
    ),
);
