import {
  AgentList,
  type AgentRecord,
  AgentRecord as AgentSchema,
  ExternalA2aAgent,
  ExternalA2aAgentList,
} from 'agentdock-sdk/schemas';
import { agentsTable, type DatabaseClient, externalA2aAgentsTable, tryDbWith } from 'db';
import { eq } from 'drizzle-orm';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

type DbEffect<E, A> = Effect.Effect<A, E>;

const decodeAgent = Schema.decodeUnknownSync(AgentList);
const decodeSingleAgent = Schema.decodeUnknownSync(AgentSchema);
const decodeExternalA2aAgent = Schema.decodeUnknownSync(ExternalA2aAgent);
const decodeExternalA2aAgentList = Schema.decodeUnknownSync(ExternalA2aAgentList);

export const createAgentRepo = <E>(db: DatabaseClient, makeError: (cause: unknown) => E) => {
  const tryDb = tryDbWith(makeError);

  return {
    insertPublicAgent: (row: typeof agentsTable.$inferInsert): DbEffect<E, void> =>
      tryDb(() => db.insert(agentsTable).values(row).run()).pipe(Effect.asVoid),
    updatePublicAgent: (agentId: string, row: typeof agentsTable.$inferInsert): DbEffect<E, boolean> =>
      tryDb(() => db.update(agentsTable).set(row).where(eq(agentsTable.id, agentId)).run()).pipe(
        Effect.map((result) => result.rowsAffected > 0),
      ),
    listPublicAgents: (): DbEffect<E, ReadonlyArray<AgentRecord>> =>
      tryDb(() => db.select().from(agentsTable).where(eq(agentsTable.visibility, 'public')).all()).pipe(
        Effect.map((rows) => decodeAgent(rows)),
      ),
    getPublicAgentById: (agentId: string): DbEffect<E, AgentRecord | null> =>
      tryDb(() => db.select().from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1).all()).pipe(
        Effect.map((agents) => (agents[0] ? decodeSingleAgent(agents[0]) : null)),
      ),
    removePublicAgent: (agentId: string): DbEffect<E, boolean> =>
      tryDb(() => db.delete(agentsTable).where(eq(agentsTable.id, agentId)).run()).pipe(
        Effect.map((result) => result.rowsAffected > 0),
      ),
    insertExternalAgent: (agent: typeof externalA2aAgentsTable.$inferInsert): DbEffect<E, void> =>
      tryDb(() => db.insert(externalA2aAgentsTable).values(agent).run()).pipe(Effect.asVoid),
    updateExternalAgent: (agentId: string, agent: typeof externalA2aAgentsTable.$inferInsert): DbEffect<E, boolean> =>
      tryDb(() =>
        db.update(externalA2aAgentsTable).set(agent).where(eq(externalA2aAgentsTable.id, agentId)).run(),
      ).pipe(Effect.map((result) => result.rowsAffected > 0)),
    listExternalAgents: (): DbEffect<E, ReadonlyArray<typeof ExternalA2aAgent.Type>> =>
      tryDb(() => db.select().from(externalA2aAgentsTable).all()).pipe(Effect.map(decodeExternalA2aAgentList)),
    getExternalAgentById: (agentId: string): DbEffect<E, typeof ExternalA2aAgent.Type | null> =>
      tryDb(() =>
        db.select().from(externalA2aAgentsTable).where(eq(externalA2aAgentsTable.id, agentId)).limit(1).all(),
      ).pipe(Effect.map((agents) => (agents[0] ? decodeExternalA2aAgent(agents[0]) : null))),
    getExternalAgentRowById: (agentId: string): DbEffect<E, typeof externalA2aAgentsTable.$inferSelect | null> =>
      tryDb(() =>
        db.select().from(externalA2aAgentsTable).where(eq(externalA2aAgentsTable.id, agentId)).limit(1).all(),
      ).pipe(Effect.map((agents) => agents[0] ?? null)),
    removeExternalAgent: (agentId: string): DbEffect<E, boolean> =>
      tryDb(() => db.delete(externalA2aAgentsTable).where(eq(externalA2aAgentsTable.id, agentId)).run()).pipe(
        Effect.map((result) => result.rowsAffected > 0),
      ),
  };
};
