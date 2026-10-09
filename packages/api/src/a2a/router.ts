import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from 'agentdock-sdk';
import type { Json } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Layer from 'effect/Layer';
import { AgentCommunicationPolicy } from '../agents/communication-policy';
import { AgentRegistry } from '../agents/service';
import { buildAgentA2aUrl } from '../routes';
import { withHttpRootSpan } from '../tracing';
import { WorkflowA2aHandlers } from '../workflows/a2a';
import { WorkflowRegistry } from '../workflows/service';
import { AgentA2aHandlers } from './handlers';
import { admitIntegrationOverrides, requestAdmission } from './integration-overrides';

const notFound = (error: string) => HttpServerResponse.jsonUnsafe({ error }, { status: 404 });

const getBaseUrl = (request: HttpServerRequest.HttpServerRequest): string => {
  const host = request.headers.host ?? 'localhost:38123';
  const protocol = request.headers['x-forwarded-proto'] ?? 'http';

  return `${protocol}://${host}`;
};

const getAgentRequestHandler = Effect.fn('AgentA2aRoutes.getAgentRequestHandler')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const params = yield* HttpRouter.params;
  const agentId = params.agentId;

  if (!agentId) {
    return null;
  }

  const registry = yield* AgentRegistry;
  const agent = yield* registry.getById(agentId);

  if (!agent) {
    return null;
  }

  const handlers = yield* AgentA2aHandlers;
  return yield* handlers.get(agent, getBaseUrl(request));
});

const getWorkflowRequestHandler = Effect.fn('AgentA2aRoutes.getWorkflowRequestHandler')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const params = yield* HttpRouter.params;
  const workflowId = params.workflowId;

  if (!workflowId) {
    return null;
  }

  const registry = yield* WorkflowRegistry;
  const workflow = yield* registry.getById(workflowId);

  if (!workflow) {
    return null;
  }

  const handlers = yield* WorkflowA2aHandlers;
  return yield* handlers.get(workflow, getBaseUrl(request));
});

/** The request's check for integration overrides, with what it needs bound. */
const overrideAdmission = Effect.gen(function* () {
  const admission = yield* requestAdmission(yield* HttpServerRequest.HttpServerRequest);
  return (body: Json) => admitIntegrationOverrides(body, admission);
});

const AgentCardRoute = HttpRouter.add(
  'GET',
  `/agents/:agentId/a2a/${AGENT_CARD_PATH}`,
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    yield* Effect.annotateCurrentSpan({ 'agent.id': params.agentId ?? 'unknown' });
    const requestHandler = yield* getAgentRequestHandler();

    if (!requestHandler) {
      return notFound('Agent not found');
    }

    return yield* agentCardHandler({ agentCardProvider: requestHandler });
  }).pipe(Effect.withSpan('agentdock.a2a.agent_card'), withHttpRootSpan('agentdock.http.request.a2a.agent_card')),
);

const AgentJsonRpcRoute = HttpRouter.add(
  'POST',
  '/agents/:agentId/a2a',
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    yield* Effect.annotateCurrentSpan({ 'agent.id': params.agentId ?? 'unknown' });
    const requestHandler = yield* getAgentRequestHandler();

    if (!requestHandler) {
      return notFound('Agent not found');
    }

    return yield* jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
      admit: yield* overrideAdmission,
    });
  }).pipe(Effect.withSpan('agentdock.a2a.json_rpc'), withHttpRootSpan('agentdock.http.request.a2a.json_rpc')),
);

const WorkflowCardRoute = HttpRouter.add(
  'GET',
  `/workflows/:workflowId/a2a/${AGENT_CARD_PATH}`,
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    yield* Effect.annotateCurrentSpan({ 'workflow.id': params.workflowId ?? 'unknown' });
    const requestHandler = yield* getWorkflowRequestHandler();

    if (!requestHandler) {
      return notFound('Workflow not found');
    }

    return yield* agentCardHandler({ agentCardProvider: requestHandler });
  }).pipe(Effect.withSpan('agentdock.a2a.workflow_card'), withHttpRootSpan('agentdock.http.request.a2a.workflow_card')),
);

const WorkflowJsonRpcRoute = HttpRouter.add(
  'POST',
  '/workflows/:workflowId/a2a',
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    yield* Effect.annotateCurrentSpan({ 'workflow.id': params.workflowId ?? 'unknown' });
    const requestHandler = yield* getWorkflowRequestHandler();

    if (!requestHandler) {
      return notFound('Workflow not found');
    }

    return yield* jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
      admit: yield* overrideAdmission,
    });
  }).pipe(
    Effect.withSpan('agentdock.a2a.workflow_json_rpc'),
    withHttpRootSpan('agentdock.http.request.a2a.workflow_json_rpc'),
  ),
);

const AllowedAgentsRoute = HttpRouter.add(
  'GET',
  '/agents/:agentId/allowed-targets',
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* HttpRouter.params;
    const agentId = params.agentId;
    yield* Effect.annotateCurrentSpan({ 'agent.id': agentId ?? 'unknown' });

    if (!agentId) {
      return notFound('Agent not found');
    }

    const policy = yield* AgentCommunicationPolicy;
    const agents = yield* policy.listAllowedTargets(agentId);
    const baseUrl = getBaseUrl(request);

    return HttpServerResponse.jsonUnsafe(
      agents.map((agent) => ({
        ...agent,
        a2aUrl: buildAgentA2aUrl(baseUrl, agent.id),
      })),
    );
  }).pipe(
    Effect.withSpan('agentdock.http.allowed_targets'),
    withHttpRootSpan('agentdock.http.request.allowed_targets'),
  ),
);

export const AgentA2aRoutes = Layer.mergeAll(
  AgentCardRoute,
  AgentJsonRpcRoute,
  WorkflowCardRoute,
  WorkflowJsonRpcRoute,
  AllowedAgentsRoute,
);
