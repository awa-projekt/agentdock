import { tool } from 'ai';
import { z } from 'zod';

const defaultRegistryBaseUrl = (): string => process.env.AGENTDOCK_API_URL ?? 'http://127.0.0.1:38123';

export const createSkillTools = ({ baseUrl = defaultRegistryBaseUrl(), sourceAgentId }: {
  readonly baseUrl?: string;
  readonly sourceAgentId?: string;
} = {}) => ({
  load_skill: tool({
    description: 'Load the full SKILL.md instructions for a skill assigned to this agent. Use when the user task matches an available skill.',
    inputSchema: z.object({
      skill_id: z.string().describe('The id/name of the assigned skill to load.'),
    }),
    execute: async ({ skill_id }) => {
      if (!sourceAgentId) throw new Error('load_skill requires an agent id.');
      const url = new URL(`/agents/${encodeURIComponent(sourceAgentId)}/skills/${encodeURIComponent(skill_id)}`, baseUrl);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to load skill ${skill_id}: ${response.status}`);
      const { skill } = await response.json() as { skill: { content: string } };
      return skill.content;
    },
  }),
});
