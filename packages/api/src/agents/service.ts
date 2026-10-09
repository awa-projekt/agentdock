import { randomUUIDv4 } from 'agentdock-sdk';
import {
  AddExternalA2aAgentInput,
  AgentList,
  AgentRecord,
  CreateAgentInput,
  ExternalA2aAgent,
  randomAgentColor,
  UpdateAgentInput,
  UpdateExternalA2aAgentInput,
} from 'agentdock-sdk/schemas';
import { Database, DatabaseLive } from 'db';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { createAgentRepo } from '../db/agents-repo';
import { ChangeFeed, ChangeFeedLive } from '../events/service';
import { INTERNAL_AGENTS } from './internal-agents.config';

type InternalAgentRegistryService = {
  readonly list: () => Effect.Effect<ReadonlyArray<AgentRecord>>;
  readonly getById: (agentId: string) => Effect.Effect<AgentRecord | null>;
};

type ExternalAgentRegistryService = {
  readonly add: (input: AddExternalA2aAgentInput) => Effect.Effect<ExternalA2aAgent, AgentRegistryError>;
  readonly update: (
    agentId: string,
    input: UpdateExternalA2aAgentInput,
  ) => Effect.Effect<ExternalA2aAgent | null, AgentRegistryError>;
  readonly list: () => Effect.Effect<ReadonlyArray<ExternalA2aAgent>, AgentRegistryError>;
  readonly getById: (agentId: string) => Effect.Effect<ExternalA2aAgent | null, AgentRegistryError>;
  readonly remove: (agentId: string) => Effect.Effect<boolean, AgentRegistryError>;
};

export type AgentRegistryService = {
  readonly add: (input: CreateAgentInput) => Effect.Effect<AgentRecord, AgentRegistryError>;
  readonly update: (
    agentId: string,
    input: UpdateAgentInput,
  ) => Effect.Effect<AgentRecord | null, AgentRegistryError | AgentRevisionConflictError>;
  readonly list: () => Effect.Effect<ReadonlyArray<AgentRecord>, AgentRegistryError>;
  readonly listInternal: () => Effect.Effect<ReadonlyArray<AgentRecord>>;
  readonly listExternal: () => Effect.Effect<ReadonlyArray<ExternalA2aAgent>, AgentRegistryError>;
  readonly addExternal: (input: AddExternalA2aAgentInput) => Effect.Effect<ExternalA2aAgent, AgentRegistryError>;
  readonly updateExternal: (
    agentId: string,
    input: UpdateExternalA2aAgentInput,
  ) => Effect.Effect<ExternalA2aAgent | null, AgentRegistryError>;
  readonly getById: (agentId: string) => Effect.Effect<AgentRecord | null, AgentRegistryError>;
  readonly getExternalById: (agentId: string) => Effect.Effect<ExternalA2aAgent | null, AgentRegistryError>;
  readonly remove: (agentId: string) => Effect.Effect<boolean, AgentRegistryError>;
  readonly removeExternal: (agentId: string) => Effect.Effect<boolean, AgentRegistryError>;
};

export class AgentRegistryError extends Schema.TaggedError<AgentRegistryError>()('AgentRegistryError', {
  cause: Schema.Defect(),
}) {}

export class AgentRevisionConflictError extends Schema.TaggedError<AgentRevisionConflictError>()(
  'AgentRevisionConflictError',
  { message: Schema.String, current: Schema.Number },
) {}

const decodeCreateAgentInput = Schema.decodeUnknownSync(CreateAgentInput);
const decodeUpdateAgentInput = Schema.decodeUnknownSync(UpdateAgentInput);
const decodeAgent = Schema.decodeUnknownSync(AgentRecord);
const decodeAgentList = Schema.decodeUnknownSync(AgentList);
const decodeAddExternalA2aAgentInput = Schema.decodeUnknownSync(AddExternalA2aAgentInput);
const decodeUpdateExternalA2aAgentInput = Schema.decodeUnknownSync(UpdateExternalA2aAgentInput);
const decodeExternalA2aAgent = Schema.decodeUnknownSync(ExternalA2aAgent);
const toAgentRegistryError = (cause: unknown): AgentRegistryError => new AgentRegistryError({ cause });

const internalAgents = decodeAgentList(INTERNAL_AGENTS);
const newAgentId = Effect.map(randomUUIDv4, (id) => id.replaceAll('-', '').slice(0, 8));

const InternalAgentRegistry = Context.Service<InternalAgentRegistryService>('@agentdock/api/InternalAgentRegistry');

const InternalAgentRegistryLive = Layer.succeed(
  InternalAgentRegistry,
  InternalAgentRegistry.of({
    list: () => Effect.succeed(internalAgents),
    getById: (agentId) => Effect.succeed(internalAgents.find((agent) => agent.id === agentId) ?? null),
  }),
);

const ExternalAgentRegistry = Context.Service<ExternalAgentRegistryService>('@agentdock/api/ExternalAgentRegistry');

