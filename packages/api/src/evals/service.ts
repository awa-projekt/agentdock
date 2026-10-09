import { parseModelString, randomUUIDv4, SUPPORTED_LLM_PROVIDERS } from 'agentdock-sdk';
import { unknownEvalTemplateVariables } from 'agentdock-sdk/evals';
import {
  type AddEvalCasesInput,
  type CreateEvalDatasetInput,
  type CreateEvalRunInput,
  type EvalCase,
  type EvalCaseId,
  type EvalCaseInput,
  type EvalCaseSnapshot,
  type EvalDataset,
  type EvalDatasetDetail,
  type EvalDatasetId,
  EvalDatasetId as EvalDatasetIdSchema,
  type EvalDatasetInput,
  type EvalGrade,
  type EvalGrader,
  type EvalGraderConfig,
  type EvalGraderId,
  EvalGraderId as EvalGraderIdSchema,
  type EvalGraderInput,
  EvalNotFoundError,
  EvalOperationError,
  type EvalRun,
  type EvalRunDetail,
  type EvalRunId,
  EvalRunId as EvalRunIdSchema,
  type EvalRunTarget,
  type EvalRunTrigger,
  type EvalTrial,
  type EvalTrialId,
  EvalTrialId as EvalTrialIdSchema,
  EvalValidationError,
  type RegradeEvalRunInput,
  type SetEvalReviewInput,
  type TestEvalGraderInput,
} from 'agentdock-sdk/schemas';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as FiberMap from 'effect/FiberMap';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import { ChangeFeed, ChangeFeedLive } from '../events/service';
import { ProviderKeyRegistry } from '../providers/service';
import { gradeTrial, trialPassed } from './graders';
import { EvalJudge } from './judge';
import { EvalStore, type EvalStoreError, type EvalTrialRecord } from './store';
import { type EvalTargetError, type EvalTargetResult, EvalTargets } from './targets';

type EvalError = EvalNotFoundError | EvalValidationError | EvalOperationError;

/** A guard against a mis-sized run: cases × trials above this is refused outright. */
const MAX_EVAL_RUN_TRIALS = 5_000;

export type EvalServiceApi = {
  readonly listDatasets: () => Effect.Effect<ReadonlyArray<EvalDataset>, EvalError>;
  readonly getDataset: (id: EvalDatasetId) => Effect.Effect<EvalDatasetDetail, EvalError>;
  readonly createDataset: (input: CreateEvalDatasetInput) => Effect.Effect<EvalDataset, EvalError>;
  readonly updateDataset: (id: EvalDatasetId, input: EvalDatasetInput) => Effect.Effect<EvalDataset, EvalError>;
  readonly removeDataset: (id: EvalDatasetId) => Effect.Effect<boolean, EvalError>;
  readonly addCases: (id: EvalDatasetId, input: AddEvalCasesInput) => Effect.Effect<ReadonlyArray<EvalCase>, EvalError>;
  readonly updateCase: (
    id: EvalDatasetId,
    caseId: EvalCaseId,
    input: EvalCaseInput,
  ) => Effect.Effect<EvalCase, EvalError>;
  readonly removeCases: (id: EvalDatasetId, caseIds: ReadonlyArray<EvalCaseId>) => Effect.Effect<number, EvalError>;

  readonly listGraders: () => Effect.Effect<ReadonlyArray<EvalGrader>, EvalError>;
  readonly createGrader: (input: EvalGraderInput) => Effect.Effect<EvalGrader, EvalError>;
  readonly updateGrader: (id: EvalGraderId, input: EvalGraderInput) => Effect.Effect<EvalGrader, EvalError>;
  readonly removeGrader: (id: EvalGraderId) => Effect.Effect<boolean, EvalError>;
  /** Grades one hand-written output, for trying a grader before a run spends anything on it. */
  readonly testGrader: (input: TestEvalGraderInput) => Effect.Effect<EvalGrade, EvalError>;

  readonly listRuns: () => Effect.Effect<ReadonlyArray<EvalRun>, EvalError>;
  readonly getRun: (id: EvalRunId) => Effect.Effect<EvalRunDetail, EvalError>;
  /** Checks a run could start (cases, graders, target and every model's key) without starting it. */
  readonly preflight: (input: CreateEvalRunInput) => Effect.Effect<void, EvalError>;
  readonly startRun: (input: CreateEvalRunInput, trigger?: EvalRunTrigger) => Effect.Effect<EvalRun, EvalError>;
  readonly regradeRun: (id: EvalRunId, input: RegradeEvalRunInput) => Effect.Effect<EvalRun, EvalError>;
  readonly cancelRun: (id: EvalRunId) => Effect.Effect<EvalRun, EvalError>;
  readonly removeRun: (id: EvalRunId) => Effect.Effect<boolean, EvalError>;
  readonly setReview: (
    runId: EvalRunId,
    trialId: EvalTrialId,
    input: SetEvalReviewInput,
    reviewedBy: string | undefined,
  ) => Effect.Effect<EvalTrial, EvalError>;
};

