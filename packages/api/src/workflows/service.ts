import { randomUUIDv4 } from 'agentdock-sdk';
import {
  type AgentRecord,
  type CatalogTool,
  CreateWorkflowInput,
  type ExternalA2aAgent,
  manifestAgentNames,
  manifestModelNames,
  manifestToolNames,
  manifestWorkflowNames,
  RegisteredWorkflow,
  type RegisterWorkflowInput,
  UpdateWorkflowInput,
  type WorkflowArtifactDownload,
  type WorkflowBindings,
  type WorkflowBindingTarget,
  WorkflowList,
  type WorkflowManifest,
} from 'agentdock-sdk/schemas';
import {
  extractWorkflowContracts,
  extractWorkflowGraph,
  importWorkflowGraph,
  type WorkflowArtifactError,
  type WorkflowGraphError,
} from 'agentdock-sdk/workflows';
import { Database, type DatabaseClient, DatabaseLive, tryDbWith, workflowRevisionsTable, workflowsTable } from 'db';
import { eq } from 'drizzle-orm';
import * as Clock from 'effect/Clock';
import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { ChangeFeed, ChangeFeedLive } from '../events/service';
import { deployWorkflowFiles, ensureHostPackageLinks, readArtifactFiles, type WorkflowDeployError } from './deploy';

/** What the server can bind a manifest's local names to. */
export type BindingCandidates = {
  readonly agents: ReadonlyArray<AgentRecord>;
  readonly externalAgents: ReadonlyArray<ExternalA2aAgent>;
  readonly workflows: ReadonlyArray<RegisteredWorkflow>;
  /** The integration tool catalog; a manifest tool name matches a catalog tool's name. */
  readonly tools: ReadonlyArray<CatalogTool>;
};

export type WorkflowRegistryService = {
  /** Deploys uploaded sources, binds the manifest's names, and records a revision. */
  readonly register: (
    input: RegisterWorkflowInput,
    candidates: BindingCandidates,
  ) => Effect.Effect<RegisteredWorkflow, WorkflowRegistryError | WorkflowRevisionConflictError>;
  readonly list: () => Effect.Effect<ReadonlyArray<RegisteredWorkflow>, WorkflowRegistryError>;
  readonly getById: (workflowId: string) => Effect.Effect<RegisteredWorkflow | null, WorkflowRegistryError>;
  readonly download: (workflowId: string) => Effect.Effect<WorkflowArtifactDownload | null, WorkflowRegistryError>;
  readonly remove: (workflowId: string) => Effect.Effect<boolean, WorkflowRegistryError>;
};

const decodeCreateWorkflowInput = Schema.decodeUnknownSync(CreateWorkflowInput);
const decodeUpdateWorkflowInput = Schema.decodeUnknownSync(UpdateWorkflowInput);
const decodeWorkflow = Schema.decodeUnknownSync(RegisteredWorkflow);
const decodeWorkflowList = Schema.decodeUnknownSync(WorkflowList);

const workflowId = Effect.map(randomUUIDv4, (id) => `wf_${id.replaceAll('-', '').slice(0, 8)}`);
const revisionId = Effect.map(randomUUIDv4, (id) => `wfr_${id.replaceAll('-', '').slice(0, 16)}`);

export class WorkflowRegistryError extends Schema.TaggedError<WorkflowRegistryError>()('WorkflowRegistryError', {
  cause: Schema.Defect(),
}) {}

export class WorkflowRevisionConflictError extends Schema.TaggedError<WorkflowRevisionConflictError>()(
  'WorkflowRevisionConflictError',
  { message: Schema.String, current: Schema.Number },
) {}

const toWorkflowRegistryError = (cause: unknown): WorkflowRegistryError => new WorkflowRegistryError({ cause });
const tryDb = tryDbWith(toWorkflowRegistryError);

type Transaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];
const recordRevision = (
  db: DatabaseClient | Transaction,
  workflow: RegisteredWorkflow,
  revision: number,
  createdAt: number,
  id: string,
) =>
  db
    .insert(workflowRevisionsTable)
    .values({
      id,
      workflowId: workflow.id,
      revision,
      source: workflow.source,
      sourceHash: workflow.sourceHash,
      manifest: workflow.manifest,
      graph: workflow.graph,
      bindings: workflow.bindings,
      createdAt,
    })
    .run();

const addWorkflow = (db: DatabaseClient) =>
  Effect.fn('WorkflowRegistry.addWorkflow')(function* (input: CreateWorkflowInput) {
    const validatedInput = decodeCreateWorkflowInput(input);
    const workflow = decodeWorkflow({ ...validatedInput, id: yield* workflowId, revision: 1 });
    const createdAt = yield* Clock.currentTimeMillis;
    const revision = yield* revisionId;

    yield* tryDb(() =>
      db.transaction(async (tx) => {
        await tx.insert(workflowsTable).values(workflow).run();
        await recordRevision(tx, workflow, 1, createdAt, revision);
      }),
    );
    return workflow;
  });

const listWorkflows = (db: DatabaseClient) =>
  Effect.fn('WorkflowRegistry.listWorkflows')(function* () {
    const rows = yield* tryDb(() => db.select().from(workflowsTable).all());
    return decodeWorkflowList(rows);
  });

const getWorkflowById = (db: DatabaseClient) =>
  Effect.fn('WorkflowRegistry.getWorkflowById')(function* (workflowIdValue: string) {
    const workflows = yield* tryDb(() =>
      db.select().from(workflowsTable).where(eq(workflowsTable.id, workflowIdValue)).limit(1).all(),
    );

    return workflows[0] ? decodeWorkflow(workflows[0]) : null;
  });

const updateWorkflow = (db: DatabaseClient) =>
  Effect.fn('WorkflowRegistry.updateWorkflow')(function* (workflowIdValue: string, input: UpdateWorkflowInput) {
    const validatedInput = decodeUpdateWorkflowInput(input);
    const createdAt = yield* Clock.currentTimeMillis;
    const newRevisionId = yield* revisionId;
    return yield* tryDb(() =>
      db.transaction(async (tx) => {
        const [current] = await tx.select().from(workflowsTable).where(eq(workflowsTable.id, workflowIdValue)).limit(1);
        if (!current) return null;
        const revision = current.revision + 1;
        const workflow = decodeWorkflow({ ...validatedInput, id: workflowIdValue, revision });
        await tx.update(workflowsTable).set(workflow).where(eq(workflowsTable.id, workflowIdValue));
        await recordRevision(tx, workflow, revision, createdAt, newRevisionId);
        return workflow;
      }),
    );
  });

const removeWorkflow = (db: DatabaseClient) =>
  Effect.fn('WorkflowRegistry.removeWorkflow')(function* (workflowIdValue: string) {
    const result = yield* tryDb(() => db.delete(workflowsTable).where(eq(workflowsTable.id, workflowIdValue)).run());

    return result.rowsAffected > 0;
  });

const artifactError = (
  error: WorkflowArtifactError | WorkflowGraphError | WorkflowDeployError,
): WorkflowRegistryError => new WorkflowRegistryError({ cause: error.message });

const PLATFORM_MODEL = /^[^\s:]+:\S+$/;

/**
 * Binds each manifest name to one concrete target. Explicit ids from the
 * request win; otherwise a name matches exactly one registered agent (internal
 * before external), workflow, or catalog tool of that name. Anything unresolved
 * or ambiguous fails the registration with every problem listed, so a push is
 * fixed in one round.
 */
