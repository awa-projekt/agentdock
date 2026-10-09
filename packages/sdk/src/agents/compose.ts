import * as Effect from 'effect/Effect';
import type { AgentDefinition } from './definition';
import { createAgentGraph } from './langgraph-loop';
import { ModelProvider } from './model-provider';
import { type AgentToolContext, AgentToolResolver } from './tool-resolver';

export const buildAgentGraph = (agent: AgentDefinition, context: AgentToolContext) =>
  Effect.gen(function* () {
    const models = yield* ModelProvider;
    const resolver = yield* AgentToolResolver;
    const model = yield* models.resolve(agent.model);
    const tools = yield* resolver.resolve(agent, context);
    const options = { name: agent.id, model, systemPrompt: agent.instructions, tools };
    return createAgentGraph(agent.outputSchema ? { ...options, responseFormat: agent.outputSchema } : options).graph;
  });