export const EvalService = Context.Service<EvalServiceApi>('@agentdock/api/EvalService');

const newId = (prefix: string) => Effect.map(randomUUIDv4, (id) => `${prefix}_${id.replaceAll('-', '').slice(0, 12)}`);

const storeFailure = (error: EvalStoreError) => new EvalOperationError({ message: error.message });

const invalid = (message: string) => new EvalValidationError({ message });

const snapshotOf = (evalCase: EvalCase): EvalCaseSnapshot => {
  const snapshot: EvalCaseSnapshot = { input: evalCase.input, tags: evalCase.tags };
  return {
    ...snapshot,
    ...(evalCase.expected === undefined ? undefined : { expected: evalCase.expected }),
    ...(evalCase.metadata === undefined ? undefined : { metadata: evalCase.metadata }),
  };
};

/** Trims a case and drops empty optional fields; the input itself must say something. */
const normalizeCase = (input: EvalCaseInput, index: number): Effect.Effect<EvalCaseInput, EvalValidationError> => {
  const text = input.input.trim();
  if (text.length === 0) return Effect.fail(invalid(`Case ${index + 1} has an empty input.`));
  const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
  const normalized: EvalCaseInput = { input: input.input, tags };
  return Effect.succeed({
    ...normalized,
    ...(input.expected === undefined || input.expected.length === 0 ? undefined : { expected: input.expected }),
    ...(input.metadata === undefined || Object.keys(input.metadata).length === 0
      ? undefined
      : { metadata: input.metadata }),
  });
};

const requireName = (name: string, what: string): Effect.Effect<string, EvalValidationError> => {
  const trimmed = name.trim();
  return trimmed.length === 0 ? Effect.fail(invalid(`The ${what} needs a name.`)) : Effect.succeed(trimmed);
};

/** Rejects configs that could never grade correctly, before they are saved or run. */
const validateGraderConfig = (config: EvalGraderConfig): Effect.Effect<void, EvalValidationError> =>
  Effect.gen(function* () {
    switch (config.type) {
      case 'exact-match':
      case 'json-match':
      case 'numeric':
      case 'similarity':
        if (config.expected.trim().length === 0) return yield* invalid('Set the value to compare against.');
        return;
      case 'contains':
        if (config.values.every((value) => value.trim().length === 0)) return yield* invalid('Add at least one value.');
        return;
      case 'regex':
        if (config.pattern.length === 0) return yield* invalid('Set a pattern.');
        yield* Effect.try({
          try: () => new RegExp(config.pattern, config.flags.replace('g', '')),
          catch: (cause) => invalid(`Invalid regular expression: ${cause instanceof Error ? cause.message : ''}`),
        });
        return;
      case 'json':
      case 'latency':
        return;
      case 'tool-calls':
        if (config.required.length === 0 && config.forbidden.length === 0 && config.maxCalls === undefined) {
          return yield* invalid('Require a tool, forbid one, or set a call budget.');
        }
        return;
      case 'llm-judge': {
        yield* Effect.try({
          try: () => parseModelString(config.model),
          catch: () => invalid('Pick the model that judges, as provider:model.'),
        });
        if (!/\{\{\{?\s*(output|transcript)\s*\}?\}\}/.test(config.prompt)) {
          return yield* invalid(
            'The judge prompt must include {{output}} or {{transcript}}, or the judge sees nothing to grade.',
          );
        }
        const unknown = unknownEvalTemplateVariables(config.prompt);
        if (unknown.length > 0) {
          return yield* invalid(`Unknown template variables: ${unknown.map((path) => `{{${path}}}`).join(', ')}.`);
        }
        const scoring = config.scoring;
        if (scoring.kind === 'scale') {
          if (scoring.max <= scoring.min) return yield* invalid('The scale maximum must be above its minimum.');
          if (scoring.max - scoring.min > 100) return yield* invalid('The scale can have at most 101 points.');
          return;
        }
        const labels = scoring.choices.map((choice) => choice.label.trim());
        if (labels.length < 2) return yield* invalid('Give the judge at least two verdicts to choose from.');
        if (labels.some((label) => label.length === 0)) return yield* invalid('Every verdict needs a label.');
        if (new Set(labels).size !== labels.length) return yield* invalid('Verdict labels must be unique.');
        if (config.allowUnknown && labels.includes('UNKNOWN')) {
          return yield* invalid("'UNKNOWN' is reserved for the judge's escape hatch; rename that verdict.");
        }
        if (!scoring.choices.some((choice) => choice.score >= config.passThreshold)) {
          return yield* invalid('No verdict scores at or above the pass threshold, so nothing could pass.');
        }
        return;
      }
    }
  });

