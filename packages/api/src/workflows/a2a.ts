import { AGENT_CARD_PATH, type AgentCard } from '@a2a-js/sdk';
import { DefaultRequestHandler, type A2ARequestHandler } from '@a2a-js/sdk/server';
import { Context, Effect, Layer } from 'effect';
import { AgentA2aState } from '../a2a/state';
import { AgentRegistry } from '../agents/service';
import { normalizeBaseUrl } from '../routes';
import { type Workflow } from './schemas';
import { WorkflowTaskExecutor } from './executor';

type WorkflowA2aHandlersService = {
  readonly get: (workflow: Workflow, baseUrl: string) => Effect.Effect<A2ARequestHandler, unknown>;
};

export const WorkflowA2aHandlers = Context.Service<WorkflowA2aHandlersService>(
  '@agentdock/api/WorkflowA2aHandlers',
);

const workflowTargetId = (workflowId: string): string => `workflow:${workflowId}`;

const workflowA2aUrl = (baseUrl: string, workflowId: string): string =>
  `${normalizeBaseUrl(baseUrl)}/workflows/${workflowId}/a2a`;

const createWorkflowCard = (workflow: Workflow, baseUrl: string): AgentCard => {
  const url = workflowA2aUrl(baseUrl, workflow.id);

  return {
    name: workflow.name,
    description: workflow.description,
    protocolVersion: '0.3.0',
    version: workflow.version,
    url,
    skills: [
      {
        id: 'workflow',
        name: 'Workflow',
        description: workflow.description,
        tags: ['workflow'],
      },
    ],
    capabilities: {
      pushNotifications: false,
      streaming: true,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    additionalInterfaces: [
      {
        url,
        transport: 'JSONRPC',
      },
    ],
  };
};

export const WorkflowA2aHandlersLive = Layer.effect(
  WorkflowA2aHandlers,
  Effect.gen(function* () {
    const a2aState = yield* AgentA2aState;
    const agentRegistry = yield* AgentRegistry;

    return WorkflowA2aHandlers.of({
      get: (workflow, baseUrl) =>
        Effect.gen(function* () {
          const taskStore = yield* a2aState.getTaskStore(workflowTargetId(workflow.id));
          const agents = yield* agentRegistry.list();
          const executor = new WorkflowTaskExecutor(workflow, agents, baseUrl);

          return new DefaultRequestHandler(createWorkflowCard(workflow, baseUrl), taskStore, executor);
        }).pipe(Effect.withSpan('WorkflowA2aHandlers.get', { attributes: { 'workflow.id': workflow.id } })),
    });
  }),
);

export const workflowCardPath = (workflowId: string): string => `/workflows/${workflowId}/a2a/${AGENT_CARD_PATH}`;
export const workflowA2aPath = (workflowId: string): string => `/workflows/${workflowId}/a2a`;
