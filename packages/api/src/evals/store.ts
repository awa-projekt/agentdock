import { baselineComparison, summarizeEvalRun } from 'agentdock-sdk/evals';
import {
  EvalCase,
  type EvalCaseId,
  EvalDataset,
  type EvalDatasetDetail,
  type EvalDatasetId,
  type EvalGateId,
  type EvalGrader,
  type EvalGraderId,
  EvalGrader as EvalGraderSchema,
  type EvalReview,
  EvalRun,
  type EvalRunDetail,
  EvalRunId,
  type EvalRunStatus,
  type EvalRunTargetInput,
  EvalTrial,
  type EvalTrialId,
} from 'agentdock-sdk/schemas';
import {
  causeMessage,
  Database,
  type DatabaseClient,
  evalCasesTable,
  evalDatasetsTable,
  evalGatesTable,
  evalGradersTable,
  evalRunsTable,
  evalTrialsTable,
  tryDbWith,
} from 'db';
import { and, asc, desc, eq, inArray, max } from 'drizzle-orm';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';

export class EvalStoreError extends Schema.TaggedError<EvalStoreError>()('EvalStoreError', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const tryDb = tryDbWith((cause) => new EvalStoreError({ message: `Eval store failed: ${causeMessage(cause)}`, cause }));

const decodeCase = Schema.decodeUnknownSync(EvalCase);
const decodeDataset = Schema.decodeUnknownSync(EvalDataset);
const decodeGrader = Schema.decodeUnknownSync(EvalGraderSchema);
const decodeRun = Schema.decodeUnknownSync(EvalRun);
const decodeTrial = Schema.decodeUnknownSync(EvalTrial);

type DatasetRow = typeof evalDatasetsTable.$inferSelect;
type CaseRow = typeof evalCasesTable.$inferSelect;
type GraderRow = typeof evalGradersTable.$inferSelect;
type RunRow = typeof evalRunsTable.$inferSelect;
type TrialRow = typeof evalTrialsTable.$inferSelect;
export type EvalGateRow = typeof evalGatesTable.$inferSelect;

export type EvalCaseRecord = typeof evalCasesTable.$inferInsert;
export type EvalTrialRecord = typeof evalTrialsTable.$inferInsert;
export type EvalRunRecord = typeof evalRunsTable.$inferInsert;

/** SQLite caps bound parameters per statement; bulk writes go in slices well under it. */
const CHUNK = 200;

const chunks = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> =>
  Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, index) =>
    items.slice(index * CHUNK, (index + 1) * CHUNK),
  );

