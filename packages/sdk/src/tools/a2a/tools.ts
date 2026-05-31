import { tool } from 'ai';
import { z } from 'zod';
import {
  createA2aCommunicationOperations,
  type A2aCommunicationOperations,
  type CreateA2aCommunicationOperationsOptions,
} from './operations';
import { createHttpAgentRegistry } from './registry';

export type CreateA2aCommunicationToolsOptions = {
  readonly baseUrl?: string;
  readonly sourceAgentId?: string;
};

export const createA2aCommunicationToolsFromOperations = (operations: A2aCommunicationOperations) => ({
  list_agents: tool({
    description: 'List the available A2A agents and their A2A endpoint URLs.',
    inputSchema: z.object({}),
    execute: () => operations.list_agents(),
  }),
  send_task: tool({
    description: 'Send a blocking task to an A2A agent and return its final text message.',
    inputSchema: z.object({
      agent_id: z.string().describe('The id of the A2A agent to send the task to.'),
      content: z.string().describe('The task content to send to the agent.'),
    }),
    execute: (input) => operations.send_task(input),
  }),
});

export const createA2aCommunicationTools = (options: CreateA2aCommunicationOperationsOptions) =>
  createA2aCommunicationToolsFromOperations(createA2aCommunicationOperations(options));

const defaultRegistryBaseUrl = (): string => process.env.AGENTDOCK_API_URL ?? 'http://127.0.0.1:38123';

export const createDefaultA2aCommunicationTools = ({
  baseUrl = defaultRegistryBaseUrl(),
  sourceAgentId,
}: CreateA2aCommunicationToolsOptions = {}) =>
  createA2aCommunicationTools({
    registry: createHttpAgentRegistry({
      baseUrl,
      ...(sourceAgentId ? { sourceAgentId } : {}),
    }),
    ...(sourceAgentId ? { sourceAgentId } : {}),
  });

export const defaultA2aCommunicationTools = createDefaultA2aCommunicationTools();
