import { type AgentCard } from '@a2a-js/sdk';
import { type Agent } from '../schema';

type CreateAgentCardOptions = {
  readonly agent: Agent;
  readonly url: string;
};

export const createAgentCard = ({ agent, url }: CreateAgentCardOptions): AgentCard => ({
  name: agent.name,
  description: agent.description,
  protocolVersion: '0.3.0',
  version: agent.version,
  url,
  skills: [
    {
      id: 'chat',
      name: 'Chat',
      description: agent.description,
      tags: [...agent.tools],
    },
  ],
  capabilities: agent.capabilities,
  defaultInputModes: [...agent.defaultInputModes],
  defaultOutputModes: [...agent.defaultOutputModes],
  additionalInterfaces: [
    {
      url,
      transport: 'JSONRPC',
    },
  ],
});
