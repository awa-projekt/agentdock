import { eq } from 'drizzle-orm';
import { db, agentsTable } from 'db';
import { Context, Data, Effect, Layer, Schema } from 'effect';
import {
  AgentListSchema,
  AgentSchema,
  CreateAgentInputSchema,
  UpdateAgentInputSchema,
  type Agent,
  type CreateAgentInput,
  type UpdateAgentInput,
} from './schemas';
import { INTERNAL_AGENTS } from './internal-agents.config';

type AgentRegistryService = {
  readonly add: (input: CreateAgentInput) => Effect.Effect<Agent, unknown>;
  readonly update: (agentId: string, input: UpdateAgentInput) => Effect.Effect<Agent | null, unknown>;
  readonly list: () => Effect.Effect<ReadonlyArray<Agent>, unknown>;
  readonly listInternal: () => Effect.Effect<ReadonlyArray<Agent>, unknown>;
  readonly getById: (agentId: string) => Effect.Effect<Agent | null, unknown>;
  readonly remove: (agentId: string) => Effect.Effect<boolean, unknown>;
};

const decodeCreateAgentInput = Schema.decodeUnknownSync(CreateAgentInputSchema);
const decodeUpdateAgentInput = Schema.decodeUnknownSync(UpdateAgentInputSchema);
const decodeAgent = Schema.decodeUnknownSync(AgentSchema);
const decodeAgentList = Schema.decodeUnknownSync(AgentListSchema);

class AgentRegistryError extends Data.TaggedError('AgentRegistryError')<{
  readonly cause: unknown;
}> {}

const toAgentRegistryError = (cause: unknown): AgentRegistryError => new AgentRegistryError({ cause });
const tryDb = <A>(try_: () => Promise<A>): Effect.Effect<A, AgentRegistryError> =>
  Effect.tryPromise({ try: try_, catch: toAgentRegistryError });

const internalAgents = decodeAgentList(INTERNAL_AGENTS);
const getInternalAgent = (agentId: string): Agent | null => internalAgents.find((agent) => agent.id === agentId) ?? null;

const addAgentToRegistry = Effect.fn('AgentRegistry.addAgentToRegistry')(function* (input: CreateAgentInput) {
  const validatedInput = decodeCreateAgentInput(input);
  const agent = decodeAgent({
    ...validatedInput,
    id: crypto.randomUUID().replaceAll('-', '').slice(0, 8),
    visibility: 'public',
  });

  yield* tryDb(() => db.insert(agentsTable).values(agent).run());
  return agent;
});

const listAgents = Effect.fn('AgentRegistry.listAgents')(function* () {
  const rows = yield* tryDb(() => db.select().from(agentsTable).where(eq(agentsTable.visibility, 'public')).all());
  return decodeAgentList(rows);
});

const getAgentById = Effect.fn('AgentRegistry.getAgentById')(function* (agentId: string) {
  const internalAgent = getInternalAgent(agentId);
  if (internalAgent) {
    return internalAgent;
  }

  const agents = yield* tryDb(() =>
    db.select().from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1).all(),
  );

  return agents[0] ? decodeAgent(agents[0]) : null;
});

const updateAgentInRegistry = Effect.fn('AgentRegistry.updateAgentInRegistry')(function* (
  agentId: string,
  input: UpdateAgentInput,
) {
  if (getInternalAgent(agentId)) {
    return null;
  }

  const validatedInput = decodeUpdateAgentInput(input);
  const agent = decodeAgent({
    ...validatedInput,
    id: agentId,
    visibility: 'public',
  });
  const result = yield* tryDb(() => db.update(agentsTable).set(agent).where(eq(agentsTable.id, agentId)).run());

  return result.rowsAffected > 0 ? agent : null;
});

const removeAgent = Effect.fn('AgentRegistry.removeAgent')(function* (agentId: string) {
  if (getInternalAgent(agentId)) {
    return false;
  }

  const result = yield* tryDb(() => db.delete(agentsTable).where(eq(agentsTable.id, agentId)).run());

  return result.rowsAffected > 0;
});

export const AgentRegistry = Context.Service<AgentRegistryService>('@agentdock/api/AgentRegistry');

export const AgentRegistryLive = Layer.effect(
  AgentRegistry,
  Effect.gen(function* () {
    return AgentRegistry.of({
      add: Effect.fn('AgentRegistry.add')(function* (input: CreateAgentInput) {
        return yield* addAgentToRegistry(input);
      }),
      update: Effect.fn('AgentRegistry.update')(function* (agentId: string, input: UpdateAgentInput) {
        return yield* updateAgentInRegistry(agentId, input);
      }),
      list: Effect.fn('AgentRegistry.list')(function* () {
        return yield* listAgents();
      }),
      listInternal: Effect.fn('AgentRegistry.listInternal')(function* () {
        return internalAgents;
      }),
      getById: Effect.fn('AgentRegistry.getById')(function* (agentId: string) {
        return yield* getAgentById(agentId);
      }),
      remove: Effect.fn('AgentRegistry.remove')(function* (agentId: string) {
        return yield* removeAgent(agentId);
      }),
    });
  }),
);
