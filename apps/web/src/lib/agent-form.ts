import { type AgentRecord, type CreateAgentInput, randomAgentColor } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import { formatList } from '@/lib/format';

export const createDefaultForm = (): CreateAgentInput => ({
  name: '',
  description: '',
  color: Effect.runSync(randomAgentColor),
  instructions: '',
  model: 'openai:gpt-5.6-luna',
  reasoningEffort: 'low',
  integrations: {},
  skills: {},
  communication: {
    allowAll: false,
    allowedAgentIds: [],
  },
  version: '0.1.0',
  capabilities: {
    pushNotifications: false,
    streaming: true,
  },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
});

export const agentToForm = (agent: AgentRecord): CreateAgentInput => ({
  name: agent.name,
  description: agent.description,
  color: agent.color,
  instructions: agent.instructions,
  model: agent.model,
  reasoningEffort: agent.reasoningEffort ?? null,
  integrations: agent.integrations,
  skills: agent.skills,
  communication: agent.communication,
  version: agent.version,
  capabilities: agent.capabilities,
  defaultInputModes: agent.defaultInputModes,
  defaultOutputModes: agent.defaultOutputModes,
  inputContract: agent.inputContract ?? undefined,
  outputContract: agent.outputContract ?? undefined,
});

export const formatCommunication = (agent: AgentRecord): string =>
  agent.communication.allowAll ? 'All agents' : formatList(agent.communication.allowedAgentIds);
