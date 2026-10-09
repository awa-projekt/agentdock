import { randomUUIDv4 } from 'agentdock-sdk';
import {
  type AgentRecord,
  type CreateEvalRunInput,
  EvalDatasetId,
  type EvalGate,
  type EvalGateId,
  EvalGateId as EvalGateIdSchema,
  type EvalGateInput,
  type EvalGateWatchedField,
  EvalGraderId,
  EvalNotFoundError,
  EvalOperationError,
  type EvalRun,
  EvalRunId,
  EvalValidationError,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
} from 'agentdock-sdk/schemas';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as FiberMap from 'effect/FiberMap';
import * as Layer from 'effect/Layer';
import * as Result from 'effect/Result';
import * as Stream from 'effect/Stream';
import { AgentRegistry } from '../agents/service';
import { ChangeFeed, ChangeFeedLive } from '../events/service';
import { EvalService } from './service';
import { type EvalGateRow, EvalStore, type EvalStoreError } from './store';

type EvalError = EvalNotFoundError | EvalValidationError | EvalOperationError;

export type EvalGatesApi = {
  readonly list: () => Effect.Effect<ReadonlyArray<EvalGate>, EvalError>;
  readonly create: (input: EvalGateInput) => Effect.Effect<EvalGate, EvalError>;
  readonly update: (id: EvalGateId, input: EvalGateInput) => Effect.Effect<EvalGate, EvalError>;
  readonly remove: (id: EvalGateId) => Effect.Effect<boolean, EvalError>;
  /** Runs the gate's suite now, e.g. to record the baseline later changes are compared with. */
  readonly run: (id: EvalGateId) => Effect.Effect<EvalRun, EvalError>;
};

export const EvalGates = Context.Service<EvalGatesApi>('@agentdock/api/EvalGates');

const WATCHED_FIELDS: ReadonlyArray<EvalGateWatchedField> = ['instructions', 'model', 'reasoningEffort', 'skills'];

/** The agent settings a gate reacts to, as the JSON the gate stores between runs. */
const watchedOf = (agent: AgentRecord): JsonObject => ({
  instructions: agent.instructions,
  model: agent.model,
  reasoningEffort: agent.reasoningEffort ?? null,
  skills: agent.skills,
});

const jsonEqual = (left: Json | undefined, right: Json | undefined): boolean => {
  if (isJsonArray(left) && isJsonArray(right)) {
    return left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => jsonEqual(left[key], right[key]));
  }
  return left === right;
};

const changedFields = (before: JsonObject, after: JsonObject): ReadonlyArray<EvalGateWatchedField> =>
  WATCHED_FIELDS.filter((field) => !jsonEqual(before[field], after[field]));

/** What a gate runs: the part of its row a run is started from. */
type GateSpec = Pick<
  EvalGateRow,
  'datasetId' | 'agentId' | 'graderIds' | 'tags' | 'trials' | 'concurrency' | 'caseLimit'
>;

const runInputOf = (gate: GateSpec): CreateEvalRunInput => {
  const input: CreateEvalRunInput = {
    datasetId: EvalDatasetId.make(gate.datasetId),
    target: { kind: 'agent', id: gate.agentId },
    graderIds: gate.graderIds.map((id) => EvalGraderId.make(id)),
    trials: gate.trials,
    concurrency: gate.concurrency,
    tags: gate.tags,
  };
  return gate.caseLimit === null ? input : { ...input, limit: gate.caseLimit };
};

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * Regression gates. A watcher follows the change feed; when an agent changes,
 * each enabled gate on it compares the agent's watched settings with the ones
 * it last ran against and, if they differ, reruns its suite. The comparison
 * with the previous run then shows whether the change helped or hurt.
 *
 * A burst of edits settles for `debounce` before anything runs, and a new run
 * cancels the gate's run still in progress: that one measures a configuration
 * that no longer exists.
 */
