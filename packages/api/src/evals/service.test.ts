import { describe, expect, it } from '@effect/vitest';
import { EvalRunId as EvalRunIdSchema } from 'agentdock-sdk/schemas';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { EvalService, EvalServiceLive } from './service';
import { EvalStore } from './store';
import {
  awaitRun,
  exactMatch,
  fakeJudge,
  fakeProviderKeys,
  fakeTargets,
  judge,
  judgeConfig,
  serviceLayer,
  storeLayer,
  type TargetCall,
} from './test-layers';

describe('EvalService datasets and graders', () => {
  it.effect('creates a dataset with cases, edits and removes cases, and aggregates tags', () =>
    Effect.gen(function* () {
      const evals = yield* EvalService;
      const dataset = yield* evals.createDataset({
        name: '  Capitals ',
        description: '',
        graderIds: [],
        cases: [
          { input: 'paris', expected: 'PARIS', tags: ['regression', ' europe '] },
          { input: 'berlin', expected: '', metadata: {} },
        ],
      });
      expect(dataset).toMatchObject({ name: 'Capitals', caseCount: 2, tags: ['europe', 'regression'] });

      const added = yield* evals.addCases(dataset.id, { cases: [{ input: 'rome', tags: ['capability'] }] });
      expect(added).toHaveLength(1);
      const detail = yield* evals.getDataset(dataset.id);
      expect(detail.cases.map((evalCase) => evalCase.input)).toEqual(['paris', 'berlin', 'rome']);
      expect(detail.cases[1]?.expected).toBeUndefined();

      const [first] = detail.cases;
      if (!first) return expect.unreachable();
      const edited = yield* evals.updateCase(dataset.id, first.id, { input: 'Paris', expected: 'PARIS', tags: [] });
      expect(edited).toMatchObject({ input: 'Paris', tags: [] });
      expect(yield* evals.removeCases(dataset.id, [first.id])).toBe(1);
      expect((yield* evals.getDataset(dataset.id)).dataset).toMatchObject({ caseCount: 2, tags: ['capability'] });

      const empty = yield* Effect.flip(evals.addCases(dataset.id, { cases: [{ input: '   ' }] }));
      expect(empty.message).toBe('Case 1 has an empty input.');
    }).pipe(Effect.provide(serviceLayer([]))),
  );

  it.effect('validates grader configs and drops a deleted grader from dataset defaults', () =>
    Effect.gen(function* () {
      const evals = yield* EvalService;
      const invalidRegex = yield* Effect.flip(
        evals.createGrader({
          name: 'Bad',
          description: '',
          config: { type: 'regex', pattern: '(', flags: '', negate: false },
        }),
      );
      expect(invalidRegex.message).toContain('Invalid regular expression');
      const blindJudge = yield* Effect.flip(
        evals.createGrader({ ...judge(), config: { ...judgeConfig(), prompt: 'Grade {{input}}' } }),
      );
      expect(blindJudge.message).toContain('{{output}} or {{transcript}}');
      const typo = yield* Effect.flip(
        evals.createGrader({ ...judge(), config: { ...judgeConfig(), prompt: '{{output}} vs {{expceted}}' } }),
      );
      expect(typo.message).toBe('Unknown template variables: {{expceted}}.');

      const grader = yield* evals.createGrader(exactMatch);
      const dataset = yield* evals.createDataset({ name: 'D', description: '', graderIds: [grader.id] });
      expect(yield* evals.removeGrader(grader.id)).toBe(true);
      expect((yield* evals.getDataset(dataset.id)).dataset.graderIds).toEqual([]);
    }).pipe(Effect.provide(serviceLayer([]))),
  );

  it.effect('tests a grader on a hand-written sample', () =>
    Effect.gen(function* () {
      const evals = yield* EvalService;
      const grade = yield* evals.testGrader({
        config: judgeConfig(),
        sample: { input: 'capital of France?', output: 'PARIS' },
      });
      expect(grade).toMatchObject({ passed: true, label: 'PASS', reasoning: 'Looks right.' });
    }).pipe(Effect.provide(serviceLayer([]))),
  );
});

