import { type A2ARequestHandler, DefaultRequestHandler } from '@a2a-js/sdk/server';
import {
  type AgentLoopFactory,
  type AgentRunStore,
  AgentTaskExecutor,
  type AgentToolResolver,
  agentOutputSchema,
  createAgentCard,
  graphThreadId,
  type ModelProvider,
  runAgent,
} from 'agentdock-sdk';
import type { AgentRecord } from 'agentdock-sdk/schemas';
import { Database } from 'db';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { resolveAgentDefinition } from '../agents/runtime-layers';
import { AgentRegistry, type AgentRegistryError } from '../agents/service';
import { buildAgentA2aUrl } from '../routes';
import { GraphRuntime } from '../runtime/service';
import { SessionsService, type SessionsServiceError } from '../sessions/service';
import type { SkillRegistry, SkillRegistryError } from '../skills/service';
import { DrizzleLibsqlCheckpointSaver } from '../workflows/langgraph-checkpointer';

export type AgentA2aHandlerError = SessionsServiceError | SkillRegistryError | AgentRegistryError;
export const AgentA2aHandlers = Context.Service<{
  readonly get: (
    agent: AgentRecord,
    baseUrl: string,
  ) => Effect.Effect<A2ARequestHandler, AgentA2aHandlerError, Context.Service.Identifier<typeof SkillRegistry>>;
}>('@agentdock/api/AgentA2aHandlers');

export const AgentA2aHandlersLive = Layer.effect(
  AgentA2aHandlers,
  Effect.gen(function* () {
    const sessions = yield* SessionsService;
    const database = yield* Database;
    const runtime = yield* GraphRuntime;
    const registry = yield* AgentRegistry;
    const runtimeContext = yield* Effect.context<
      AgentLoopFactory | ModelProvider | AgentToolResolver | AgentRunStore
    >();
    runtime.register(
      'agent',
      async (deployment, recover, lease) => {
        const checkpointer = new DrizzleLibsqlCheckpointSaver(database.db, lease);
        if (deployment.kind !== 'agent') throw new Error('Expected agent deployment.');
        const agent = deployment.agent;
        const outputSchema = agentOutputSchema(agent);
        const history = await Effect.runPromiseWith(runtimeContext)(sessions.getContextHistoryStore(agent.id));
        return new AgentTaskExecutor(
          {
            id: agent.id,
            name: agent.name,
            instructions: agent.instructions,
            model: agent.model,
            skills: agent.skills,
            outputSchema,
          },
          (input, options) =>
            Effect.runPromiseWith(runtimeContext)(
              runAgent({ ...agent, outputSchema }, input, {
                ...options,
                checkpointer,
                threadId: graphThreadId(`agent:${agent.id}`, options.contextId ?? ''),
                recover,
                deployment,
              }),
            ),
          history,
        );
      },
      async (deployment, task) => {
        if (deployment.kind !== 'agent') return;
        const store = await Effect.runPromiseWith(runtimeContext)(sessions.getTaskStore(deployment.agent.id));
        await store.save(task);
      },
    );
    return AgentA2aHandlers.of({
      get: Effect.fn('AgentA2aHandlers.get')(function* (agent, baseUrl) {
        const definition = yield* resolveAgentDefinition(agent);
        const taskStore = yield* sessions.getTaskStore(agent.id);
        const records = yield* registry.list();
        const agents = yield* Effect.forEach(records, (record) =>
          resolveAgentDefinition(record).pipe(
            Effect.map((resolved) => ({ ...record, instructions: resolved.instructions })),
          ),
        );
        return new DefaultRequestHandler(
          createAgentCard({ agent, url: buildAgentA2aUrl(baseUrl, agent.id) }),
          taskStore,
          runtime.executor({ kind: 'agent', agent: { ...agent, instructions: definition.instructions }, agents }),
        );
      }),
    });
  }),
);
