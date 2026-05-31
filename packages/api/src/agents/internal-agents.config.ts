import { Schema } from 'effect';
import { AgentIdSchema } from 'agentdock-sdk/api';
import type { Agent } from './schemas';

const agentId = Schema.decodeUnknownSync(AgentIdSchema);

export const INTERNAL_AGENTS = [
  {
    id: agentId('agentdock-home'),
    visibility: 'internal',
    name: 'Agentdock Assistant',
    description: 'Chat with the preconfigured Agentdock assistant.',
    tools: [],
    skillIds: [],
    communication: {
      allowAll: false,
      allowedAgentIds: [],
    },
    model: 'openai:gpt-5.4-mini',
    instructions:
      'You are the internal Agentdock assistant. Help the user inspect, configure, and operate this Agentdock instance using the available tools. Be direct, concise, and ask before making destructive changes. When the user asks about creating, deleting or updating agents, workflows or other things about agentdock, use the `execute` tool to invoke the tools in the agentdock namespace. Never use the list-agent and send-task tools for checking what other agents exist. These are communication tools. Always only use the list-agent tools you can find in the execution discovery.',
    version: '0.1.0',
    capabilities: {
      pushNotifications: false,
      streaming: true,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  },
] as const satisfies ReadonlyArray<Agent>;

export const HOME_INTERNAL_AGENT_ID = 'agentdock-home';
