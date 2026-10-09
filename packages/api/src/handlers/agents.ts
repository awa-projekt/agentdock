import * as Effect from 'effect/Effect';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import { agentInternals } from '../agents/internals';
import { forgetAgent, prepareAgentIntegrations, syncAgent } from '../agents/lifecycle';
import { AgentRegistry } from '../agents/service';
import { AgentdockApi } from '../api';
import { withHttpRootSpan } from '../tracing';

const jsonResponse = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe(
    {
      error,
    },
    { status },
  );

const toErrorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

export const agentsHandler = HttpApiBuilder.group(AgentdockApi, 'agents', (handlers) =>
  handlers
    .handle('listAgents', () =>
      AgentRegistry.use((registry) => registry.list()).pipe(
        withHttpRootSpan('agentdock.http.request.agents.list'),
        Effect.catch((error) => Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to list agents')))),
      ),
    )
    .handle('listExternalAgents', () =>
      AgentRegistry.use((registry) => registry.listExternal()).pipe(
        withHttpRootSpan('agentdock.http.request.agents.external.list'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to list external agents'))),
        ),
      ),
    )
    .handle('addAgent', ({ payload }) =>
      prepareAgentIntegrations(payload).pipe(
        Effect.andThen(AgentRegistry.use((registry) => registry.add(payload))),
        Effect.tap(syncAgent),
        withHttpRootSpan('agentdock.http.request.agents.add'),
        Effect.catchTags({
          IntegrationOperationError: (error) => Effect.succeed(jsonResponse(400, error.message)),
          IntegrationNotFoundError: (error) => Effect.succeed(jsonResponse(400, error.message)),
        }),
        Effect.catch((error) => Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to add agent')))),
      ),
    )
    .handle('addExternalAgent', ({ payload }) =>
      AgentRegistry.use((registry) => registry.addExternal(payload)).pipe(
        withHttpRootSpan('agentdock.http.request.agents.external.add'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to add external agent'))),
        ),
      ),
    )
    .handle('updateExternalAgent', ({ params, payload }) =>
      Effect.gen(function* () {
        const registry = yield* AgentRegistry;
        const agent = yield* registry.updateExternal(params.agentId, payload);

        if (!agent) return jsonResponse(404, 'External agent not found');
        return agent;
      }).pipe(
        withHttpRootSpan('agentdock.http.request.agents.external.update'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to update external agent'))),
        ),
      ),
    )
    .handle('removeExternalAgent', ({ params }) =>
      AgentRegistry.use((registry) => registry.removeExternal(params.agentId)).pipe(
        Effect.map((removed) => ({ removed })),
        withHttpRootSpan('agentdock.http.request.agents.external.remove'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to remove external agent'))),
        ),
      ),
    )
    .handle('updateAgent', ({ params, payload }) =>
      Effect.gen(function* () {
        const registry = yield* AgentRegistry;
        yield* prepareAgentIntegrations(payload);
        const agent = yield* registry.update(params.agentId, payload);

        if (!agent) {
          return jsonResponse(404, 'Agent not found');
        }

        yield* syncAgent(agent);
        return agent;
      }).pipe(
        withHttpRootSpan('agentdock.http.request.agents.update'),
        Effect.catchTags({
          AgentRevisionConflictError: (error) => Effect.succeed(jsonResponse(409, error.message)),
          IntegrationOperationError: (error) => Effect.succeed(jsonResponse(400, error.message)),
          IntegrationNotFoundError: (error) => Effect.succeed(jsonResponse(400, error.message)),
        }),
        Effect.catch((error) => Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to update agent')))),
      ),
    )
    .handle('getAgentInternals', ({ params }) =>
      Effect.gen(function* () {
        const agent = yield* AgentRegistry.use((registry) => registry.getById(params.agentId));
        if (!agent) return jsonResponse(404, 'Agent not found');
        return yield* agentInternals(agent);
      }).pipe(
        withHttpRootSpan('agentdock.http.request.agents.internals'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to inspect agent internals'))),
        ),
      ),
    )
    .handle('removeAgent', ({ params }) =>
      AgentRegistry.use((registry) => registry.remove(params.agentId)).pipe(
        Effect.tap((removed) => (removed ? forgetAgent(params.agentId) : Effect.void)),
        Effect.map((removed) => ({ removed })),
        Effect.withSpan('agentdock.http.agents.remove', {
          attributes: { 'agent.id': params.agentId },
        }),
        withHttpRootSpan('agentdock.http.request.agents.remove'),
        Effect.catch((error) => Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to remove agent')))),
      ),
    ),
);
