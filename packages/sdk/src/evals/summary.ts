import type {
  EvalBaselineComparison,
  EvalCaseId,
  EvalComparisonVerdict,
  EvalGrade,
  EvalGrader,
  EvalGraderSummary,
  EvalMetric,
  EvalRunId,
  EvalRunSummary,
  EvalTrial,
  EvalUsage,
} from '../schemas/evals';
import { sumEvalUsage, sumTargetUsage } from './usage';

/** Two-sided 95% normal quantile. */
const Z_95 = 1.959964;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

const mean = (values: ReadonlyArray<number>): number =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

/** Unbiased sample variance; zero below two values, where it is undefined. */
const sampleVariance = (values: ReadonlyArray<number>): number => {
  if (values.length < 2) return 0;
  const center = mean(values);
  return values.reduce((total, value) => total + (value - center) ** 2, 0) / (values.length - 1);
};

/**
 * A mean over independent units with its standard error and 95% interval.
 * Scores live on 0..1, so the interval is clamped there. With a single unit
 * the error is reported as zero; `n` tells the reader how little that means.
 */
export const metricFromValues = (values: ReadonlyArray<number>): EvalMetric => {
  const center = mean(values);
  const standardError = Math.sqrt(sampleVariance(values) / Math.max(values.length, 1));
  return {
    mean: center,
    standardError,
    low: clamp(center - Z_95 * standardError, 0, 1),
    high: clamp(center + Z_95 * standardError, 0, 1),
    n: values.length,
  };
};

/**
 * Trials of the same case are correlated, so pooling them overstates the
 * sample size. Averaging each case's trials first and taking the error over
 * cases is the clustered estimate recommended by "Adding error bars to evals".
 */
export const clusteredMetric = (
  observations: ReadonlyArray<{ readonly caseId: string; readonly value: number }>,
): EvalMetric | undefined => {
  if (observations.length === 0) return undefined;
  const byCase = new Map<string, Array<number>>();
  for (const observation of observations) {
    const values = byCase.get(observation.caseId);
    if (values) values.push(observation.value);
    else byCase.set(observation.caseId, [observation.value]);
  }
  return metricFromValues([...byCase.values()].map(mean));
};

const usagesOf = (grades: ReadonlyArray<EvalGrade>): ReadonlyArray<EvalUsage> =>
  grades.flatMap((grade) => (grade.usage ? [grade.usage] : []));

/** What the target cost per trial, over trials whose every call was priced. */
const meanTrialCost = (trials: ReadonlyArray<EvalTrial>): number | undefined => {
  const costs = trials.flatMap((trial) =>
    trial.usage?.total.cost === undefined ? [] : [trial.usage.total.cost.total],
  );
  return costs.length === 0 ? undefined : mean(costs);
};

const meanDuration = (trials: ReadonlyArray<EvalTrial>): number | undefined => {
  const durations = trials.flatMap((trial) =>
    trial.status === 'completed' && trial.output ? [trial.output.durationMs] : [],
  );
  return durations.length === 0 ? undefined : mean(durations);
};

const graderSummary = (grader: EvalGrader, trials: ReadonlyArray<EvalTrial>): EvalGraderSummary => {
  const graded = trials.flatMap((trial) => {
    const grade = trial.grades.find((candidate) => candidate.graderId === grader.id);
    return grade ? [{ trial, grade }] : [];
  });
  const scored = graded.flatMap(({ trial, grade }) =>
    grade.score === undefined ? [] : [{ caseId: trial.caseId, grade, score: grade.score, review: trial.review }],
  );
  const reviewed = scored.flatMap(({ grade, review }) => (review ? [grade.passed === review.passed] : []));
  const usage = sumEvalUsage(usagesOf(graded.map(({ grade }) => grade)));
  const summary: EvalGraderSummary = {
    graderId: grader.id,
    graderName: grader.name,
    graderType: grader.config.type,
    unscored: graded.length - scored.length,
    agreement: { agreed: reviewed.filter(Boolean).length, total: reviewed.length },
  };
  const passRate = clusteredMetric(scored.map(({ caseId, grade }) => ({ caseId, value: grade.passed ? 1 : 0 })));
  const meanScore = clusteredMetric(scored.map(({ caseId, score }) => ({ caseId, value: score })));
  return {
    ...summary,
    ...(passRate === undefined ? undefined : { passRate }),
    ...(meanScore === undefined ? undefined : { meanScore }),
    ...(usage === undefined ? undefined : { usage }),
  };
};

