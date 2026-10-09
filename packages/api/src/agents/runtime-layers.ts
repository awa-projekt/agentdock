import {
  type AgentDefinition,
  AgentLoopFactory,
  AgentLoopFactoryLive,
  AgentRunError,
  AgentRunStore,
  type AgentToolContext,
  AgentToolResolver,
  type AgentToolSet,
  agentOutputSchema,
  createSkillToolsFromLoader,
  defineAgentTool,
  ModelProvider,
  ModelProviderError,
  parseModelString,
  randomUUIDv4,
  runAgent,
  SkillLoadError,
  ToolResolverError,
} from 'agentdock-sdk';
import type { AgentRecord, AgentRunPart, JsonSerializableObject } from 'agentdock-sdk/schemas';
import type { Database } from 'db';
import type * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { z } from 'zod';
import { AgentToolSetFactory } from '../gateway/tools';
import { type ProviderKeyError, ProviderKeyRegistry } from '../providers/service';
import { agentInstructions } from '../skills/prompt';
import { SkillRegistry, type SkillRegistryError } from '../skills/service';
import { AgentCommunicationPolicy } from './communication-policy';
import { AgentRunStoreLive } from './run-store';

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * Resolves the final `AgentDefinition` an agent runs with: instructions with
 * its skills folded in (see `agentInstructions`) and the parsed output-contract
 * schema. Shared by `AgentA2aHandlers` (live a2a calls) and
 * `WorkflowA2aHandlers` (internal workflow-node bindings) so both paths see
 * the exact same instructions for the same agent.
 */
export const resolveAgentDefinition = (
  agent: AgentRecord,
): Effect.Effect<AgentDefinition, SkillRegistryError, Context.Service.Identifier<typeof SkillRegistry>> =>
  Effect.gen(function* () {
    const skillRegistry = yield* SkillRegistry;
    const { instructions, skills } = agentInstructions(agent, yield* skillRegistry.list());
    return {
      id: agent.id,
      name: agent.name,
      instructions,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort ?? undefined,
      skills,
      outputSchema: agentOutputSchema(agent),
    };
  });

const ModelProviderLive = Layer.effect(
  ModelProvider,
  Effect.gen(function* () {
    const providerKeyRegistry = yield* ProviderKeyRegistry;
    return ModelProvider.of({
      resolve: (model) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => parseModelString(model),
            catch: (error) => new ModelProviderError({ message: errorMessage(error), error }),
          });
          const modelConfig = yield* providerKeyRegistry
            .getRuntimeConfig(parsed.provider)
            .pipe(
              Effect.mapError(
                (error: ProviderKeyError) => new ModelProviderError({ message: errorMessage(error), error }),
              ),
            );
          return { model, ...parsed, config: modelConfig ?? undefined };
        }),
    });
  }),
);

const textFromParts = (parts: ReadonlyArray<AgentRunPart> | undefined): string =>
  (parts ?? []).flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('');

type DelegationProgress = {
  readonly taskId: string;
  readonly state: string;
  readonly text?: string;
  readonly event?: JsonSerializableObject;
};

/**
 * Runs a delegated task through `runAgent`, so the subagent's run is recorded
 * like any other, and relays each loop event to the caller's stream as a
 * `send-task-progress` part. A subagent's own `send_task` calls relay through
 * the same `emit`, so deeper delegations arrive nested inside their parent's
 * `event`, which is how the chat renders delegation depth.
 */
const delegate = (
  target: AgentRecord,
  message: string,
  context: AgentToolContext,
): Effect.Effect<
  { readonly taskId: string; readonly state: string; readonly text: string },
  AgentRunError | SkillRegistryError,
  | AgentLoopFactory
  | ModelProvider
  | AgentToolResolver
  | AgentRunStore
  | Context.Service.Identifier<typeof SkillRegistry>
> =>
  Effect.gen(function* () {
    const definition = context.deployment
      ? { ...target, outputSchema: agentOutputSchema(target) }
      : yield* resolveAgentDefinition(target);
    const taskId = yield* randomUUIDv4;
    const relay = (progress: DelegationProgress): void =>
      context.emit?.({
        type: 'send-task-progress',
        toolName: 'send_task',
        agentId: target.id,
        agentName: target.name,
        ...progress,
      });
    const relayEvent = (event: JsonSerializableObject): void => relay({ taskId, state: 'working', event });

    relay({ taskId, state: 'submitted' });
    const result = yield* runAgent(
      definition,
      { parts: [{ kind: 'text', text: message }] },
      {
        taskId,
        origin: { surface: 'delegation', parentTaskId: context.taskId },
        deployment: context.deployment,
        integrations: context.integrations,
        emit: relayEvent,
        onEvent: (event) => {
          switch (event.type) {
            case 'reasoning':
              return relayEvent({ type: 'reasoning', text: event.text });
            case 'tool-call':
              return relayEvent({
                type: 'tool-call',
                toolName: event.toolName,
                toolCallId: event.toolCallId,
                input: event.input,
              });
            case 'tool-result':
              return relayEvent({
                type: 'tool-result',
                toolName: event.toolName,
                toolCallId: event.toolCallId,
                output: event.output,
              });
            case 'tool-error':
              return relayEvent({
                type: 'tool-error',
                toolName: event.toolName,
                toolCallId: event.toolCallId,
                error: event.error,
              });
            case 'model-call':
              // Relayed so a caller can account for what its subagents spent.
              return relayEvent({
                type: 'model-call',
                model: event.model,
                usage: event.usage,
                toolCalls: event.toolCalls,
                reasoningEstimated: event.reasoningEstimated,
              });
            default:
              return;
          }
        },
      },
    );
    if (result.status === 'failed') {
      const reason = textFromParts(result.record.status.message?.parts) || 'Subagent run failed';
      relay({ taskId, state: 'failed', text: reason });
      return yield* new AgentRunError({ message: reason, error: undefined });
    }
    relay({ taskId, state: result.status, text: result.text });
    return { taskId, state: result.status, text: result.text };
  });