const ExternalAgentRegistryLive = Layer.effect(
  ExternalAgentRegistry,
  Effect.gen(function* () {
    const { db } = yield* Database;
    const repo = createAgentRepo(db, toAgentRegistryError);
    return ExternalAgentRegistry.of({
      add: Effect.fn('ExternalAgentRegistry.add')(function* (input) {
        const validated = decodeAddExternalA2aAgentInput(input);
        const now = yield* Clock.currentTimeMillis;
        const agent = decodeExternalA2aAgent({
          ...validated,
          id: yield* newAgentId,
          visibility: 'external',
          createdAt: now,
          updatedAt: now,
        });
        yield* repo.insertExternalAgent(agent);
        return agent;
      }),
      update: Effect.fn('ExternalAgentRegistry.update')(function* (agentId, input) {
        const validated = decodeUpdateExternalA2aAgentInput(input);
        const existing = yield* repo.getExternalAgentRowById(agentId);
        if (!existing) return null;
        const agent = decodeExternalA2aAgent({
          ...validated,
          id: agentId,
          visibility: 'external',
          createdAt: existing.createdAt,
          updatedAt: yield* Clock.currentTimeMillis,
        });
        yield* repo.updateExternalAgent(agentId, agent);
        return agent;
      }),
      list: () => repo.listExternalAgents(),
      getById: (agentId) => repo.getExternalAgentById(agentId),
      remove: (agentId) => repo.removeExternalAgent(agentId),
    });
  }),
);

const addAgentToRegistry = (repo: ReturnType<typeof createAgentRepo<AgentRegistryError>>) =>
  Effect.fn('AgentRegistry.addAgentToRegistry')(function* (input: CreateAgentInput) {
    const validatedInput = decodeCreateAgentInput(input);
    const color = validatedInput.color ?? (yield* randomAgentColor);
    const agentData = {
      ...validatedInput,
      color,
      id: yield* newAgentId,
      visibility: 'public',
      revision: 1,
    };
    const agent = decodeAgent(agentData);
    const row = {
      ...validatedInput,
      color: agent.color,
      id: agent.id,
      visibility: 'public' as const,
      revision: 1,
    };
    yield* repo.insertPublicAgent(row);
    return agent;
  });

const updateAgentInRegistry = (repo: ReturnType<typeof createAgentRepo<AgentRegistryError>>) =>
  Effect.fn('AgentRegistry.updateAgentInRegistry')(function* (agentId: string, input: UpdateAgentInput) {
    const { expectedRevision, ...validatedInput } = decodeUpdateAgentInput(input);
    const current = yield* repo.getPublicAgentById(agentId);
    if (!current) return null;
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      return yield* new AgentRevisionConflictError({
        message: `Agent '${current.name}' is at revision ${current.revision}, not ${expectedRevision}. Pull first, or push with --force.`,
        current: current.revision,
      });
    }
    const revision = current.revision + 1;
    const agentData = {
      ...validatedInput,
      color: validatedInput.color ?? current.color,
      id: agentId,
      visibility: 'public',
      revision,
    };
    const agent = decodeAgent(agentData);
    const row = {
      ...validatedInput,
      color: agent.color,
      id: agentId,
      visibility: 'public' as const,
      revision,
    };
    const updated = yield* repo.updatePublicAgent(agentId, row);
    return updated ? agent : null;
  });

export const AgentRegistry = Context.Service<AgentRegistryService>('@agentdock/api/AgentRegistry');

const AgentRegistryLayer = Layer.effect(
  AgentRegistry,
  Effect.gen(function* () {
    const { db } = yield* Database;
    const repo = createAgentRepo(db, toAgentRegistryError);
    const internal = yield* InternalAgentRegistry;
    const external = yield* ExternalAgentRegistry;
    const changes = yield* ChangeFeed;
    const touchesAgents = changes.touches('agents');
    const addAgent = addAgentToRegistry(repo);
    const updateAgent = updateAgentInRegistry(repo);

    return AgentRegistry.of({
      add: (input) => addAgent(input).pipe(touchesAgents),
      update: Effect.fn('AgentRegistry.update')(function* (agentId, input) {
        if (yield* internal.getById(agentId)) return null;
        return yield* updateAgent(agentId, input).pipe(touchesAgents);
      }),
      list: () => repo.listPublicAgents(),
      listInternal: () => internal.list(),
      listExternal: () => external.list(),
      addExternal: (input) => external.add(input).pipe(touchesAgents),
      updateExternal: (agentId, input) => external.update(agentId, input).pipe(touchesAgents),
      getById: Effect.fn('AgentRegistry.getById')(function* (agentId) {
        return (yield* internal.getById(agentId)) ?? (yield* repo.getPublicAgentById(agentId));
      }),
      getExternalById: (agentId) => external.getById(agentId),
      remove: Effect.fn('AgentRegistry.remove')(function* (agentId) {
        if (yield* internal.getById(agentId)) return false;
        return yield* repo.removePublicAgent(agentId).pipe(touchesAgents);
      }),
      removeExternal: (agentId) => external.remove(agentId).pipe(touchesAgents),
    });
  }),
);

export const AgentRegistryLive = AgentRegistryLayer.pipe(
  Layer.provide(Layer.mergeAll(InternalAgentRegistryLive, ExternalAgentRegistryLive)),
  Layer.provide(Layer.mergeAll(DatabaseLive, ChangeFeedLive)),
);