/** Aggregates a run's trials into the headline numbers the dashboard shows. */
export const summarizeEvalRun = (
  graders: ReadonlyArray<EvalGrader>,
  trials: ReadonlyArray<EvalTrial>,
): EvalRunSummary => {
  const completed = trials.filter((trial) => trial.status === 'completed');
  const passed = completed.flatMap((trial) =>
    trial.passed === undefined ? [] : [{ caseId: trial.caseId, value: trial.passed ? 1 : 0 }],
  );
  const byCase = new Map<EvalCaseId, Array<boolean>>();
  for (const trial of completed) {
    if (trial.passed === undefined) continue;
    const outcomes = byCase.get(trial.caseId);
    if (outcomes) outcomes.push(trial.passed);
    else byCase.set(trial.caseId, [trial.passed]);
  }
  const cases = [...byCase.values()];
  const meanDurationMs = meanDuration(trials);
  const passRate = clusteredMetric(passed);
  const judgeUsage = sumEvalUsage(usagesOf(trials.flatMap((trial) => trial.grades)));
  const targetUsage = sumTargetUsage(trials.flatMap((trial) => (trial.usage ? [trial.usage] : [])));
  const trialCost = meanTrialCost(trials);

  const summary: EvalRunSummary = {
    totalTrials: trials.length,
    completedTrials: completed.length,
    erroredTrials: trials.filter((trial) => trial.status === 'errored').length,
    pendingTrials: trials.filter((trial) => trial.status === 'pending' || trial.status === 'running').length,
    canceledTrials: trials.filter((trial) => trial.status === 'canceled').length,
    graders: graders.map((grader) => graderSummary(grader, completed)),
    reviewedTrials: trials.filter((trial) => trial.review !== undefined).length,
  };
  return {
    ...summary,
    ...(passRate === undefined ? undefined : { passRate }),
    ...(cases.length === 0
      ? undefined
      : {
          passAtK: cases.filter((outcomes) => outcomes.some(Boolean)).length / cases.length,
          passAllK: cases.filter((outcomes) => outcomes.every(Boolean)).length / cases.length,
        }),
    ...(meanDurationMs === undefined ? undefined : { meanDurationMs }),
    ...(targetUsage === undefined ? undefined : { targetUsage }),
    ...(trialCost === undefined ? undefined : { meanTrialCost: trialCost }),
    ...(judgeUsage === undefined ? undefined : { judgeUsage }),
  };
};

/** One case's standing in both runs of a comparison. */
export type EvalCaseComparison = {
  readonly caseId: EvalCaseId;
  readonly input: string;
  readonly baseline: number;
  readonly candidate: number;
  readonly delta: number;
};

/**
 * A paired comparison of two runs over the cases both completed. Pairing
 * cancels out how hard each case is, so the difference is estimated from the
 * per-case deltas (`SE = sd(delta) / sqrt(n)`) rather than from two
 * independent errors, which is what "A statistical approach to model
 * evaluations" recommends. `correlation` is how strongly case difficulty
 * carried over between the runs; the higher it is, the more pairing helped.
 */
export type EvalRunComparison = {
  readonly pairedCases: number;
  readonly baselinePassRate: number;
  readonly candidatePassRate: number;
  readonly difference: {
    readonly mean: number;
    readonly standardError: number;
    readonly low: number;
    readonly high: number;
  };
  readonly correlation: number | undefined;
  readonly regressions: ReadonlyArray<EvalCaseComparison>;
  readonly improvements: ReadonlyArray<EvalCaseComparison>;
  readonly baselineMeanCost: number | undefined;
  readonly candidateMeanCost: number | undefined;
  readonly baselineMeanDurationMs: number | undefined;
  readonly candidateMeanDurationMs: number | undefined;
};

const casePassRates = (
  trials: ReadonlyArray<EvalTrial>,
): Map<EvalCaseId, { readonly input: string; readonly rate: number }> => {
  const outcomes = new Map<EvalCaseId, { readonly input: string; readonly values: Array<number> }>();
  for (const trial of trials) {
    if (trial.status !== 'completed' || trial.passed === undefined) continue;
    const entry = outcomes.get(trial.caseId);
    if (entry) entry.values.push(trial.passed ? 1 : 0);
    else outcomes.set(trial.caseId, { input: trial.case.input, values: [trial.passed ? 1 : 0] });
  }
  return new Map([...outcomes].map(([caseId, entry]) => [caseId, { input: entry.input, rate: mean(entry.values) }]));
};

