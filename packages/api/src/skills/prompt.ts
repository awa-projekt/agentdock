import type { AgentSkills, Skill } from 'agentdock-sdk/schemas';
import { skillBody } from './parser';

export type AgentPrompt = { readonly instructions: string; readonly skills: AgentSkills };

/**
 * An agent's final system prompt: its own instructions, the body of every
 * injected skill, and a listing of the on-demand skills it can `load_skill`.
 * Assignments naming a skill that no longer exists are dropped.
 */
export const agentInstructions = (
  agent: { readonly instructions: string; readonly skills: AgentSkills },
  available: ReadonlyArray<Skill>,
): AgentPrompt => {
  const assigned = Object.entries(agent.skills).flatMap(([id, mode]) => {
    const skill = available.find((candidate) => candidate.id === id);
    return skill ? [{ skill, mode }] : [];
  });
  const injected = assigned.filter(({ mode }) => mode === 'inject').map(({ skill }) => skill);
  const onDemand = assigned.filter(({ mode }) => mode === 'on-demand').map(({ skill }) => skill);
  const sections = [
    agent.instructions,
    ...injected.map((skill) => `<skill name="${skill.id}">\n${skillBody(skill.content)}\n</skill>`),
    ...(onDemand.length === 0
      ? []
      : [
          `Available agent skills:\n${onDemand.map((skill) => `- ${skill.id}: ${skill.description}`).join('\n')}\nWhen a task matches one of these skills, call load_skill with the skill id before proceeding.`,
        ]),
  ];
  return {
    instructions: sections.join('\n\n'),
    skills: Object.fromEntries(assigned.map(({ skill, mode }) => [skill.id, mode])),
  };
};