const BUILTIN_PROVIDERS = new Set(SUPPORTED_LLM_PROVIDERS.map((provider) => provider.id));

export const EvalServiceLive = Layer.effect(
  EvalService,
  Effect.gen(function* () {
    const store = yield* EvalStore;
    const targets = yield* EvalTargets;
    const judge = yield* EvalJudge;
    const providerKeys = yield* ProviderKeyRegistry;
    const changes = yield* ChangeFeed;
    const fibers = yield* FiberMap.make<EvalRunId>();
    const touchesEvals = changes.touches('evals');
    const publish = changes.publish('evals');

    const fromStore = <A>(effect: Effect.Effect<A, EvalStoreError>) => effect.pipe(Effect.mapError(storeFailure));

    const requireDataset = (id: EvalDatasetId) =>
      fromStore(store.getDataset(id)).pipe(
        Effect.flatMap((detail) =>
          detail ? Effect.succeed(detail) : Effect.fail(new EvalNotFoundError({ message: `Dataset ${id} not found.` })),
        ),
      );

    const requireRun = (id: EvalRunId) =>
      fromStore(store.getRun(id)).pipe(
        Effect.flatMap((detail) =>
          detail ? Effect.succeed(detail) : Effect.fail(new EvalNotFoundError({ message: `Run ${id} not found.` })),
        ),
      );

    const requireGraders = (ids: ReadonlyArray<EvalGraderId>) =>
      Effect.gen(function* () {
        const unique = [...new Set(ids)];
        const graders = yield* fromStore(store.getGraders(unique));
        if (graders.length !== unique.length) {
          const known = new Set(graders.map((grader) => grader.id));
          return yield* invalid(`Unknown grader: ${unique.filter((id) => !known.has(id)).join(', ')}.`);
        }
        return graders;
      });

    /**
     * A model whose provider has no key fails on every call, so a run checks
     * all of its models up front instead of failing trial after trial.
     */
    const requireModelKey = (model: string, usedBy: string) =>
      Effect.gen(function* () {
        const provider = yield* Effect.try({
          try: () => parseModelString(model).provider,
          catch: () => invalid(`${usedBy} uses '${model}', which is not a provider:model value.`),
        });
        const config = yield* providerKeys
          .getRuntimeConfig(provider)
          .pipe(Effect.mapError(() => new EvalOperationError({ message: `Could not read the ${provider} key.` })));
        const missing = BUILTIN_PROVIDERS.has(provider) ? config?.apiKey === undefined : config === undefined;
        if (missing) return yield* invalid(`${usedBy} uses ${provider}, which has no API key configured.`);
      });

    const requireJudgeKeys = (graders: ReadonlyArray<EvalGrader>) =>
      Effect.forEach(
        graders.flatMap((grader) =>
          grader.config.type === 'llm-judge' ? [{ grader, model: grader.config.model }] : [],
        ),
        ({ grader, model }) => requireModelKey(model, `The grader '${grader.name}'`),
        { discard: true },
      );

    const now = Clock.currentTimeMillis;

    const executeTrial = (
      run: { readonly target: EvalRunTarget; readonly graders: ReadonlyArray<EvalGrader> },
      trial: EvalTrialRecord,
    ) =>
      Effect.gen(function* () {
        const trialId = EvalTrialIdSchema.make(trial.id);
        yield* fromStore(store.updateTrial(trialId, { status: 'running', startedAt: yield* now }));
        yield* publish;
        // A re-grade carries its outputs over and spends nothing on the target.
        const outcome: Result.Result<EvalTargetResult, EvalTargetError> =
          trial.output === undefined || trial.output === null
            ? yield* Effect.result(targets.run(run.target, trial.case.input))
            : Result.succeed({ output: trial.output, usage: undefined });
        if (Result.isFailure(outcome)) {
          yield* fromStore(
            store.updateTrial(trialId, {
              status: 'errored',
              error: outcome.failure.message,
              usage: outcome.failure.usage ?? null,
              completedAt: yield* now,
            }),
          );
          return yield* publish;
        }
        const { output, usage } = outcome.success;
        const grades = yield* Effect.forEach(
          run.graders,
          (grader) => gradeTrial(grader, { case: trial.case, output }),
          { concurrency: 'unbounded' },
        ).pipe(Effect.provideService(EvalJudge, judge));
        yield* fromStore(
          store.updateTrial(trialId, {
            status: 'completed',
            output,
            grades,
            passed: trialPassed(grades) ?? null,
            usage: usage ?? null,
            completedAt: yield* now,
          }),
        );
        yield* publish;
      }).pipe(Effect.withSpan('agentdock.evals.trial', { attributes: { 'eval.trial.id': trial.id } }));

    const finish = (id: EvalRunId, status: 'completed' | 'failed' | 'canceled', error?: string) =>
      Effect.gen(function* () {
        yield* fromStore(store.finishRun(id, status, yield* now, error));
        yield* publish;
      });

    /** Works through the trials in the background; the run outlives the request that started it. */
    const launch = (
      id: EvalRunId,
      run: {
        readonly target: EvalRunTarget;
        readonly graders: ReadonlyArray<EvalGrader>;
        readonly concurrency: number;
      },
      trials: ReadonlyArray<EvalTrialRecord>,
    ) =>
      FiberMap.run(
        fibers,
        id,
        Effect.forEach(trials, (trial) => executeTrial(run, trial), {
          concurrency: run.concurrency,
          discard: true,
        }).pipe(
          Effect.flatMap(() => finish(id, 'completed')),
          Effect.catch((error) => finish(id, 'failed', error.message)),
          Effect.onInterrupt(() => finish(id, 'canceled').pipe(Effect.ignore)),
          Effect.withSpan('agentdock.evals.run', { root: true, attributes: { 'eval.run.id': id } }),
          Effect.ignore,
        ),
      );

    const loadRun = (id: EvalRunId) => Effect.map(requireRun(id), (detail) => detail.run);

    // A run marked running at startup belonged to a process that is gone; nothing will finish it.
    yield* Effect.gen(function* () {
      const orphans = yield* store.listRunningRunIds();
      const at = yield* now;
      for (const id of orphans) {
        yield* store.finishRun(id, 'failed', at, 'The server restarted while this run was in progress.');
      }
    }).pipe(Effect.catch((error) => Effect.logWarning('Could not close interrupted eval runs', error)));

    const createGrader = Effect.fn('EvalService.createGrader')(function* (input: EvalGraderInput) {
      const name = yield* requireName(input.name, 'grader');
      yield* validateGraderConfig(input.config);
      const at = yield* now;
      const grader: EvalGrader = {
        id: EvalGraderIdSchema.make(yield* newId('egr')),
        name,
        description: input.description.trim(),
        config: input.config,
        createdAt: at,
        updatedAt: at,
      };
      yield* fromStore(store.insertGrader(grader));
      return grader;
    }, touchesEvals);

    const updateGrader = Effect.fn('EvalService.updateGrader')(function* (id: EvalGraderId, input: EvalGraderInput) {
      const name = yield* requireName(input.name, 'grader');
      yield* validateGraderConfig(input.config);
      const [existing] = yield* fromStore(store.getGraders([id]));
      if (!existing) return yield* new EvalNotFoundError({ message: `Grader ${id} not found.` });
      const grader: EvalGrader = {
        ...existing,
        name,
        description: input.description.trim(),
        config: input.config,
        updatedAt: yield* now,
      };
      yield* fromStore(store.updateGrader(grader));
      return grader;
    }, touchesEvals);

    const createDataset = Effect.fn('EvalService.createDataset')(function* (input: CreateEvalDatasetInput) {
      const name = yield* requireName(input.name, 'dataset');
      yield* requireGraders(input.graderIds);
      const cases = yield* Effect.forEach(input.cases ?? [], normalizeCase);
      const at = yield* now;
      const id = EvalDatasetIdSchema.make(yield* newId('eds'));
      const rows = yield* Effect.forEach(cases, (evalCase, position) =>
        Effect.map(newId('ecs'), (caseId) => ({
          id: caseId,
          datasetId: id,
          position,
          input: evalCase.input,
          expected: evalCase.expected ?? null,
          metadata: evalCase.metadata ?? null,
          tags: evalCase.tags ?? [],
          createdAt: at,
          updatedAt: at,
        })),
      );
      yield* fromStore(
        store.insertDataset(
          {
            id,
            name,
            description: input.description.trim(),
            graderIds: [...new Set(input.graderIds)],
            createdAt: at,
            updatedAt: at,
          },
          rows,
        ),
      );
      return (yield* requireDataset(id)).dataset;
    }, touchesEvals);

    /** Everything a run needs, checked before anything is written or spent. */
    const prepareRun = Effect.fn('EvalService.prepareRun')(function* (input: CreateEvalRunInput) {
      const { dataset, cases: allCases } = yield* requireDataset(input.datasetId);
      const caseIds = input.caseIds === undefined ? undefined : new Set(input.caseIds);
      const tags = input.tags ?? [];
      const selected = allCases
        .filter((evalCase) => caseIds === undefined || caseIds.has(evalCase.id))
        .filter((evalCase) => tags.length === 0 || evalCase.tags.some((tag) => tags.includes(tag)));
      const cases = input.limit === undefined ? selected : selected.slice(0, input.limit);
      if (cases.length === 0) return yield* invalid('No cases match the selection.');
      if (cases.length * input.trials > MAX_EVAL_RUN_TRIALS) {
        return yield* invalid(
          `${cases.length * input.trials} trials is over the limit of ${MAX_EVAL_RUN_TRIALS} per run.`,
        );
      }
      const graders = yield* requireGraders(input.graderIds);
      const target = yield* targets.resolve(input.target);
      if (target.model !== undefined) yield* requireModelKey(target.model, `The agent '${target.name}'`);
      yield* requireJudgeKeys(graders);
      return { dataset, cases, graders, target };
    });

    const startRun = Effect.fn('EvalService.startRun')(function* (
      input: CreateEvalRunInput,
      trigger: EvalRunTrigger = { kind: 'manual' },
    ) {
      const { dataset, cases, graders, target } = yield* prepareRun(input);
      const baselineRunId = yield* fromStore(
        store.latestCompletedRun(dataset.id, input.target, trigger.kind === 'gate' ? trigger.gateId : undefined),
      );

      const id = EvalRunIdSchema.make(yield* newId('erun'));
      const at = yield* now;
      const trials = yield* Effect.forEach(
        cases.flatMap((evalCase, caseIndex) =>
          Array.from({ length: input.trials }, (_, trialIndex) => ({ evalCase, caseIndex, trialIndex })),
        ),
        ({ evalCase, caseIndex, trialIndex }) =>
          Effect.map(
            newId('etr'),
            (trialId): EvalTrialRecord => ({
              id: trialId,
              runId: id,
              caseId: evalCase.id,
              position: caseIndex * input.trials + trialIndex,
              trialIndex,
              case: snapshotOf(evalCase),
              status: 'pending',
              grades: [],
            }),
          ),
      );
      yield* fromStore(
        store.insertRun(
          {
            id,
            name: input.name?.trim() || `${target.name} · ${dataset.name}`,
            datasetId: dataset.id,
            datasetName: dataset.name,
            target,
            graders,
            trials: input.trials,
            concurrency: input.concurrency,
            status: 'running',
            trigger,
            baselineRunId,
            createdAt: at,
          },
          trials,
        ),
      );
      yield* launch(id, { target, graders, concurrency: input.concurrency }, trials);
      return yield* loadRun(id);
    }, touchesEvals);

    const regradeRun = Effect.fn('EvalService.regradeRun')(function* (sourceId: EvalRunId, input: RegradeEvalRunInput) {
      const source = yield* requireRun(sourceId);
      if (source.run.status === 'running') return yield* invalid('Wait for the run to finish before re-grading it.');
      if (input.graderIds.length === 0) return yield* invalid('Pick at least one grader.');
      const graders = yield* requireGraders(input.graderIds);
      yield* requireJudgeKeys(graders);
      const graded = source.trials.filter((trial) => trial.status === 'completed' && trial.output !== undefined);
      if (graded.length === 0) return yield* invalid('The run has no completed trials to re-grade.');

      const id = EvalRunIdSchema.make(yield* newId('erun'));
      const at = yield* now;
      const trials = yield* Effect.forEach(graded, (trial) =>
        Effect.map(
          newId('etr'),
          (trialId): EvalTrialRecord => ({
            id: trialId,
            runId: id,
            caseId: trial.caseId,
            position: source.trials.indexOf(trial),
            trialIndex: trial.index,
            case: trial.case,
            status: 'pending',
            output: trial.output ?? null,
            grades: [],
            // The outputs are the same, so a person's verdict on them still holds.
            review: trial.review ?? null,
          }),
        ),
      );
      const run = source.run;
      yield* fromStore(
        store.insertRun(
          {
            id,
            name: input.name?.trim() || `${run.name} (re-graded)`,
            sourceRunId: run.id,
            datasetId: run.dataset.id,
            datasetName: run.dataset.name,
            target: run.target,
            graders,
            trials: run.trials,
            concurrency: run.concurrency,
            status: 'running',
            trigger: { kind: 'regrade' },
            // Same outputs, other graders: the comparison shows where the graders disagree.
            baselineRunId: run.id,
            createdAt: at,
          },
          trials,
        ),
      );
      yield* launch(id, { target: run.target, graders, concurrency: run.concurrency }, trials);
      return yield* loadRun(id);
    }, touchesEvals);

    return EvalService.of({
      listDatasets: () => fromStore(store.listDatasets()),
      getDataset: requireDataset,
      createDataset,
      updateDataset: Effect.fn('EvalService.updateDataset')(function* (id: EvalDatasetId, input: EvalDatasetInput) {
        const name = yield* requireName(input.name, 'dataset');
        yield* requireGraders(input.graderIds);
        const updated = yield* fromStore(
          store.updateDataset(id, {
            name,
            description: input.description.trim(),
            graderIds: [...new Set(input.graderIds)],
            updatedAt: yield* now,
          }),
        );
        if (!updated) return yield* new EvalNotFoundError({ message: `Dataset ${id} not found.` });
        return (yield* requireDataset(id)).dataset;
      }, touchesEvals),
      removeDataset: (id) => fromStore(store.removeDataset(id)).pipe(touchesEvals),
      addCases: Effect.fn('EvalService.addCases')(function* (id: EvalDatasetId, input: AddEvalCasesInput) {
        yield* requireDataset(id);
        if (input.cases.length === 0) return [];
        const cases = yield* Effect.forEach(input.cases, normalizeCase);
        const start = yield* fromStore(store.nextCasePosition(id));
        const at = yield* now;
        const rows = yield* Effect.forEach(cases, (evalCase, index) =>
          Effect.map(newId('ecs'), (caseId) => ({
            id: caseId,
            datasetId: id,
            position: start + index,
            input: evalCase.input,
            expected: evalCase.expected ?? null,
            metadata: evalCase.metadata ?? null,
            tags: evalCase.tags ?? [],
            createdAt: at,
            updatedAt: at,
          })),
        );
        return yield* fromStore(store.insertCases(id, rows, at));
      }, touchesEvals),
      updateCase: Effect.fn('EvalService.updateCase')(function* (
        id: EvalDatasetId,
        caseId: EvalCaseId,
        input: EvalCaseInput,
      ) {
        const evalCase = yield* normalizeCase(input, 0);
        const updated = yield* fromStore(
          store.updateCase(id, caseId, {
            input: evalCase.input,
            expected: evalCase.expected ?? null,
            metadata: evalCase.metadata ?? null,
            tags: evalCase.tags ?? [],
            updatedAt: yield* now,
          }),
        );
        if (!updated) return yield* new EvalNotFoundError({ message: `Case ${caseId} not found.` });
        return updated;
      }, touchesEvals),
      removeCases: (id, caseIds) =>
        Effect.flatMap(now, (at) => fromStore(store.removeCases(id, caseIds, at))).pipe(touchesEvals),

      listGraders: () => fromStore(store.listGraders()),
      createGrader,
      updateGrader,
      removeGrader: (id) => Effect.flatMap(now, (at) => fromStore(store.removeGrader(id, at))).pipe(touchesEvals),
      testGrader: Effect.fn('EvalService.testGrader')(function* (input: TestEvalGraderInput) {
        yield* validateGraderConfig(input.config);
        if (input.config.type === 'llm-judge') yield* requireModelKey(input.config.model, 'The grader');
        const at = yield* now;
        const grader: EvalGrader = {
          id: EvalGraderIdSchema.make('test'),
          name: input.name?.trim() || 'Test',
          description: '',
          config: input.config,
          createdAt: at,
          updatedAt: at,
        };
        const sample = input.sample;
        const evalCase: EvalCaseSnapshot = { input: sample.input, tags: [] };
        return yield* gradeTrial(grader, {
          case: {
            ...evalCase,
            ...(sample.expected === undefined ? undefined : { expected: sample.expected }),
            ...(sample.metadata === undefined ? undefined : { metadata: sample.metadata }),
          },
          output: {
            text: sample.output,
            state: 'completed',
            toolCalls: sample.toolCalls ?? [],
            durationMs: sample.durationMs ?? 0,
          },
        }).pipe(Effect.provideService(EvalJudge, judge));
      }),

      listRuns: () => fromStore(store.listRuns()),
      getRun: requireRun,
      preflight: (input) => Effect.asVoid(prepareRun(input)),
      startRun,
      regradeRun,
      cancelRun: Effect.fn('EvalService.cancelRun')(function* (id: EvalRunId) {
        const fiber = yield* FiberMap.get(fibers, id);
        if (Option.isSome(fiber)) {
          // Waits for the interruption, so the run is marked canceled by the time this returns.
          yield* Fiber.interrupt(fiber.value);
        } else {
          const detail = yield* requireRun(id);
          if (detail.run.status === 'running') yield* finish(id, 'canceled');
        }
        return yield* loadRun(id);
      }),
      removeRun: Effect.fn('EvalService.removeRun')(function* (id: EvalRunId) {
        const fiber = yield* FiberMap.get(fibers, id);
        if (Option.isSome(fiber)) yield* Fiber.interrupt(fiber.value);
        return yield* fromStore(store.removeRun(id));
      }, touchesEvals),
      setReview: Effect.fn('EvalService.setReview')(function* (
        runId: EvalRunId,
        trialId: EvalTrialId,
        input: SetEvalReviewInput,
        reviewedBy: string | undefined,
      ) {
        const review =
          input.review === null
            ? null
            : {
                passed: input.review.passed,
                note: input.review.note.trim(),
                reviewedAt: yield* now,
                ...(reviewedBy === undefined ? undefined : { reviewedBy }),
              };
        const trial = yield* fromStore(store.setReview(runId, trialId, review));
        if (!trial) return yield* new EvalNotFoundError({ message: `Trial ${trialId} not found.` });
        return trial;
      }, touchesEvals),
    });
  }),
).pipe(Layer.provide(ChangeFeedLive));
