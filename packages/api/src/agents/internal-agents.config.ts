import {
  AGENTDOCK_URL_PLACEHOLDER,
  AgentColor,
  AgentId,
  type AgentRecord,
  ALL_TOOLS,
  ConnectionName,
  HOME_INTERNAL_AGENT_ID,
  SkillId,
} from 'agentdock-sdk/schemas';
import * as Schema from 'effect/Schema';

const agentId = Schema.decodeUnknownSync(AgentId);

/** Shipped in `src/skills/builtin/agentdock`. */
const AGENTDOCK_SKILL_ID = SkillId.make('agentdock');

export const INTERNAL_AGENTS = [
  {
    id: agentId(HOME_INTERNAL_AGENT_ID),
    visibility: 'internal',
    revision: 1,
    name: 'Agentdock Assistant',
    description: 'Chat with the preconfigured Agentdock assistant.',
    color: AgentColor.make('#7c3aed'),
    integrations: {
      agentdock: {
        endpoint: `${AGENTDOCK_URL_PLACEHOLDER}/mcp/internal`,
        connection: { owner: 'org', name: ConnectionName.make('default') },
        tools: { [ALL_TOOLS]: 'codemode' },
      },
    },
    skills: { [AGENTDOCK_SKILL_ID]: 'inject' },
    communication: {
      allowAll: false,
      allowedAgentIds: [],
    },
    model: 'openai:gpt-5.6-luna',
    reasoningEffort: 'low',
    instructions:
      'You are the Agentdock assistant, built into the dashboard of this Agentdock instance. Help the person inspect, configure and operate it. Be direct and concise. The Agentdock tools are reachable only from inside `executeTs` scripts, under the agentdock namespace; discover them there, never guess their names.',
    version: '0.1.0',
    capabilities: {
      pushNotifications: false,
      streaming: true,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  },
] as const satisfies ReadonlyArray<AgentRecord>;
