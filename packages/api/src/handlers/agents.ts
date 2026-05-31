import { HttpServerResponse } from 'effect/unstable/http';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Effect } from 'effect';
import { get_encoding } from 'tiktoken';
import { AgentdockApi } from '../api';
import { AgentCommunicationPolicy, WILDCARD_TARGET } from '../agents/communication-policy';
import { AgentRegistry } from '../agents/service';
import { AgentExecutorRegistry } from '../executor/service';
import { SkillRegistry } from '../skills/service';
import { withHttpRootSpan } from '../tracing';
import { type Agent } from '../agents/schemas';

const jsonResponse = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe(
    {
      error,
    },
    { status },
  );

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const syncCommunicationPolicy = (agent: Agent) =>
  AgentCommunicationPolicy.use((policy) =>
    policy.replaceForAgent({
      sourceAgentId: agent.id,
      targetAgentIds: agent.communication.allowAll ? [WILDCARD_TARGET] : agent.communication.allowedAgentIds,
    }),
  );

const skillInstructionsFor = (skills: ReadonlyArray<{ readonly id: string; readonly description: string }>): string =>
  skills.length === 0
    ? ''
    : `\n\nAvailable agent skills:\n${skills.map((skill) => `- ${skill.id}: ${skill.description}`).join('\n')}\nWhen a task matches one of these skills, call load_skill with the skill id before proceeding.`;

const countTokens = (text: string): number => {
  const encoding = get_encoding('cl100k_base');
  try {
    return encoding.encode(text).length;
  } finally {
    encoding.free();
  }
};

const readNumber = (value: unknown): number | undefined => typeof value === 'number' ? value : undefined;
const readString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

const fetchModelInfo = (model: string) =>
  Effect.tryPromise({
    try: async () => {
      const parts = model.split(':', 2);
      const provider = model.includes(':') ? parts[0] ?? 'unknown' : 'unknown';
      const modelId = model.includes(':') ? parts[1] ?? model : model;
      const response = await fetch('https://models.dev/api.json');
      if (!response.ok) throw new Error(`models.dev responded ${response.status}`);
      const data = await response.json() as Record<string, unknown>;
      const providerData = data[provider] as { readonly models?: Record<string, unknown> } | undefined;
      const rawModel = providerData?.models?.[modelId] as Record<string, unknown> | undefined;
      const contextWindow = readNumber(rawModel?.context_length ?? rawModel?.contextWindow);
      const maxOutputTokens = readNumber(rawModel?.max_output_tokens ?? rawModel?.maxOutputTokens);
      const pricing = rawModel?.pricing as Record<string, unknown> | undefined;
      const inputCostPerMillion = readNumber(pricing?.input);
      const outputCostPerMillion = readNumber(pricing?.output);
      const info: {
        id: string;
        provider: string;
        name: string;
        contextWindow?: number;
        maxOutputTokens?: number;
        inputCostPerMillion?: number;
        outputCostPerMillion?: number;
      } = {
        id: modelId,
        provider,
        name: readString(rawModel?.name) ?? modelId,
      };
      if (contextWindow !== undefined) info.contextWindow = contextWindow;
      if (maxOutputTokens !== undefined) info.maxOutputTokens = maxOutputTokens;
      if (inputCostPerMillion !== undefined) info.inputCostPerMillion = inputCostPerMillion;
      if (outputCostPerMillion !== undefined) info.outputCostPerMillion = outputCostPerMillion;
      return info;
    },
    catch: () => undefined,
  }).pipe(Effect.map((info) => info ?? {
    id: model.includes(':') ? model.split(':', 2)[1] ?? model : model,
    provider: model.includes(':') ? model.split(':', 2)[0] ?? 'unknown' : 'unknown',
    name: model,
  }));

export const agentsHandler = HttpApiBuilder.group(AgentdockApi, 'agents', (handlers) =>
  handlers
    .handle('listAgents', () =>
      AgentRegistry.use((registry) => registry.list()).pipe(
        withHttpRootSpan('agentdock.http.request.agents.list'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to list agents'))),
        ),
      ),
    )
    .handle('addAgent', ({ payload }) =>
      AgentRegistry.use((registry) => registry.add(payload)).pipe(
        Effect.tap(syncCommunicationPolicy),
        withHttpRootSpan('agentdock.http.request.agents.add'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to add agent'))),
        ),
      ),
    )
    .handle('updateAgent', ({ params, payload }) =>
      Effect.gen(function* () {
        const registry = yield* AgentRegistry;
        const agent = yield* registry.update(params.agentId, payload);

        if (!agent) {
          return jsonResponse(404, 'Agent not found');
        }

        yield* syncCommunicationPolicy(agent);
        return agent;
      }).pipe(
        withHttpRootSpan('agentdock.http.request.agents.update'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to update agent'))),
        ),
      ),
    )
    .handle('getAgentInternals', ({ params }) =>
      Effect.gen(function* () {
        const registry = yield* AgentRegistry;
        const skillRegistry = yield* SkillRegistry;
        const executorRegistry = yield* AgentExecutorRegistry;
        const agent = (yield* registry.list()).find((candidate) => candidate.id === params.agentId);

        if (!agent) {
          return jsonResponse(404, 'Agent not found');
        }

        const [skills, executorSources, model] = yield* Effect.all([
          skillRegistry.list(),
          executorRegistry.listSources(agent.id),
          fetchModelInfo(agent.model),
        ]);
        const assignedSkills = skills.filter((skill) => agent.skillIds.includes(skill.id));
        const finalInstructions = `${agent.instructions}${skillInstructionsFor(assignedSkills)}`;

        return {
          agentId: agent.id,
          model,
          tools: [
            { id: 'list_agents', name: 'list_agents', source: 'internal' as const, active: true, description: 'List the available A2A agents and their A2A endpoint URLs.' },
            { id: 'send_task', name: 'send_task', source: 'internal' as const, active: true, description: 'Send a blocking task to an A2A agent and return its final text message.' },
            { id: 'load_skill', name: 'load_skill', source: 'internal' as const, active: true, description: 'Load the full SKILL.md instructions for a skill assigned to this agent. Use when the user task matches an available skill.' },
            ...executorSources.tools.map((tool) => ({
              id: tool.id,
              name: tool.name,
              source: 'executor' as const,
              description: tool.description,
              active: tool.mode !== 'disabled',
              mode: tool.mode,
            })),
          ],
          prompt: {
            editableInstructions: agent.instructions,
            finalInstructions,
            tokenCount: countTokens(finalInstructions),
          },
        };
      }).pipe(
        withHttpRootSpan('agentdock.http.request.agents.internals'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to inspect agent internals'))),
        ),
      ),
    )
    .handle('removeAgent', ({ params }) =>
      AgentRegistry.use((registry) => registry.remove(params.agentId)).pipe(
        Effect.tap((removed) =>
          removed
            ? AgentCommunicationPolicy.use((policy) =>
                policy.replaceForAgent({ sourceAgentId: params.agentId, targetAgentIds: [] }),
              )
            : Effect.void,
        ),
        Effect.map((removed) => ({ removed })),
        Effect.withSpan('agentdock.http.agents.remove', {
          attributes: { 'agent.id': params.agentId },
        }),
        withHttpRootSpan('agentdock.http.request.agents.remove'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to remove agent'))),
        ),
      ),
    )
);
