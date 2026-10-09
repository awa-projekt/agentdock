import * as Effect from 'effect/Effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import { AgentdockApi } from '../api';
import { getSessionUser } from '../auth-middleware';
import { IntegrationCatalog, platformPrincipal } from '../gateway/catalog';
import { searchIntegrationRegistry } from '../gateway/registry';
import { withHttpRootSpan } from '../tracing';

const unauthorized = HttpServerResponse.jsonUnsafe({ error: 'Authentication required' }, { status: 401 });

const sessionUser = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* getSessionUser(request);
});

const decidedBy = Effect.map(sessionUser, (user) => user?.email ?? user?.id ?? 'dashboard');

export const integrationsHandler = HttpApiBuilder.group(AgentdockApi, 'integrations', (handlers) =>
  handlers
    .handle('listIntegrations', () =>
      IntegrationCatalog.use((catalog) => catalog.listIntegrations()).pipe(
        withHttpRootSpan('agentdock.http.request.integrations.list'),
      ),
    )
    .handle('searchIntegrationRegistry', ({ payload }) =>
      searchIntegrationRegistry(payload).pipe(withHttpRootSpan('agentdock.http.request.integrations.registry.search')),
    )
    .handle('discoverIntegration', ({ payload }) =>
      IntegrationCatalog.use((catalog) => catalog.discoverIntegration(payload)).pipe(
        Effect.map((integration) => ({ integration })),
        withHttpRootSpan('agentdock.http.request.integrations.discover'),
      ),
    )
    .handle('removeIntegration', ({ params }) =>
      IntegrationCatalog.use((catalog) => catalog.removeIntegration(params.slug)).pipe(
        Effect.as({ removed: true }),
        withHttpRootSpan('agentdock.http.request.integrations.remove'),
      ),
    )
    .handle('connectIntegration', ({ params, payload }) =>
      IntegrationCatalog.use((catalog) => catalog.connect(params.slug, { kind: 'org' }, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.integrations.connect'),
      ),
    )
    .handle('startOAuthConnection', ({ params, payload }) =>
      IntegrationCatalog.use((catalog) => catalog.startOAuth(params.slug, { kind: 'org' }, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.integrations.oauth.start'),
      ),
    )
    .handle('removeConnection', ({ params }) =>
      IntegrationCatalog.use((catalog) => catalog.removeConnection(params.slug, params.name, { kind: 'org' })).pipe(
        Effect.as({ removed: true }),
        withHttpRootSpan('agentdock.http.request.integrations.connections.remove'),
      ),
    )
    .handle('refreshConnection', ({ params }) =>
      IntegrationCatalog.use((catalog) => catalog.refreshConnection(params.slug, params.name)).pipe(
        Effect.map((tools) => ({ tools })),
        withHttpRootSpan('agentdock.http.request.integrations.connections.refresh'),
      ),
    )
    .handle('getOAuthSession', ({ params }) =>
      IntegrationCatalog.use((catalog) => catalog.getOAuthSession(params.sessionId)).pipe(
        withHttpRootSpan('agentdock.http.request.integrations.oauth.session'),
      ),
    )
    .handle('provideOAuthClient', ({ params, payload }) =>
      IntegrationCatalog.use((catalog) => catalog.provideOAuthClient(params.sessionId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.integrations.oauth.client'),
      ),
    )
    .handle('listUserConnections', () =>
      Effect.gen(function* () {
        const user = yield* sessionUser;
        if (!user) return unauthorized;
        const catalog = yield* IntegrationCatalog;
        return { integrations: yield* catalog.listUserConnections(user.id) };
      }).pipe(withHttpRootSpan('agentdock.http.request.me.connections.list')),
    )
    .handle('connectUserIntegration', ({ params, payload }) =>
      Effect.gen(function* () {
        const user = yield* sessionUser;
        if (!user) return unauthorized;
        const catalog = yield* IntegrationCatalog;
        return yield* catalog.connect(params.slug, { kind: 'user', subject: user.id }, payload);
      }).pipe(withHttpRootSpan('agentdock.http.request.me.connections.connect')),
    )
    .handle('startUserOAuthConnection', ({ params, payload }) =>
      Effect.gen(function* () {
        const user = yield* sessionUser;
        if (!user) return unauthorized;
        const catalog = yield* IntegrationCatalog;
        return yield* catalog.startOAuth(params.slug, { kind: 'user', subject: user.id }, payload);
      }).pipe(withHttpRootSpan('agentdock.http.request.me.connections.oauth.start')),
    )
    .handle('removeUserConnection', ({ params }) =>
      Effect.gen(function* () {
        const user = yield* sessionUser;
        if (!user) return unauthorized;
        const catalog = yield* IntegrationCatalog;
        yield* catalog.removeConnection(params.slug, params.name, { kind: 'user', subject: user.id });
        return { removed: true };
      }).pipe(withHttpRootSpan('agentdock.http.request.me.connections.remove')),
    )
    .handle('executeTool', ({ payload }) =>
      IntegrationCatalog.use((catalog) => catalog.invoke(platformPrincipal, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.tools.execute'),
      ),
    )
    .handle('setToolDecision', ({ params, payload }) =>
      IntegrationCatalog.use((catalog) => catalog.setToolDecision(params.toolId, payload.decision)).pipe(
        Effect.as({ updated: true }),
        withHttpRootSpan('agentdock.http.request.tools.decision'),
      ),
    ),
);

export const agentToolsHandler = HttpApiBuilder.group(AgentdockApi, 'agentTools', (handlers) =>
  handlers.handle('listAgentTools', ({ params }) =>
    IntegrationCatalog.use((catalog) => catalog.listAgentTools(params.agentId)).pipe(
      withHttpRootSpan('agentdock.http.request.agents.tools.list'),
    ),
  ),
);

export const approvalsHandler = HttpApiBuilder.group(AgentdockApi, 'approvals', (handlers) =>
  handlers
    .handle('listApprovals', ({ query }) =>
      IntegrationCatalog.use((catalog) => catalog.listApprovals(query.status)).pipe(
        Effect.map((approvals) => ({ approvals })),
        withHttpRootSpan('agentdock.http.request.approvals.list'),
      ),
    )
    .handle('approveApproval', ({ params }) =>
      Effect.gen(function* () {
        const by = yield* decidedBy;
        const catalog = yield* IntegrationCatalog;
        return { approval: yield* catalog.decideApproval(params.approvalId, 'accept', by) };
      }).pipe(withHttpRootSpan('agentdock.http.request.approvals.approve')),
    )
    .handle('denyApproval', ({ params }) =>
      Effect.gen(function* () {
        const by = yield* decidedBy;
        const catalog = yield* IntegrationCatalog;
        return { approval: yield* catalog.decideApproval(params.approvalId, 'decline', by) };
      }).pipe(withHttpRootSpan('agentdock.http.request.approvals.deny')),
    )
    .handle('listAudit', ({ query }) =>
      IntegrationCatalog.use((catalog) => catalog.listAudit(query)).pipe(
        withHttpRootSpan('agentdock.http.request.audit.list'),
      ),
    ),
);