const pearson = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): number | undefined => {
  if (left.length < 2) return undefined;
  const leftMean = mean(left);
  const rightMean = mean(right);
  let covariance = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  left.forEach((value, index) => {
    const leftDelta = value - leftMean;
    const rightDelta = (right[index] ?? 0) - rightMean;
    covariance += leftDelta * rightDelta;
    leftSquares += leftDelta ** 2;
    rightSquares += rightDelta ** 2;
  });
  const scale = Math.sqrt(leftSquares * rightSquares);
  return scale === 0 ? undefined : covariance / scale;
};

export const compareEvalRuns = (
  baselineTrials: ReadonlyArray<EvalTrial>,
  candidateTrials: ReadonlyArray<EvalTrial>,
): EvalRunComparison => {
  const baseline = casePassRates(baselineTrials);
  const candidate = casePassRates(candidateTrials);
  const paired = [...candidate].flatMap(([caseId, entry]): ReadonlyArray<EvalCaseComparison> => {
    const before = baseline.get(caseId);
    return before
      ? [{ caseId, input: entry.input, baseline: before.rate, candidate: entry.rate, delta: entry.rate - before.rate }]
      : [];
  });
  const deltas = paired.map((entry) => entry.delta);
  const differenceMean = mean(deltas);
  const standardError = Math.sqrt(sampleVariance(deltas) / Math.max(deltas.length, 1));
  const byDelta = (left: EvalCaseComparison, right: EvalCaseComparison) => left.delta - right.delta;
  return {
    pairedCases: paired.length,
    baselinePassRate: mean(paired.map((entry) => entry.baseline)),
    candidatePassRate: mean(paired.map((entry) => entry.candidate)),
    difference: {
      mean: differenceMean,
      standardError,
      low: clamp(differenceMean - Z_95 * standardError, -1, 1),
      high: clamp(differenceMean + Z_95 * standardError, -1, 1),
    },
    correlation: pearson(
      paired.map((entry) => entry.baseline),
      paired.map((entry) => entry.candidate),
    ),
    regressions: paired.filter((entry) => entry.delta < 0).sort(byDelta),
    improvements: paired.filter((entry) => entry.delta > 0).sort((left, right) => byDelta(right, left)),
    baselineMeanCost: meanTrialCost(baselineTrials),
    candidateMeanCost: meanTrialCost(candidateTrials),
    baselineMeanDurationMs: meanDuration(baselineTrials),
    candidateMeanDurationMs: meanDuration(candidateTrials),
  };
};

/**
 * Only a difference whose 95% interval excludes zero counts as a change; a
 * single paired case cannot show one, whatever its delta.
 */
const verdictOf = (comparison: EvalRunComparison): EvalComparisonVerdict => {
  if (comparison.pairedCases < 2) return 'unchanged';
  if (comparison.difference.high < 0) return 'regressed';
  return comparison.difference.low > 0 ? 'improved' : 'unchanged';
};

/** A run measured against its baseline, in the form a run carries it. */
export const baselineComparison = (
  baseline: {
    readonly id: EvalRunId;
    readonly name: string;
    readonly graderIds: ReadonlyArray<string>;
    readonly trials: ReadonlyArray<EvalTrial>;
  },
  candidate: { readonly graderIds: ReadonlyArray<string>; readonly trials: ReadonlyArray<EvalTrial> },
): EvalBaselineComparison => {
  const comparison = compareEvalRuns(baseline.trials, candidate.trials);
  const sameGraders =
    baseline.graderIds.length === candidate.graderIds.length &&
    baseline.graderIds.every((id) => candidate.graderIds.includes(id));
  const result: EvalBaselineComparison = {
    runId: baseline.id,
    name: baseline.name,
    pairedCases: comparison.pairedCases,
    baselinePassRate: comparison.baselinePassRate,
    candidatePassRate: comparison.candidatePassRate,
    difference: comparison.difference,
    verdict: verdictOf(comparison),
    sameGraders,
    regressions: comparison.regressions.length,
    improvements: comparison.improvements.length,
  };
  return {
    ...result,
    ...(comparison.baselineMeanCost === undefined ? undefined : { baselineMeanCost: comparison.baselineMeanCost }),
    ...(comparison.candidateMeanCost === undefined ? undefined : { candidateMeanCost: comparison.candidateMeanCost }),
    ...(comparison.baselineMeanDurationMs === undefined
      ? undefined
      : { baselineMeanDurationMs: comparison.baselineMeanDurationMs }),
    ...(comparison.candidateMeanDurationMs === undefined
      ? undefined
      : { candidateMeanDurationMs: comparison.candidateMeanDurationMs }),
  };
};
