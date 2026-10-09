import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { z } from 'zod';
import type { AgentToolSet } from './types';
import { defineAgentTool } from './types';

export class SkillLoadError extends Schema.TaggedError<SkillLoadError>()('SkillLoadError', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export type SkillLoader = (skillId: string) => Effect.Effect<string, SkillLoadError>;

export const createSkillToolsFromLoader = (load: SkillLoader): AgentToolSet => [
  defineAgentTool({
    name: 'load_skill',
    description:
      'Load the full SKILL.md instructions for a skill assigned to this agent. Use when the user task matches an available skill.',
    schema: z.object({
      skill_id: z.string().describe('The id/name of the assigned skill to load.'),
    }),
    invoke: ({ skill_id }) => Effect.runPromise(load(skill_id)),
  }),
];
