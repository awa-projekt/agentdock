import type { AgentInternalsResponse, AgentRecord } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import { get_encoding } from 'tiktoken';
import { IntegrationCatalog } from '../gateway/catalog';
import { ModelCatalog } from '../models/catalog';
import { agentInstructions } from '../skills/prompt';
import { SkillRegistry } from '../skills/service';
import { AgentCommunicationPolicy } from './communication-policy';

const countTokens = (text: string): number => {
  const encoding = get_encoding('cl100k_base');
  try {
    return encoding.encode(text).length;
  } finally {
    encoding.free();
  }
};

const internalTool = (name: string, description: string) => ({
  id: name,
  name,
  source: 'internal' as const,
  active: true,
  description,
});

/** The model, tools and final system prompt an agent runs with, as the dashboard and MCP inspect them. */
export const agentInternals = Effect.fn('agentInternals')(function* (agent: AgentRecord) {
  const [skills, { tools: integrationTools }, model, targets] = yield* Effect.all([
    SkillRegistry.use((registry) => registry.list()),
    IntegrationCatalog.use((catalog) => catalog.listAgentTools(agent.id)),
    ModelCatalog.use((catalog) => catalog.find(agent.model)),
    AgentCommunicationPolicy.use((policy) => policy.listAllowedTargets(agent.id)),
  ]);
  const { instructions, skills: assigned } = agentInstructions(agent, skills);
  const loadsSkills = Object.values(assigned).includes('on-demand');
  const response: AgentInternalsResponse = {
    agentId: agent.id,
    model: {
      id: model.id,
      provider: model.provider,
      name: model.name,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      inputCostPerMillion: model.inputCostPerMillion,
      outputCostPerMillion: model.outputCostPerMillion,
    },
    tools: [
      ...(targets.length === 0
        ? []
        : [
            internalTool('list_agents', 'List the specialist agents this agent may delegate to.'),
            internalTool(
              'send_task',
              'Delegate a task to a specialist agent, relaying its progress, and return its final answer.',
            ),
          ]),
      ...(loadsSkills
        ? [
            internalTool(
              'load_skill',
              'Load the full SKILL.md instructions for a skill assigned to this agent. Use when the user task matches an available skill.',
            ),
          ]
        : []),
      ...integrationTools.map((tool) => ({
        id: tool.id,
        name: tool.name,
        source: 'integration' as const,
        description: tool.description,
        active: tool.mode !== 'disabled',
        mode: tool.mode,
      })),
    ],
    prompt: {
      editableInstructions: agent.instructions,
      finalInstructions: instructions,
      tokenCount: countTokens(instructions),
    },
  };
  return response;
});
