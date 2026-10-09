import { AgentList, type AgentRecord } from 'agentdock-sdk/schemas';
import { agentCommunicationRulesTable, agentsTable, Database, type DatabaseClient, DatabaseLive, tryDbWith } from 'db';
import { and, eq, or } from 'drizzle-orm';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';

const WILDCARD_TARGET = '*';

export type AgentCommunicationPolicyService = {
  readonly listAllowedTargets: (
    sourceAgentId: string,
  ) => Effect.Effect<ReadonlyArray<AgentRecord>, AgentCommunicationPolicyError>;
  readonly isAllowed: (input: {
    readonly sourceAgentId: string;
    readonly targetAgentId: string;
  }) => Effect.Effect<boolean, AgentCommunicationPolicyError>;
  readonly allow: (input: {
    readonly sourceAgentId: string;
    readonly targetAgentId: string;
  }) => Effect.Effect<void, AgentCommunicationPolicyError>;
  readonly replaceForAgent: (input: {
    readonly sourceAgentId: string;
    readonly targetAgentIds: ReadonlyArray<string>;
  }) => Effect.Effect<void, AgentCommunicationPolicyError>;
  readonly clear: () => Effect.Effect<void, AgentCommunicationPolicyError>;
};

const decodeAgentList = Schema.decodeUnknownSync(AgentList);

const excludeSourceAgent = (sourceAgentId: string, agents: ReadonlyArray<AgentRecord>): ReadonlyArray<AgentRecord> =>
  agents.filter((agent) => agent.id !== sourceAgentId);
export class AgentCommunicationPolicyError extends Schema.TaggedError<AgentCommunicationPolicyError>()(
  'AgentCommunicationPolicyError',
  { cause: Schema.Defect() },
) {}

const toAgentCommunicationPolicyError = (cause: unknown): AgentCommunicationPolicyError =>
  new AgentCommunicationPolicyError({ cause });
const tryDb = tryDbWith(toAgentCommunicationPolicyError);

const listAllowedTargets = (db: DatabaseClient) =>
  Effect.fn('AgentCommunicationPolicy.listAllowedTargetsQuery')(function* (sourceAgentId: string) {
    const rules = yield* tryDb(() =>
      db
        .select()
        .from(agentCommunicationRulesTable)
        .where(eq(agentCommunicationRulesTable.sourceAgentId, sourceAgentId))
        .all(),
    );

    if (rules.length === 0) {
      return [];
    }

    if (rules.some((rule) => rule.targetAgentId === WILDCARD_TARGET)) {
      const agents = yield* tryDb(() => db.select().from(agentsTable).all());
      return excludeSourceAgent(sourceAgentId, decodeAgentList(agents));
    }

    const allowedTargetIds = new Set(rules.map((rule) => rule.targetAgentId));
    const agents = yield* tryDb(() => db.select().from(agentsTable).all());

    return excludeSourceAgent(
      sourceAgentId,
      decodeAgentList(agents).filter((agent) => allowedTargetIds.has(agent.id)),
    );
  });

const isAllowed = (db: DatabaseClient) =>
  Effect.fn('AgentCommunicationPolicy.isAllowedQuery')(function* ({
    sourceAgentId,
    targetAgentId,
  }: {
    readonly sourceAgentId: string;
    readonly targetAgentId: string;
  }) {
    if (sourceAgentId === targetAgentId) {
      return false;
    }

    const rules = yield* tryDb(() =>
      db
        .select()
        .from(agentCommunicationRulesTable)
        .where(
          and(
            eq(agentCommunicationRulesTable.sourceAgentId, sourceAgentId),
            or(
              eq(agentCommunicationRulesTable.targetAgentId, targetAgentId),
              eq(agentCommunicationRulesTable.targetAgentId, WILDCARD_TARGET),
            ),
          ),
        )
        .limit(1)
        .all(),
    );

    return rules.length > 0;
  });

const allow = (db: DatabaseClient) =>
  Effect.fn('AgentCommunicationPolicy.allowQuery')(function* ({
    sourceAgentId,
    targetAgentId,
  }: {
    readonly sourceAgentId: string;
    readonly targetAgentId: string;
  }) {
    yield* tryDb(() =>
      db.insert(agentCommunicationRulesTable).values({ sourceAgentId, targetAgentId }).onConflictDoNothing().run(),
    );
  });

const replaceForAgent = (db: DatabaseClient) => {
  const allowRule = allow(db);
  return Effect.fn('AgentCommunicationPolicy.replaceForAgentQuery')(function* ({
    sourceAgentId,
    targetAgentIds,
  }: {
    readonly sourceAgentId: string;
    readonly targetAgentIds: ReadonlyArray<string>;
  }) {
    yield* tryDb(() =>
      db
        .delete(agentCommunicationRulesTable)
        .where(eq(agentCommunicationRulesTable.sourceAgentId, sourceAgentId))
        .run(),
    );

    for (const targetAgentId of targetAgentIds) {
      yield* allowRule({ sourceAgentId, targetAgentId });
    }
  });
};

const clear = (db: DatabaseClient) =>
  Effect.fn('AgentCommunicationPolicy.clearQuery')(function* () {
    yield* tryDb(() => db.delete(agentCommunicationRulesTable).run());
  });

export const AgentCommunicationPolicy = Context.Service<AgentCommunicationPolicyService>(
  '@agentdock/api/AgentCommunicationPolicy',
);

export const AgentCommunicationPolicyLive = Layer.effect(
  AgentCommunicationPolicy,
  Effect.gen(function* () {
    const { db } = yield* Database;
    const listAllowedTargetsQuery = listAllowedTargets(db);
    const isAllowedQuery = isAllowed(db);
    const allowQuery = allow(db);
    const replaceForAgentQuery = replaceForAgent(db);
    const clearQuery = clear(db);
    return AgentCommunicationPolicy.of({
      listAllowedTargets: Effect.fn('AgentCommunicationPolicy.listAllowedTargets')(function* (sourceAgentId: string) {
        return yield* listAllowedTargetsQuery(sourceAgentId);
      }),
      isAllowed: Effect.fn('AgentCommunicationPolicy.isAllowed')(function* (input: {
        readonly sourceAgentId: string;
        readonly targetAgentId: string;
      }) {
        return yield* isAllowedQuery(input);
      }),
      allow: Effect.fn('AgentCommunicationPolicy.allow')(function* (input: {
        readonly sourceAgentId: string;
        readonly targetAgentId: string;
      }) {
        return yield* allowQuery(input);
      }),
      replaceForAgent: Effect.fn('AgentCommunicationPolicy.replaceForAgent')(function* (input: {
        readonly sourceAgentId: string;
        readonly targetAgentIds: ReadonlyArray<string>;
      }) {
        return yield* replaceForAgentQuery(input);
      }),
      clear: Effect.fn('AgentCommunicationPolicy.clear')(function* () {
        return yield* clearQuery();
      }),
    });
  }),
).pipe(Layer.provide(DatabaseLive));

export { WILDCARD_TARGET };