const resolveBindings = (
  manifest: WorkflowManifest,
  explicit: Readonly<Record<string, string>>,
  candidates: BindingCandidates,
  self: string | undefined,
): Effect.Effect<WorkflowBindings, WorkflowRegistryError> => {
  const issues: Array<string> = [];
  const bindings: Record<string, WorkflowBindingTarget> = {};

  const agentTarget = (id: string): WorkflowBindingTarget | undefined =>
    candidates.agents.some((agent) => agent.id === id)
      ? { kind: 'agent', id }
      : candidates.externalAgents.some((agent) => agent.id === id)
        ? { kind: 'external', id }
        : undefined;

  for (const name of manifestAgentNames(manifest)) {
    const explicitId = explicit[name];
    if (explicitId) {
      const target = agentTarget(explicitId);
      if (target) bindings[name] = target;
      else issues.push(`agent '${name}': no registered agent has id '${explicitId}'`);
      continue;
    }
    const internal = candidates.agents.filter((agent) => agent.name === name);
    const external = candidates.externalAgents.filter((agent) => agent.name === name);
    const matches = internal.length > 0 ? internal : external;
    if (matches.length === 1 && matches[0]) {
      bindings[name] = { kind: internal.length > 0 ? 'agent' : 'external', id: matches[0].id };
    } else if (matches.length === 0) {
      issues.push(`agent '${name}': no registered agent is named '${name}'; bind it explicitly with an id`);
    } else {
      issues.push(`agent '${name}': ${matches.length} agents are named '${name}'; bind it explicitly with an id`);
    }
  }

  for (const name of manifestWorkflowNames(manifest)) {
    const explicitId = explicit[name];
    const pool = candidates.workflows.filter((workflow) => workflow.id !== self);
    if (explicitId) {
      if (pool.some((workflow) => workflow.id === explicitId)) bindings[name] = { kind: 'workflow', id: explicitId };
      else issues.push(`workflow '${name}': no registered workflow has id '${explicitId}'`);
      continue;
    }
    const matches = pool.filter((workflow) => workflow.manifest.name === name);
    if (matches.length === 1 && matches[0]) bindings[name] = { kind: 'workflow', id: matches[0].id };
    else if (matches.length === 0)
      issues.push(`workflow '${name}': no registered workflow is named '${name}'; bind it explicitly with an id`);
    else
      issues.push(`workflow '${name}': ${matches.length} workflows are named '${name}'; bind it explicitly with an id`);
  }

  for (const name of manifestToolNames(manifest)) {
    const explicitId = explicit[name];
    if (explicitId) {
      if (candidates.tools.some((tool) => tool.id === explicitId)) bindings[name] = { kind: 'tool', id: explicitId };
      else issues.push(`tool '${name}': no catalog tool has id '${explicitId}'`);
      continue;
    }
    const matches = candidates.tools.filter((tool) => tool.name === name);
    if (matches.length === 1 && matches[0]) bindings[name] = { kind: 'tool', id: matches[0].id };
    else if (matches.length === 0)
      issues.push(`tool '${name}': no integration exposes a tool named '${name}'; bind it explicitly with a tool id`);
    else
      issues.push(
        `tool '${name}': ${matches.length} tools are named '${name}' (${matches.map((tool) => tool.id).join(', ')}); bind it explicitly with a tool id`,
      );
  }

  // A model binds to a platform model, `provider:model`: the one the push
  // names, else the manifest's default. Whether its provider has a key shows
  // when a run resolves it, like an agent's model.
  for (const name of manifestModelNames(manifest)) {
    const model = explicit[name] ?? manifest.models?.[name]?.default;
    if (model === undefined) {
      issues.push(`model '${name}': the manifest gives no default; bind it explicitly as provider:model`);
    } else if (!PLATFORM_MODEL.test(model)) {
      issues.push(`model '${name}': '${model}' is not a platform model; expected provider:model`);
    } else {
      bindings[name] = { kind: 'model', id: model };
    }
  }

  return issues.length > 0
    ? Effect.fail(
        new WorkflowRegistryError({
          cause: `Workflow '${manifest.name}' has unbound dependencies: ${issues.join('; ')}`,
        }),
      )
    : Effect.succeed(bindings);
};