export const makeEvalGatesLayer = (options: { readonly debounce: Duration.Input }) =>
  Layer.effect(
    EvalGates,
    Effect.gen(function* () {
      const store = yield* EvalStore;
      const evals = yield* EvalService;
      const agents = yield* AgentRegistry;
      const changes = yield* ChangeFeed;
      const pending = yield* FiberMap.make<EvalGateId>();
      const touchesEvals = changes.touches('evals');
      const now = Clock.currentTimeMillis;

      const fromStore = <A>(effect: Effect.Effect<A, EvalStoreError>) =>
        effect.pipe(Effect.mapError((error) => new EvalOperationError({ message: error.message })));

      const lookupAgent = (agentId: string) =>
        agents
          .getById(agentId)
          .pipe(
            Effect.mapError(
              (error) =>
                new EvalOperationError({ message: `Could not look up the agent: ${errorMessage(error.cause)}` }),
            ),
          );

      const requireGate = (id: EvalGateId) =>
        fromStore(store.getGate(id)).pipe(
          Effect.flatMap((gate) =>
            gate ? Effect.succeed(gate) : Effect.fail(new EvalNotFoundError({ message: `Gate ${id} not found.` })),
          ),
        );

      /** Gates with their dataset and agent named, both looked up once for the whole list. */
      const describe = Effect.fn('EvalGates.describe')(function* (rows: ReadonlyArray<EvalGateRow>) {
        const datasets = yield* evals.listDatasets();
        const agentList = yield* agents.list().pipe(Effect.orElseSucceed((): ReadonlyArray<AgentRecord> => []));
        return rows.map((row): EvalGate => {
          const gate: EvalGate = {
            id: EvalGateIdSchema.make(row.id),
            datasetId: EvalDatasetId.make(row.datasetId),
            agentId: row.agentId,
            graderIds: row.graderIds.map((id) => EvalGraderId.make(id)),
            tags: row.tags,
            trials: row.trials,
            concurrency: row.concurrency,
            enabled: row.enabled,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
          const datasetName = datasets.find((dataset) => dataset.id === row.datasetId)?.name;
          const agentName = agentList.find((agent) => agent.id === row.agentId)?.name;
          return {
            ...gate,
            ...(row.caseLimit === null ? undefined : { limit: row.caseLimit }),
            ...(datasetName === undefined ? undefined : { datasetName }),
            ...(agentName === undefined ? undefined : { agentName }),
            ...(row.lastRunId === null ? undefined : { lastRunId: EvalRunId.make(row.lastRunId) }),
            ...(row.lastError === null ? undefined : { lastError: row.lastError }),
          };
        });
      });

      const describeOne = (id: EvalGateId) =>
        Effect.gen(function* () {
          const [gate] = yield* describe([yield* requireGate(id)]);
          if (gate === undefined) return yield* new EvalNotFoundError({ message: `Gate ${id} not found.` });
          return gate;
        });

      /** Checks the gate could run; a disabled gate is only checked for what it points at. */
      const validate = Effect.fn('EvalGates.validate')(function* (input: EvalGateInput) {
        const agent = yield* lookupAgent(input.agentId);
        if (!agent) return yield* new EvalValidationError({ message: `The agent '${input.agentId}' does not exist.` });
        if (input.enabled) {
          yield* evals.preflight(runInputOf(rowOf(input)));
        } else {
          yield* evals.getDataset(input.datasetId);
        }
        return agent;
      });

      const rowOf = (input: EvalGateInput) => ({
        datasetId: input.datasetId,
        agentId: input.agentId,
        graderIds: [...new Set(input.graderIds)],
        tags: [...new Set(input.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))],
        trials: input.trials,
        concurrency: input.concurrency,
        caseLimit: input.limit ?? null,
        enabled: input.enabled,
        lastRunId: null,
        lastError: null,
      });

      /** Starts the gate's suite and records the agent settings it now measures. */
      const fire = Effect.fn('EvalGates.fire')(function* (gateId: EvalGateId, onDemand: boolean) {
        const gate = yield* requireGate(gateId);
        const agent = yield* lookupAgent(gate.agentId);
        if (!agent) return yield* new EvalValidationError({ message: `The agent '${gate.agentId}' no longer exists.` });
        const current = watchedOf(agent);
        const changed = changedFields(gate.watched, current);
        if (!onDemand && (changed.length === 0 || !gate.enabled)) return undefined;

        if (gate.lastRunId !== null) {
          const previous = EvalRunId.make(gate.lastRunId);
          const running = yield* evals.getRun(previous).pipe(
            Effect.map((detail) => detail.run.status === 'running'),
            Effect.orElseSucceed(() => false),
          );
          if (running) yield* evals.cancelRun(previous).pipe(Effect.ignore);
        }

        const started = yield* evals
          .startRun(runInputOf(gate), { kind: 'gate', gateId, changed: onDemand ? [] : changed })
          .pipe(Effect.result);
        const at = yield* now;
        if (Result.isFailure(started)) {
          yield* fromStore(
            store.updateGate(gateId, { watched: current, lastError: started.failure.message, updatedAt: at }),
          );
          return yield* started.failure;
        }
        yield* fromStore(
          store.updateGate(gateId, { watched: current, lastRunId: started.success.id, lastError: null, updatedAt: at }),
        );
        return started.success;
      }, touchesEvals);

      /** Schedules a change-driven run, replacing one still waiting out the debounce. */
      const schedule = (gateId: EvalGateId) =>
        FiberMap.run(
          pending,
          gateId,
          Effect.sleep(options.debounce).pipe(
            Effect.andThen(Effect.uninterruptible(fire(gateId, false))),
            Effect.catch((error) => Effect.logWarning(`Eval gate ${gateId} could not start a run`, error.message)),
          ),
        );

      /** Compares every enabled gate's snapshot with its agent and schedules those that changed. */
      const checkGates = Effect.gen(function* () {
        const gates = yield* fromStore(store.listGates());
        for (const gate of gates.filter((row) => row.enabled)) {
          const agent = yield* lookupAgent(gate.agentId).pipe(Effect.orElseSucceed(() => null));
          if (agent && changedFields(gate.watched, watchedOf(agent)).length > 0) {
            yield* schedule(EvalGateIdSchema.make(gate.id));
          }
        }
      }).pipe(Effect.catch((error) => Effect.logWarning('Could not check eval gates', error.message)));

      // `Subscribed` opens the stream, so the first check also catches changes made while the server was down.
      yield* Effect.forkScoped(
        Stream.runForEach(changes.events, (event) =>
          event._tag === 'Subscribed' || event.resources.includes('agents') ? checkGates : Effect.void,
        ),
      );

      const newGateId = Effect.map(randomUUIDv4, (id) =>
        EvalGateIdSchema.make(`egt_${id.replaceAll('-', '').slice(0, 12)}`),
      );

      return EvalGates.of({
        list: Effect.fn('EvalGates.list')(function* () {
          return yield* describe(yield* fromStore(store.listGates()));
        }),
        create: Effect.fn('EvalGates.create')(function* (input: EvalGateInput) {
          const agent = yield* validate(input);
          const id = yield* newGateId;
          const at = yield* now;
          // The agent as it is now is the starting point: only later changes trigger a run.
          yield* fromStore(
            store.insertGate({ ...rowOf(input), id, watched: watchedOf(agent), createdAt: at, updatedAt: at }),
          );
          return yield* describeOne(id);
        }, touchesEvals),
        update: Effect.fn('EvalGates.update')(function* (id: EvalGateId, input: EvalGateInput) {
          const existing = yield* requireGate(id);
          const agent = yield* validate(input);
          const { lastRunId: _lastRunId, lastError: _lastError, ...values } = rowOf(input);
          // Pointing the gate at another agent restarts from that agent's current settings.
          const watched = existing.agentId === input.agentId ? existing.watched : watchedOf(agent);
          yield* fromStore(store.updateGate(id, { ...values, watched, updatedAt: yield* now }));
          return yield* describeOne(id);
        }, touchesEvals),
        remove: Effect.fn('EvalGates.remove')(function* (id: EvalGateId) {
          yield* FiberMap.remove(pending, id);
          return yield* fromStore(store.removeGate(id));
        }, touchesEvals),
        run: Effect.fn('EvalGates.run')(function* (id: EvalGateId) {
          yield* FiberMap.remove(pending, id);
          const run = yield* fire(id, true);
          if (run === undefined) return yield* new EvalOperationError({ message: 'The gate did not start a run.' });
          return run;
        }),
      });
    }),
  ).pipe(Layer.provide(ChangeFeedLive));

export const EvalGatesLive = makeEvalGatesLayer({ debounce: Duration.seconds(5) });