/**
 * An agent's tools: `load_skill` when it has skills assigned, its integration
 * tools, and `list_agents`/`send_task` when its communication policy allows
 * at least one delegation target.
 */
const AgentToolResolverLive = Layer.effect(
  AgentToolResolver,
  Effect.gen(function* () {
    const toolSetFactory = yield* AgentToolSetFactory;
    const skillRegistry = yield* SkillRegistry;
    const effectContext = yield* Effect.context<never>();
    const policy = yield* AgentCommunicationPolicy;
    const models = yield* ModelProvider;
    const loopFactory = yield* AgentLoopFactory;
    const runStore = yield* AgentRunStore;
    const resolve = (
      agent: AgentDefinition,
      context: AgentToolContext,
    ): Effect.Effect<AgentToolSet, ToolResolverError> =>
      Effect.gen(function* () {
        const skillIds = Object.entries(agent.skills ?? {}).flatMap(([id, mode]) => (mode === 'on-demand' ? [id] : []));
        const skillTools =
          skillIds.length === 0
            ? []
            : createSkillToolsFromLoader((skillId) =>
                (skillIds.includes(skillId) ? skillRegistry.get(skillId) : Effect.succeed(null)).pipe(
                  Effect.map(
                    (skill) =>
                      skill?.content ??
                      `No skill "${skillId}" is assigned to this agent. Available skills: ${skillIds.join(', ')}.`,
                  ),
                  Effect.mapError(
                    (cause) => new SkillLoadError({ message: `Failed to load skill ${skillId}.`, cause }),
                  ),
                  Effect.provide(effectContext),
                ),
              );
        const executorTools = yield* toolSetFactory
          .createTools(agent.id, context)
          .pipe(Effect.mapError((error) => new ToolResolverError({ message: errorMessage(error), error })));
        const allowedTargets = yield* policy
          .listAllowedTargets(agent.id)
          .pipe(Effect.mapError((error) => new ToolResolverError({ message: errorMessage(error), error })));
        const targets = context.deployment
          ? context.deployment.agents.filter((candidate) => allowedTargets.some((target) => target.id === candidate.id))
          : allowedTargets;
        const delegation =
          targets.length === 0
            ? []
            : [
                defineAgentTool({
                  name: 'list_agents',
                  description: 'List available specialist agents.',
                  schema: z.object({}),
                  invoke: async () =>
                    targets.map((target) => ({ id: target.id, name: target.name, description: target.description })),
                }),
                defineAgentTool({
                  name: 'send_task',
                  description: 'Delegate a task to a specialist agent and await its result.',
                  schema: z.object({ agentId: z.string(), message: z.string() }),
                  invoke: async ({ agentId, message }) => {
                    const target = targets.find((candidate) => candidate.id === agentId);
                    if (!target) throw new Error(`Agent '${agentId}' is not an allowed delegation target.`);
                    return Effect.runPromiseWith(effectContext)(
                      delegate(target, message, context).pipe(
                        Effect.provideService(AgentToolResolver, AgentToolResolver.of({ resolve })),
                        Effect.provideService(AgentLoopFactory, loopFactory),
                        Effect.provideService(AgentRunStore, runStore),
                        Effect.provideService(ModelProvider, models),
                        Effect.provideService(SkillRegistry, skillRegistry),
                      ),
                    );
                  },
                }),
              ];
        return [...skillTools, ...executorTools, ...delegation];
      });
    return AgentToolResolver.of({ resolve });
  }),
);

export const RuntimeHostLayer: Layer.Layer<
  AgentLoopFactory | ModelProvider | AgentToolResolver | AgentRunStore,
  never,
  | Context.Service.Identifier<typeof ProviderKeyRegistry>
  | Context.Service.Identifier<typeof AgentToolSetFactory>
  | Context.Service.Identifier<typeof SkillRegistry>
  | Context.Service.Identifier<typeof Database>
  | Context.Service.Identifier<typeof AgentCommunicationPolicy>
> = AgentToolResolverLive.pipe(
  Layer.provideMerge(Layer.mergeAll(AgentLoopFactoryLive, AgentRunStoreLive)),
  Layer.provideMerge(ModelProviderLive),
);