describe('EvalService runs', () => {
  it.live('runs every case and trial, records errored trials apart, and summarizes the run', () => {
    const calls: Array<TargetCall> = [];
    return Effect.gen(function* () {
      const evals = yield* EvalService;
      const exact = yield* evals.createGrader(exactMatch);
      const judgeGrader = yield* evals.createGrader(judge());
      const dataset = yield* evals.createDataset({
        name: 'Capitals',
        description: '',
        graderIds: [exact.id, judgeGrader.id],
        cases: [
          { input: 'paris', expected: 'PARIS', tags: ['a'] },
          { input: 'rome', expected: 'Roma', tags: ['a'] },
          { input: 'fail: berlin', expected: 'BERLIN', tags: ['b'] },
        ],
      });

      const started = yield* evals.startRun({
        datasetId: dataset.id,
        target: { kind: 'agent', id: 'echo' },
        graderIds: [exact.id, judgeGrader.id],
        trials: 2,
        concurrency: 3,
      });
      expect(started).toMatchObject({
        status: 'running',
        name: 'Echo agent · Capitals',
        target: { model: 'openai:echo' },
      });
      const { run, trials } = yield* awaitRun(started.id);

      expect(run.status).toBe('completed');
      expect(calls).toHaveLength(6);
      expect(trials.map((trial) => [trial.case.input, trial.index, trial.status])).toEqual([
        ['paris', 0, 'completed'],
        ['paris', 1, 'completed'],
        ['rome', 0, 'completed'],
        ['rome', 1, 'completed'],
        ['fail: berlin', 0, 'errored'],
        ['fail: berlin', 1, 'errored'],
      ]);
      expect(trials[4]?.error).toBe('model unavailable');
      expect(trials[0]?.grades.map((grade) => grade.passed)).toEqual([true, true]);
      expect(trials[2]?.passed).toBe(false);
      expect(run.summary).toMatchObject({
        totalTrials: 6,
        completedTrials: 4,
        erroredTrials: 2,
        passAtK: 0.5,
        passAllK: 0.5,
      });
      expect(run.summary.passRate?.mean).toBe(0.5);
      expect(run.summary.graders.map((grader) => grader.passRate?.n)).toEqual([2, 2]);
    }).pipe(Effect.provide(serviceLayer(calls)));
  });

  it.live('narrows a run by tags and limit, and refuses a judge whose provider has no key', () => {
    const calls: Array<TargetCall> = [];
    return Effect.gen(function* () {
      const evals = yield* EvalService;
      const grader = yield* evals.createGrader(exactMatch);
      const dataset = yield* evals.createDataset({
        name: 'D',
        description: '',
        graderIds: [],
        cases: [
          { input: 'one', tags: ['x'] },
          { input: 'two', tags: ['y'] },
          { input: 'three', tags: ['y'] },
        ],
      });
      const base = { datasetId: dataset.id, target: { kind: 'agent' as const, id: 'echo' }, trials: 1, concurrency: 1 };
      const started = yield* evals.startRun({ ...base, graderIds: [grader.id], tags: ['y'], limit: 1 });
      const { trials } = yield* awaitRun(started.id);
      expect(trials.map((trial) => trial.case.input)).toEqual(['two']);

      const anthropicJudge = yield* evals.createGrader(judge('anthropic:judge'));
      const refused = yield* Effect.flip(evals.startRun({ ...base, graderIds: [anthropicJudge.id] }));
      expect(refused.message).toBe("The grader 'Judge' uses anthropic, which has no API key configured.");
      const missing = yield* Effect.flip(
        evals.startRun({ ...base, graderIds: [], target: { kind: 'agent', id: 'missing' } }),
      );
      expect(missing._tag).toBe('EvalValidationError');
      expect(calls).toHaveLength(1);
    }).pipe(Effect.provide(serviceLayer(calls)));
  });

  it.live('cancels a run in progress', () => {
    const calls: Array<TargetCall> = [];
    return Effect.gen(function* () {
      const evals = yield* EvalService;
      const dataset = yield* evals.createDataset({
        name: 'Slow',
        description: '',
        graderIds: [],
        cases: [{ input: 'hang: one' }, { input: 'hang: two' }, { input: 'hang: three' }],
      });
      const started = yield* evals.startRun({
        datasetId: dataset.id,
        target: { kind: 'agent', id: 'echo' },
        graderIds: [],
        trials: 1,
        concurrency: 2,
      });
      yield* Effect.sleep(Duration.millis(50));
      const canceled = yield* evals.cancelRun(started.id);
      expect(canceled.status).toBe('canceled');
      const { trials } = yield* evals.getRun(started.id);
      expect(trials.map((trial) => trial.status)).toEqual(['canceled', 'canceled', 'canceled']);
      expect(calls).toHaveLength(2);
    }).pipe(Effect.provide(serviceLayer(calls)));
  });

  it.live('re-grades a finished run without calling the target, keeping human reviews', () => {
    const calls: Array<TargetCall> = [];
    const prompts: Array<string> = [];
    return Effect.gen(function* () {
      const evals = yield* EvalService;
      const exact = yield* evals.createGrader(exactMatch);
      const judgeGrader = yield* evals.createGrader(judge());
      const dataset = yield* evals.createDataset({
        name: 'Capitals',
        description: '',
        graderIds: [],
        cases: [
          { input: 'paris', expected: 'PARIS' },
          { input: 'rome', expected: 'Roma' },
        ],
      });
      const source = yield* evals.startRun({
        datasetId: dataset.id,
        target: { kind: 'agent', id: 'echo' },
        graderIds: [exact.id],
        trials: 1,
        concurrency: 1,
      });
      const finished = yield* awaitRun(source.id);
      const [paris, rome] = finished.trials;
      if (!paris || !rome) return expect.unreachable();
      yield* evals.setReview(source.id, paris.id, { review: { passed: true, note: ' fine ' } }, 'reviewer@example.com');
      const reviewed = yield* evals.setReview(source.id, rome.id, { review: { passed: true, note: '' } }, undefined);
      expect(reviewed.review).toMatchObject({ passed: true, note: '' });

      const agreement = (yield* evals.getRun(source.id)).run.summary.graders[0]?.agreement;
      expect(agreement).toEqual({ agreed: 1, total: 2 });

      const regrade = yield* evals.regradeRun(source.id, { graderIds: [judgeGrader.id] });
      expect(regrade.sourceRunId).toBe(source.id);
      const { run, trials } = yield* awaitRun(regrade.id);
      expect(calls).toHaveLength(2);
      expect(trials.map((trial) => trial.review?.note)).toEqual(['fine', '']);
      expect(trials[0]?.review?.reviewedBy).toBe('reviewer@example.com');
      expect(run.summary.graders[0]).toMatchObject({ graderName: 'Judge', agreement: { agreed: 1, total: 2 } });
      expect(prompts).toEqual(['Answer: PARIS', 'Answer: ROME']);
    }).pipe(Effect.provide(serviceLayer(calls, prompts)));
  });

  it.live('records what each trial spent, errored ones included, and nothing again on a re-grade', () => {
    const calls: Array<TargetCall> = [];
    return Effect.gen(function* () {
      const evals = yield* EvalService;
      const grader = yield* evals.createGrader(exactMatch);
      const dataset = yield* evals.createDataset({
        name: 'Spend',
        description: '',
        graderIds: [],
        cases: [{ input: 'paris', expected: 'PARIS' }, { input: 'fail: rome' }],
      });
      const started = yield* evals.startRun({
        datasetId: dataset.id,
        target: { kind: 'agent', id: 'echo' },
        graderIds: [grader.id],
        trials: 1,
        concurrency: 2,
      });
      const { run, trials } = yield* awaitRun(started.id);
      expect(trials.map((trial) => [trial.status, trial.usage?.total.calls])).toEqual([
        ['completed', 1],
        ['errored', 1],
      ]);
      expect(run.summary.targetUsage?.total).toMatchObject({ calls: 2 });
      expect(run.summary.targetUsage?.total.cost?.total).toBeCloseTo(0.02);
      expect(run.summary.meanTrialCost).toBeCloseTo(0.01);
      expect(run.trigger).toEqual({ kind: 'manual' });

      const regrade = yield* evals.regradeRun(started.id, { graderIds: [grader.id] });
      const regraded = yield* awaitRun(regrade.id);
      expect(regraded.run.trigger).toEqual({ kind: 'regrade' });
      expect(regraded.run.summary.targetUsage).toBeUndefined();
      expect(regraded.run.baseline).toMatchObject({ runId: started.id, verdict: 'unchanged', sameGraders: true });
    }).pipe(Effect.provide(serviceLayer(calls)));
  });

  it.live('compares a run with the previous one of the same dataset and target', () => {
    const calls: Array<TargetCall> = [];
    return Effect.gen(function* () {
      const evals = yield* EvalService;
      const grader = yield* evals.createGrader(exactMatch);
      const inputs = ['paris', 'rome', 'berlin', 'madrid', 'vienna'];
      const dataset = yield* evals.createDataset({
        name: 'Capitals',
        description: '',
        graderIds: [],
        cases: inputs.map((input) => ({ input, expected: input.toUpperCase() })),
      });
      const runInput = {
        datasetId: dataset.id,
        target: { kind: 'agent' as const, id: 'echo' },
        graderIds: [grader.id],
        trials: 1,
        concurrency: 2,
      };
      const first = yield* awaitRun((yield* evals.startRun(runInput)).id);
      expect(first.run.baseline).toBeUndefined();
      expect(first.run.summary.passRate?.mean).toBe(1);

      // New reference answers the echo cannot meet: every case regresses.
      for (const evalCase of (yield* evals.getDataset(dataset.id)).cases) {
        yield* evals.updateCase(dataset.id, evalCase.id, { input: evalCase.input, expected: 'something else' });
      }
      const second = yield* awaitRun((yield* evals.startRun(runInput)).id);
      expect(second.run.baseline).toMatchObject({
        runId: first.run.id,
        verdict: 'regressed',
        regressions: 5,
        pairedCases: 5,
        baselinePassRate: 1,
        candidatePassRate: 0,
      });
      expect(second.run.baseline?.candidateMeanCost).toBeCloseTo(0.01);
      const listed = (yield* evals.listRuns()).find((run) => run.id === second.run.id);
      expect(listed?.baseline?.verdict).toBe('regressed');
    }).pipe(Effect.provide(serviceLayer(calls)));
  });

  it.effect('closes runs a previous process left running', () =>
    Effect.gen(function* () {
      const store = yield* EvalStore;
      const id = EvalRunIdSchema.make('erun_orphan');
      yield* store.insertRun(
        {
          id,
          name: 'Orphan',
          datasetId: 'eds_gone',
          datasetName: 'Gone',
          target: { kind: 'agent', id: 'echo', name: 'Echo' },
          graders: [],
          trials: 1,
          concurrency: 1,
          status: 'running',
          createdAt: 0,
        },
        [
          {
            id: 'etr_orphan',
            runId: id,
            caseId: 'ecs_gone',
            position: 0,
            trialIndex: 0,
            case: { input: 'x', tags: [] },
            status: 'running',
            grades: [],
          },
        ],
      );
      const detail = yield* Effect.gen(function* () {
        const evals = yield* EvalService;
        return yield* evals.getRun(id);
      }).pipe(
        Effect.provide(
          EvalServiceLive.pipe(Layer.provide(Layer.mergeAll(fakeTargets([]), fakeJudge(), fakeProviderKeys))),
        ),
      );
      expect(detail.run).toMatchObject({
        status: 'failed',
        error: 'The server restarted while this run was in progress.',
      });
      expect(detail.trials[0]?.status).toBe('canceled');
    }).pipe(Effect.provide(storeLayer)),
  );
});
