import {
  DefaultRequestHandler,
  type A2ARequestHandler,
} from '@a2a-js/sdk/server';
import { AgentTaskExecutor, createAgentCard } from 'agentdock-sdk';
import { Context, Effect, Layer } from 'effect';
import { type Agent } from '../agents/schemas';
import { buildAgentA2aUrl } from '../routes';
import { AgentExecutorRegistry } from '../executor/service';
import { SkillRegistry } from '../skills/service';
import { AgentA2aState } from './state';

type AgentA2aHandlersService = {
  readonly get: (agent: Agent, baseUrl: string) => Effect.Effect<A2ARequestHandler, unknown>;
};

export const AgentA2aHandlers = Context.Service<AgentA2aHandlersService>(
  '@agentdock/api/AgentA2aHandlers',
);

export const AgentA2aHandlersLive = Layer.effect(
  AgentA2aHandlers,
  Effect.gen(function* () {
    const a2aState = yield* AgentA2aState;
    const executorRegistry = yield* AgentExecutorRegistry;
    const skillRegistry = yield* SkillRegistry;
    const effectContext = yield* Effect.context<never>();

    return AgentA2aHandlers.of({
      get: (agent, baseUrl) =>
        Effect.gen(function* () {
          const taskStore = yield* a2aState.getTaskStore(agent.id);
          const contextHistoryStore = yield* a2aState.getContextHistoryStore(agent.id);
          const skills = yield* skillRegistry.list();
          const assignedSkills = skills.filter((skill) => agent.skillIds.includes(skill.id));
          const skillInstructions = assignedSkills.length === 0
            ? ''
            : `\n\nAvailable agent skills:\n${assignedSkills.map((skill) => `- ${skill.id}: ${skill.description}`).join('\n')}\nWhen a task matches one of these skills, call load_skill with the skill id before proceeding.`;

          const executor = new AgentTaskExecutor(
            agent.id,
            agent.name,
            `${agent.instructions}${skillInstructions}`,
            agent.model,
            (agentId) => Effect.runPromiseWith(effectContext)(executorRegistry.createTools(agentId)),
            contextHistoryStore,
          );

          return new DefaultRequestHandler(
            createAgentCard({ agent, url: buildAgentA2aUrl(baseUrl, agent.id) }),
            taskStore,
            executor,
          );
        }).pipe(Effect.withSpan('AgentA2aHandlers.get', { attributes: { 'agent.id': agent.id } })),
    });
  }),
);