const rowToCase = (row: CaseRow): EvalCase =>
  decodeCase({
    id: row.id,
    datasetId: row.datasetId,
    input: row.input,
    expected: row.expected ?? undefined,
    metadata: row.metadata ?? undefined,
    tags: row.tags,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const rowToDataset = (row: DatasetRow, cases: ReadonlyArray<{ readonly tags: ReadonlyArray<string> }>): EvalDataset =>
  decodeDataset({
    id: row.id,
    name: row.name,
    description: row.description,
    graderIds: row.graderIds,
    caseCount: cases.length,
    tags: [...new Set(cases.flatMap((evalCase) => evalCase.tags))].sort(),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const rowToGrader = (row: GraderRow): EvalGrader =>
  decodeGrader({
    id: row.id,
    name: row.name,
    description: row.description,
    config: row.config,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const rowToTrial = (row: TrialRow): EvalTrial =>
  decodeTrial({
    id: row.id,
    runId: row.runId,
    caseId: row.caseId,
    index: row.trialIndex,
    case: row.case,
    status: row.status,
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    grades: row.grades,
    passed: row.passed ?? undefined,
    usage: row.usage ?? undefined,
    review: row.review ?? undefined,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
  });

/** A baseline run as a comparison needs it. */
type Baseline = {
  readonly id: EvalRunId;
  readonly name: string;
  readonly graderIds: ReadonlyArray<string>;
  readonly trials: ReadonlyArray<EvalTrial>;
};

const graderIdsOf = (row: RunRow): ReadonlyArray<string> => row.graders.map((grader) => grader.id);

const rowToRun = (row: RunRow, trials: ReadonlyArray<EvalTrial>, baseline: Baseline | undefined): EvalRun =>
  decodeRun({
    id: row.id,
    name: row.name,
    sourceRunId: row.sourceRunId ?? undefined,
    dataset: { id: row.datasetId, name: row.datasetName },
    target: row.target,
    graders: row.graders,
    trials: row.trials,
    concurrency: row.concurrency,
    status: row.status,
    error: row.error ?? undefined,
    trigger: row.trigger,
    summary: summarizeEvalRun(row.graders, trials),
    // Compared at read time, so a review that changes either run's verdicts moves the comparison with it.
    baseline:
      baseline === undefined ? undefined : baselineComparison(baseline, { graderIds: graderIdsOf(row), trials }),
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? undefined,
  });

const groupBy = <A, K>(items: ReadonlyArray<A>, key: (item: A) => K): Map<K, Array<A>> => {
  const groups = new Map<K, Array<A>>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
};

export type EvalTrialUpdate = Pick<
  EvalTrialRecord,
  'status' | 'output' | 'error' | 'grades' | 'passed' | 'usage' | 'startedAt' | 'completedAt'
>;

export type EvalStoreService = {
  readonly listDatasets: () => Effect.Effect<ReadonlyArray<EvalDataset>, EvalStoreError>;
  readonly getDataset: (id: EvalDatasetId) => Effect.Effect<EvalDatasetDetail | null, EvalStoreError>;
  readonly insertDataset: (
    dataset: typeof evalDatasetsTable.$inferInsert,
    cases: ReadonlyArray<EvalCaseRecord>,
  ) => Effect.Effect<void, EvalStoreError>;
  readonly updateDataset: (
    id: EvalDatasetId,
    values: Pick<DatasetRow, 'name' | 'description' | 'graderIds' | 'updatedAt'>,
  ) => Effect.Effect<boolean, EvalStoreError>;
  readonly removeDataset: (id: EvalDatasetId) => Effect.Effect<boolean, EvalStoreError>;
  /** The position after the dataset's last case, where appended cases start. */
  readonly nextCasePosition: (datasetId: EvalDatasetId) => Effect.Effect<number, EvalStoreError>;
  readonly insertCases: (
    datasetId: EvalDatasetId,
    cases: ReadonlyArray<EvalCaseRecord>,
    updatedAt: number,
  ) => Effect.Effect<ReadonlyArray<EvalCase>, EvalStoreError>;
  readonly updateCase: (
    datasetId: EvalDatasetId,
    caseId: EvalCaseId,
    values: Pick<CaseRow, 'input' | 'expected' | 'metadata' | 'tags' | 'updatedAt'>,
  ) => Effect.Effect<EvalCase | null, EvalStoreError>;
  readonly removeCases: (
    datasetId: EvalDatasetId,
    caseIds: ReadonlyArray<EvalCaseId>,
    updatedAt: number,
  ) => Effect.Effect<number, EvalStoreError>;

  readonly listGraders: () => Effect.Effect<ReadonlyArray<EvalGrader>, EvalStoreError>;
  readonly getGraders: (ids: ReadonlyArray<EvalGraderId>) => Effect.Effect<ReadonlyArray<EvalGrader>, EvalStoreError>;
  readonly insertGrader: (grader: EvalGrader) => Effect.Effect<void, EvalStoreError>;
  readonly updateGrader: (grader: EvalGrader) => Effect.Effect<boolean, EvalStoreError>;
  readonly removeGrader: (id: EvalGraderId, updatedAt: number) => Effect.Effect<boolean, EvalStoreError>;

  readonly listRuns: () => Effect.Effect<ReadonlyArray<EvalRun>, EvalStoreError>;
  readonly getRun: (id: EvalRunId) => Effect.Effect<EvalRunDetail | null, EvalStoreError>;
  readonly insertRun: (
    run: EvalRunRecord,
    trials: ReadonlyArray<EvalTrialRecord>,
  ) => Effect.Effect<void, EvalStoreError>;
  readonly updateTrial: (id: EvalTrialId, update: EvalTrialUpdate) => Effect.Effect<void, EvalStoreError>;
  readonly setReview: (
    runId: EvalRunId,
    trialId: EvalTrialId,
    review: EvalReview | null,
  ) => Effect.Effect<EvalTrial | null, EvalStoreError>;
  /** Ends a run; its trials that never finished are marked canceled. */
  readonly finishRun: (
    id: EvalRunId,
    status: Exclude<EvalRunStatus, 'running'>,
    completedAt: number,
    error?: string,
  ) => Effect.Effect<void, EvalStoreError>;
  readonly removeRun: (id: EvalRunId) => Effect.Effect<boolean, EvalStoreError>;
  /** Runs still marked running, which after a restart means the process that ran them is gone. */
  readonly listRunningRunIds: () => Effect.Effect<ReadonlyArray<EvalRunId>, EvalStoreError>;
  /**
   * The newest completed run of a dataset against a target: the baseline a new
   * run is compared with. A gate's own previous run wins over other runs.
   */
  readonly latestCompletedRun: (
    datasetId: EvalDatasetId,
    target: EvalRunTargetInput,
    gateId: EvalGateId | undefined,
  ) => Effect.Effect<EvalRunId | null, EvalStoreError>;

  readonly listGates: () => Effect.Effect<ReadonlyArray<EvalGateRow>, EvalStoreError>;
  readonly getGate: (id: EvalGateId) => Effect.Effect<EvalGateRow | null, EvalStoreError>;
  readonly insertGate: (gate: EvalGateRow) => Effect.Effect<void, EvalStoreError>;
  readonly updateGate: (
    id: EvalGateId,
    values: Partial<Omit<EvalGateRow, 'id' | 'createdAt'>>,
  ) => Effect.Effect<boolean, EvalStoreError>;
  readonly removeGate: (id: EvalGateId) => Effect.Effect<boolean, EvalStoreError>;
};

export const EvalStore = Context.Service<EvalStoreService>('@agentdock/api/EvalStore');

const makeStore = (db: DatabaseClient): EvalStoreService => {
  const casesOf = (datasetId: string) =>
    tryDb(() =>
      db
        .select()
        .from(evalCasesTable)
        .where(eq(evalCasesTable.datasetId, datasetId))
        .orderBy(asc(evalCasesTable.position))
        .all(),
    );

  const trialsOf = (runId: string) =>
    tryDb(() =>
      db
        .select()
        .from(evalTrialsTable)
        .where(eq(evalTrialsTable.runId, runId))
        .orderBy(asc(evalTrialsTable.position))
        .all(),
    ).pipe(Effect.map((rows) => rows.map(rowToTrial)));

  const touchDataset = (datasetId: string, updatedAt: number) =>
    tryDb(() => db.update(evalDatasetsTable).set({ updatedAt }).where(eq(evalDatasetsTable.id, datasetId)).run());

  return {
    listDatasets: Effect.fn('EvalStore.listDatasets')(function* () {
      const datasets = yield* tryDb(() =>
        db.select().from(evalDatasetsTable).orderBy(desc(evalDatasetsTable.updatedAt)).all(),
      );
      const cases = yield* tryDb(() =>
        db.select({ datasetId: evalCasesTable.datasetId, tags: evalCasesTable.tags }).from(evalCasesTable).all(),
      );
      const byDataset = groupBy(cases, (evalCase) => evalCase.datasetId);
      return datasets.map((row) => rowToDataset(row, byDataset.get(row.id) ?? []));
    }),
    getDataset: Effect.fn('EvalStore.getDataset')(function* (id) {
      const rows = yield* tryDb(() =>
        db.select().from(evalDatasetsTable).where(eq(evalDatasetsTable.id, id)).limit(1).all(),
      );
      const row = rows[0];
      if (!row) return null;
      const cases = yield* casesOf(id);
      return { dataset: rowToDataset(row, cases), cases: cases.map(rowToCase) };
    }),
    insertDataset: Effect.fn('EvalStore.insertDataset')(function* (dataset, cases) {
      yield* tryDb(() =>
        db.transaction(async (tx) => {
          await tx.insert(evalDatasetsTable).values(dataset).run();
          for (const slice of chunks(cases))
            await tx
              .insert(evalCasesTable)
              .values([...slice])
              .run();
        }),
      );
    }),
    updateDataset: Effect.fn('EvalStore.updateDataset')(function* (id, values) {
      const result = yield* tryDb(() =>
        db.update(evalDatasetsTable).set(values).where(eq(evalDatasetsTable.id, id)).run(),
      );
      return result.rowsAffected > 0;
    }),
    removeDataset: Effect.fn('EvalStore.removeDataset')(function* (id) {
      return yield* tryDb(() =>
        db.transaction(async (tx) => {
          await tx.delete(evalCasesTable).where(eq(evalCasesTable.datasetId, id)).run();
          const result = await tx.delete(evalDatasetsTable).where(eq(evalDatasetsTable.id, id)).run();
          return result.rowsAffected > 0;
        }),
      );
    }),
    nextCasePosition: Effect.fn('EvalStore.nextCasePosition')(function* (datasetId) {
      const rows = yield* tryDb(() =>
        db
          .select({ last: max(evalCasesTable.position) })
          .from(evalCasesTable)
          .where(eq(evalCasesTable.datasetId, datasetId))
          .all(),
      );
      return (rows[0]?.last ?? -1) + 1;
    }),
    insertCases: Effect.fn('EvalStore.insertCases')(function* (datasetId, cases, updatedAt) {
      yield* tryDb(() =>
        db.transaction(async (tx) => {
          for (const slice of chunks(cases))
            await tx
              .insert(evalCasesTable)
              .values([...slice])
              .run();
          await tx.update(evalDatasetsTable).set({ updatedAt }).where(eq(evalDatasetsTable.id, datasetId)).run();
        }),
      );
      const ids = new Set(cases.map((evalCase) => evalCase.id));
      return (yield* casesOf(datasetId)).filter((row) => ids.has(row.id)).map(rowToCase);
    }),
    updateCase: Effect.fn('EvalStore.updateCase')(function* (datasetId, caseId, values) {
      const result = yield* tryDb(() =>
        db
          .update(evalCasesTable)
          .set(values)
          .where(and(eq(evalCasesTable.datasetId, datasetId), eq(evalCasesTable.id, caseId)))
          .run(),
      );
      if (result.rowsAffected === 0) return null;
      yield* touchDataset(datasetId, values.updatedAt);
      const rows = yield* tryDb(() =>
        db.select().from(evalCasesTable).where(eq(evalCasesTable.id, caseId)).limit(1).all(),
      );
      return rows[0] ? rowToCase(rows[0]) : null;
    }),
    removeCases: Effect.fn('EvalStore.removeCases')(function* (datasetId, caseIds, updatedAt) {
      let removed = 0;
      for (const slice of chunks(caseIds)) {
        const result = yield* tryDb(() =>
          db
            .delete(evalCasesTable)
            .where(and(eq(evalCasesTable.datasetId, datasetId), inArray(evalCasesTable.id, [...slice])))
            .run(),
        );
        removed += result.rowsAffected;
      }
      if (removed > 0) yield* touchDataset(datasetId, updatedAt);
      return removed;
    }),

    listGraders: Effect.fn('EvalStore.listGraders')(function* () {
      const rows = yield* tryDb(() => db.select().from(evalGradersTable).orderBy(asc(evalGradersTable.name)).all());
      return rows.map(rowToGrader);
    }),
    getGraders: Effect.fn('EvalStore.getGraders')(function* (ids) {
      if (ids.length === 0) return [];
      const rows = yield* tryDb(() =>
        db
          .select()
          .from(evalGradersTable)
          .where(inArray(evalGradersTable.id, [...ids]))
          .all(),
      );
      const byId = new Map(rows.map((row) => [row.id, rowToGrader(row)]));
      return ids.flatMap((id) => {
        const grader = byId.get(id);
        return grader ? [grader] : [];
      });
    }),
    insertGrader: Effect.fn('EvalStore.insertGrader')(function* (grader) {
      yield* tryDb(() => db.insert(evalGradersTable).values(grader).run());
    }),
    updateGrader: Effect.fn('EvalStore.updateGrader')(function* (grader) {
      const { id, createdAt: _createdAt, ...values } = grader;
      const result = yield* tryDb(() =>
        db.update(evalGradersTable).set(values).where(eq(evalGradersTable.id, id)).run(),
      );
      return result.rowsAffected > 0;
    }),
    removeGrader: Effect.fn('EvalStore.removeGrader')(function* (id, updatedAt) {
      // A dataset that lists the grader as a default drops it; past runs keep their snapshot.
      const datasets = yield* tryDb(() => db.select().from(evalDatasetsTable).all());
      return yield* tryDb(() =>
        db.transaction(async (tx) => {
          for (const dataset of datasets.filter((row) => row.graderIds.includes(id))) {
            await tx
              .update(evalDatasetsTable)
              .set({ graderIds: dataset.graderIds.filter((graderId) => graderId !== id), updatedAt })
              .where(eq(evalDatasetsTable.id, dataset.id))
              .run();
          }
          const result = await tx.delete(evalGradersTable).where(eq(evalGradersTable.id, id)).run();
          return result.rowsAffected > 0;
        }),
      );
    }),

    listRuns: Effect.fn('EvalStore.listRuns')(function* () {
      const runs = yield* tryDb(() => db.select().from(evalRunsTable).orderBy(desc(evalRunsTable.createdAt)).all());
      const trials = yield* tryDb(() => db.select().from(evalTrialsTable).orderBy(asc(evalTrialsTable.position)).all());
      const byRun = groupBy(trials.map(rowToTrial), (trial) => trial.runId);
      const byId = new Map(runs.map((row) => [row.id, row]));
      return runs.map((row) => {
        const baselineRow = row.baselineRunId === null ? undefined : byId.get(row.baselineRunId);
        const baseline =
          baselineRow === undefined
            ? undefined
            : {
                id: EvalRunId.make(baselineRow.id),
                name: baselineRow.name,
                graderIds: graderIdsOf(baselineRow),
                trials: byRun.get(EvalRunId.make(baselineRow.id)) ?? [],
              };
        return rowToRun(row, byRun.get(EvalRunId.make(row.id)) ?? [], baseline);
      });
    }),
    getRun: Effect.fn('EvalStore.getRun')(function* (id) {
      const rows = yield* tryDb(() => db.select().from(evalRunsTable).where(eq(evalRunsTable.id, id)).limit(1).all());
      const row = rows[0];
      if (!row) return null;
      const trials = yield* trialsOf(id);
      const baselineRows =
        row.baselineRunId === null
          ? []
          : yield* tryDb(() =>
              db
                .select()
                .from(evalRunsTable)
                .where(eq(evalRunsTable.id, row.baselineRunId ?? ''))
                .limit(1)
                .all(),
            );
      const baselineRow = baselineRows[0];
      const baseline =
        baselineRow === undefined
          ? undefined
          : {
              id: EvalRunId.make(baselineRow.id),
              name: baselineRow.name,
              graderIds: graderIdsOf(baselineRow),
              trials: yield* trialsOf(baselineRow.id),
            };
      return { run: rowToRun(row, trials, baseline), trials };
    }),
    insertRun: Effect.fn('EvalStore.insertRun')(function* (run, trials) {
      yield* tryDb(() =>
        db.transaction(async (tx) => {
          await tx.insert(evalRunsTable).values(run).run();
          for (const slice of chunks(trials))
            await tx
              .insert(evalTrialsTable)
              .values([...slice])
              .run();
        }),
      );
    }),
    updateTrial: Effect.fn('EvalStore.updateTrial')(function* (id, update) {
      yield* tryDb(() => db.update(evalTrialsTable).set(update).where(eq(evalTrialsTable.id, id)).run());
    }),
    setReview: Effect.fn('EvalStore.setReview')(function* (runId, trialId, review) {
      const result = yield* tryDb(() =>
        db
          .update(evalTrialsTable)
          .set({ review })
          .where(and(eq(evalTrialsTable.runId, runId), eq(evalTrialsTable.id, trialId)))
          .run(),
      );
      if (result.rowsAffected === 0) return null;
      const rows = yield* tryDb(() =>
        db.select().from(evalTrialsTable).where(eq(evalTrialsTable.id, trialId)).limit(1).all(),
      );
      return rows[0] ? rowToTrial(rows[0]) : null;
    }),
    finishRun: Effect.fn('EvalStore.finishRun')(function* (id, status, completedAt, error) {
      yield* tryDb(() =>
        db.transaction(async (tx) => {
          await tx
            .update(evalTrialsTable)
            .set({ status: 'canceled' })
            .where(and(eq(evalTrialsTable.runId, id), inArray(evalTrialsTable.status, ['pending', 'running'])))
            .run();
          await tx
            .update(evalRunsTable)
            .set({ status, completedAt, error: error ?? null })
            .where(eq(evalRunsTable.id, id))
            .run();
        }),
      );
    }),
    removeRun: Effect.fn('EvalStore.removeRun')(function* (id) {
      return yield* tryDb(() =>
        db.transaction(async (tx) => {
          await tx.delete(evalTrialsTable).where(eq(evalTrialsTable.runId, id)).run();
          const result = await tx.delete(evalRunsTable).where(eq(evalRunsTable.id, id)).run();
          return result.rowsAffected > 0;
        }),
      );
    }),
    listRunningRunIds: Effect.fn('EvalStore.listRunningRunIds')(function* () {
      const rows = yield* tryDb(() =>
        db.select({ id: evalRunsTable.id }).from(evalRunsTable).where(eq(evalRunsTable.status, 'running')).all(),
      );
      return rows.map((row) => EvalRunId.make(row.id));
    }),
    latestCompletedRun: Effect.fn('EvalStore.latestCompletedRun')(function* (datasetId, target, gateId) {
      const rows = yield* tryDb(() =>
        db
          .select({ id: evalRunsTable.id, target: evalRunsTable.target, trigger: evalRunsTable.trigger })
          .from(evalRunsTable)
          .where(and(eq(evalRunsTable.datasetId, datasetId), eq(evalRunsTable.status, 'completed')))
          .orderBy(desc(evalRunsTable.createdAt))
          .all(),
      );
      const sameTarget = rows.filter((row) => row.target.kind === target.kind && row.target.id === target.id);
      const sameGate = sameTarget.find((row) => row.trigger.kind === 'gate' && row.trigger.gateId === gateId);
      const latest = (gateId === undefined ? undefined : sameGate) ?? sameTarget[0];
      return latest === undefined ? null : EvalRunId.make(latest.id);
    }),
    listGates: Effect.fn('EvalStore.listGates')(function* () {
      return yield* tryDb(() => db.select().from(evalGatesTable).orderBy(asc(evalGatesTable.createdAt)).all());
    }),
    getGate: Effect.fn('EvalStore.getGate')(function* (id) {
      const rows = yield* tryDb(() => db.select().from(evalGatesTable).where(eq(evalGatesTable.id, id)).limit(1).all());
      return rows[0] ?? null;
    }),
    insertGate: Effect.fn('EvalStore.insertGate')(function* (gate) {
      yield* tryDb(() => db.insert(evalGatesTable).values(gate).run());
    }),
    updateGate: Effect.fn('EvalStore.updateGate')(function* (id, values) {
      const result = yield* tryDb(() => db.update(evalGatesTable).set(values).where(eq(evalGatesTable.id, id)).run());
      return result.rowsAffected > 0;
    }),
    removeGate: Effect.fn('EvalStore.removeGate')(function* (id) {
      const result = yield* tryDb(() => db.delete(evalGatesTable).where(eq(evalGatesTable.id, id)).run());
      return result.rowsAffected > 0;
    }),
  };
};

/** Takes `Database` from ambient context so tests can hand it a fresh in-memory one. */
export const EvalStoreLive = Layer.effect(
  EvalStore,
  Effect.gen(function* () {
    const { db } = yield* Database;
    return EvalStore.of(makeStore(db));
  }),
);