/** Declared secrets must be present on the host; a run that finds one missing would fail far later. */
const checkSecrets = (manifest: WorkflowManifest): Effect.Effect<void, WorkflowRegistryError> =>
  Effect.forEach(manifest.secrets ?? [], (name) =>
    Config.String(name).pipe(
      Effect.mapError(
        () =>
          new WorkflowRegistryError({
            cause: `Workflow '${manifest.name}' needs secret '${name}', which is not set on this host.`,
          }),
      ),
    ),
  ).pipe(Effect.asVoid);

export const WorkflowRegistry = Context.Service<WorkflowRegistryService>('@agentdock/api/WorkflowRegistry');

export const WorkflowRegistryLive = Layer.effect(
  WorkflowRegistry,
  Effect.gen(function* () {
    const { db } = yield* Database;
    yield* Effect.orDie(ensureHostPackageLinks());
    const add = addWorkflow(db);
    const update = updateWorkflow(db);
    const list = listWorkflows(db);
    const getById = getWorkflowById(db);
    const remove = removeWorkflow(db);
    const changes = yield* ChangeFeed;

    return WorkflowRegistry.of({
      register: Effect.fn('WorkflowRegistry.register')(function* (input, candidates) {
        const deployed = yield* deployWorkflowFiles(input.files).pipe(Effect.mapError(artifactError));

        // Read the topology and contracts off the deployed code, so what the
        // registry advertises is what will actually run.
        const compiled = yield* importWorkflowGraph(deployed).pipe(Effect.mapError(artifactError));
        const graph = yield* extractWorkflowGraph(compiled, deployed.manifest.name).pipe(
          Effect.mapError(artifactError),
        );
        const contracts = extractWorkflowContracts(compiled);
        const manifestInput = deployed.manifest.input ?? contracts.input;
        const manifestOutput = deployed.manifest.output ?? contracts.output;
        const withInput: WorkflowManifest = manifestInput
          ? { ...deployed.manifest, input: manifestInput }
          : deployed.manifest;
        const manifest: WorkflowManifest = manifestOutput ? { ...withInput, output: manifestOutput } : withInput;

        const existing = (yield* list()).find((workflow) => workflow.manifest.name === manifest.name);
        if (existing && input.expectedRevision !== undefined && existing.revision !== input.expectedRevision) {
          return yield* new WorkflowRevisionConflictError({
            message: `Workflow '${manifest.name}' is at revision ${existing.revision}, not ${input.expectedRevision}. Pull first, or push with --force.`,
            current: existing.revision,
          });
        }

        const bindings = yield* resolveBindings(manifest, input.bindings ?? {}, candidates, existing?.id);
        yield* checkSecrets(manifest);

        const record: CreateWorkflowInput = {
          source: deployed.folder,
          manifest,
          sourceHash: deployed.sourceHash,
          graph,
          bindings,
        };

        if (existing) {
          const updated = yield* update(existing.id, record);
          if (updated) return updated;
        }
        return yield* add(record);
      }, changes.touches('workflows')),
      list: Effect.fn('WorkflowRegistry.list')(function* () {
        return yield* list();
      }),
      getById: Effect.fn('WorkflowRegistry.getById')(function* (id: string) {
        return yield* getById(id);
      }),
      download: Effect.fn('WorkflowRegistry.download')(function* (id: string) {
        const workflow = yield* getById(id);
        if (!workflow) return null;
        const files = yield* readArtifactFiles(workflow.source).pipe(Effect.mapError(toWorkflowRegistryError));
        return { workflow, files };
      }),
      remove: Effect.fn('WorkflowRegistry.remove')(function* (id: string) {
        return yield* remove(id);
      }, changes.touches('workflows')),
    });
  }),
).pipe(Layer.provide(Layer.mergeAll(DatabaseLive, ChangeFeedLive)));
