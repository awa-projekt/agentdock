import { and, eq, or } from 'drizzle-orm';
import { db, agentCommunicationRulesTable, agentsTable } from 'db';
import { Context, Data, Effect, Layer, Schema } from 'effect';
import { AgentListSchema, type Agent } from './schemas';

const WILDCARD_TARGET = '*';

type AgentCommunicationPolicyService = {
  readonly listAllowedTargets: (sourceAgentId: string) => Effect.Effect<ReadonlyArray<Agent>, unknown>;
  readonly isAllowed: (input: {
    readonly sourceAgentId: string;
    readonly targetAgentId: string;
  }) => Effect.Effect<boolean, unknown>;
  readonly allow: (input: {
    readonly sourceAgentId: string;
    readonly targetAgentId: string;
  }) => Effect.Effect<void, unknown>;
  readonly replaceForAgent: (input: {
    readonly sourceAgentId: string;
    readonly targetAgentIds: ReadonlyArray<string>;
  }) => Effect.Effect<void, unknown>;
  readonly clear: () => Effect.Effect<void, unknown>;
};

const decodeAgentList = Schema.decodeUnknownSync(AgentListSchema);

const excludeSourceAgent = (sourceAgentId: string, agents: ReadonlyArray<Agent>): ReadonlyArray<Agent> =>
  agents.filter((agent) => agent.id !== sourceAgentId);
class AgentCommunicationPolicyError extends Data.TaggedError('AgentCommunicationPolicyError')<{
  readonly cause: unknown;
}> {}

const toAgentCommunicationPolicyError = (cause: unknown): AgentCommunicationPolicyError =>
  new AgentCommunicationPolicyError({ cause });
const tryDb = <A>(try_: () => Promise<A>): Effect.Effect<A, AgentCommunicationPolicyError> =>
  Effect.tryPromise({ try: try_, catch: toAgentCommunicationPolicyError });

const listAllowedTargets = Effect.fn('AgentCommunicationPolicy.listAllowedTargetsQuery')(function* (
  sourceAgentId: string,
) {
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

const isAllowed = Effect.fn('AgentCommunicationPolicy.isAllowedQuery')(function* ({ sourceAgentId, targetAgentId }: {
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

const allow = Effect.fn('AgentCommunicationPolicy.allowQuery')(function* ({ sourceAgentId, targetAgentId }: {
  readonly sourceAgentId: string;
  readonly targetAgentId: string;
}) {
  yield* tryDb(() =>
    db
      .insert(agentCommunicationRulesTable)
      .values({ sourceAgentId, targetAgentId })
      .onConflictDoNothing()
      .run(),
  );
});

const replaceForAgent = Effect.fn('AgentCommunicationPolicy.replaceForAgentQuery')(function* ({ sourceAgentId, targetAgentIds }: {
  readonly sourceAgentId: string;
  readonly targetAgentIds: ReadonlyArray<string>;
}) {
  yield* tryDb(() =>
    db.delete(agentCommunicationRulesTable).where(eq(agentCommunicationRulesTable.sourceAgentId, sourceAgentId)).run(),
  );

  for (const targetAgentId of targetAgentIds) {
    yield* allow({ sourceAgentId, targetAgentId });
  }
});

const clear = Effect.fn('AgentCommunicationPolicy.clearQuery')(function* () {
  yield* tryDb(() => db.delete(agentCommunicationRulesTable).run());
});

export const AgentCommunicationPolicy = Context.Service<AgentCommunicationPolicyService>(
  '@agentdock/api/AgentCommunicationPolicy',
);

export const AgentCommunicationPolicyLive = Layer.effect(
  AgentCommunicationPolicy,
  Effect.gen(function* () {
    return AgentCommunicationPolicy.of({
      listAllowedTargets: Effect.fn('AgentCommunicationPolicy.listAllowedTargets')(function* (
        sourceAgentId: string,
      ) {
        return yield* listAllowedTargets(sourceAgentId);
      }),
      isAllowed: Effect.fn('AgentCommunicationPolicy.isAllowed')(function* (input: {
        readonly sourceAgentId: string;
        readonly targetAgentId: string;
      }) {
        return yield* isAllowed(input);
      }),
      allow: Effect.fn('AgentCommunicationPolicy.allow')(function* (input: {
        readonly sourceAgentId: string;
        readonly targetAgentId: string;
      }) {
        return yield* allow(input);
      }),
      replaceForAgent: Effect.fn('AgentCommunicationPolicy.replaceForAgent')(function* (input: {
        readonly sourceAgentId: string;
        readonly targetAgentIds: ReadonlyArray<string>;
      }) {
        return yield* replaceForAgent(input);
      }),
      clear: Effect.fn('AgentCommunicationPolicy.clear')(function* () {
        return yield* clear();
      }),
    });
  }),
);

export { WILDCARD_TARGET };
