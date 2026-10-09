import type {
  EvalBaselineComparison,
  EvalGateWatchedField,
  EvalGraderConfig,
  EvalGraderType,
  EvalMetric,
  EvalRun,
  EvalRunStatus,
  EvalRunSummary,
  EvalRunTrigger,
  EvalTrial,
  EvalTrialStatus,
} from 'agentdock-sdk/schemas';

export const formatPercent = (value: number, digits = 0): string => `${(value * 100).toFixed(digits)}%`;

/** `72% ± 6` with the 95% interval half-width, the form "Adding error bars to evals" recommends reporting. */
export const formatMetric = (metric: EvalMetric): string => {
  const halfWidth = (metric.high - metric.low) / 2;
  return metric.n < 2 ? formatPercent(metric.mean) : `${formatPercent(metric.mean)} ± ${(halfWidth * 100).toFixed(0)}`;
};

export const GRADER_TYPE_LABELS = {
  'exact-match': 'Exact match',
  contains: 'Contains',
  regex: 'Regex',
  json: 'Valid JSON',
  'json-match': 'JSON match',
  numeric: 'Numeric',
  similarity: 'Similarity',
  'tool-calls': 'Tool calls',
  latency: 'Latency',
  'llm-judge': 'LLM judge',
} satisfies Record<EvalGraderType, string>;

export const graderSummary = (config: EvalGraderConfig): string => {
  switch (config.type) {
    case 'exact-match':
      return `equals ${config.expected}`;
    case 'contains':
      return `${config.mode} of ${config.values.join(', ')}`;
    case 'regex':
      return `${config.negate ? 'does not match' : 'matches'} /${config.pattern}/${config.flags}`;
    case 'json':
      return config.schema ? 'JSON matching a schema' : 'parses as JSON';
    case 'json-match':
      return `${config.mode} match of ${config.expected}`;
    case 'numeric':
      return `within ${config.relative ? formatPercent(config.tolerance, 1) : config.tolerance} of ${config.expected}`;
    case 'similarity':
      return `similarity ≥ ${config.threshold} to ${config.expected}`;
    case 'tool-calls': {
      const parts = [
        config.required.length > 0 ? `calls ${config.required.join(config.ordered ? ' → ' : ', ')}` : '',
        config.forbidden.length > 0 ? `never ${config.forbidden.join(', ')}` : '',
        config.maxCalls === undefined ? '' : `≤ ${config.maxCalls} calls`,
      ].filter(Boolean);
      return parts.join('; ');
    }
    case 'latency':
      return `under ${config.maxDurationMs / 1000}s`;
    case 'llm-judge':
      return `${config.model || 'no model'} · ${
        config.scoring.kind === 'scale'
          ? `${config.scoring.min}–${config.scoring.max} scale`
          : config.scoring.choices.map((choice) => choice.label).join(' / ')
      }`;
  }
};

export const runStatusVariant = (status: EvalRunStatus) =>
  status === 'completed'
    ? 'success'
    : status === 'running'
      ? 'secondary'
      : status === 'failed'
        ? 'destructive'
        : 'outline';

export const trialStatusVariant = (trial: EvalTrial) => {
  if (trial.status !== 'completed') return trial.status === 'errored' ? 'warning' : 'outline';
  if (trial.passed === undefined) return 'outline';
  return trial.passed ? 'success' : 'destructive';
};

export const trialStatusLabel = (trial: EvalTrial): string => {
  const labels = {
    pending: 'pending',
    running: 'running',
    completed: 'graded',
    errored: 'errored',
    canceled: 'canceled',
  } satisfies Record<EvalTrialStatus, string>;

  if (trial.status === 'completed' && trial.passed !== undefined) return trial.passed ? 'pass' : 'fail';
  return labels[trial.status];
};

/** Things about a run's results worth a second look before trusting its number. */
export const runWarnings = (run: EvalRun, trials: ReadonlyArray<EvalTrial>): ReadonlyArray<string> => {
  const warnings: Array<string> = [];
  const summary = run.summary;
  if (summary.erroredTrials > 0) {
    warnings.push(
      `${summary.erroredTrials} trial${summary.erroredTrials === 1 ? '' : 's'} errored before grading. They count as infrastructure failures, not agent failures, and are left out of the pass rate.`,
    );
  }
  const sameModel = run.graders.filter(
    (grader) =>
      grader.config.type === 'llm-judge' && run.target.model !== undefined && grader.config.model === run.target.model,
  );
  if (sameModel.length > 0) {
    warnings.push(
      `${sameModel.map((grader) => grader.name).join(', ')} judge${sameModel.length === 1 ? 's' : ''} with the model under test. A model tends to favor its own answers; prefer a different judge model.`,
    );
  }
  const unscored = summary.graders.reduce((total, grader) => total + grader.unscored, 0);
  if (unscored > 0) {
    warnings.push(
      `${unscored} grade${unscored === 1 ? ' has' : 's have'} no score (grader error or UNKNOWN verdict). Review those trials.`,
    );
  }
  if (run.status === 'completed' && summary.passRate && summary.passRate.n >= 5) {
    if (summary.passRate.mean >= 0.95) {
      warnings.push(
        'Almost every case passes. The suite still catches regressions but no longer shows improvement; add harder cases.',
      );
    }
    const neverPassed = new Set<string>();
    const everPassed = new Set<string>();
    for (const trial of trials) {
      if (trial.status !== 'completed' || trial.passed === undefined) continue;
      if (trial.passed) everPassed.add(trial.caseId);
      else neverPassed.add(trial.caseId);
    }
    const zero = [...neverPassed].filter((caseId) => !everPassed.has(caseId)).length;
    if (zero > 0 && run.trials > 1) {
      warnings.push(
        `${zero} case${zero === 1 ? '' : 's'} failed every trial. A task nobody passes is often a broken task or grader; read those transcripts first.`,
      );
    }
  }
  return warnings;
};

const WATCHED_FIELD_LABELS = {
  instructions: 'instructions',
  model: 'model',
  reasoningEffort: 'reasoning effort',
  skills: 'skills',
} satisfies Record<EvalGateWatchedField, string>;

/** Why a run exists, when it was not simply started by hand. */
export const triggerLabel = (trigger: EvalRunTrigger): string | undefined => {
  switch (trigger.kind) {
    case 'manual':
      return undefined;
    case 'regrade':
      return 're-grade';
    case 'gate':
      return trigger.changed.length === 0
        ? 'gate · on demand'
        : `gate · ${trigger.changed.map((field) => WATCHED_FIELD_LABELS[field]).join(', ')} changed`;
  }
};

const signedPoints = (value: number): string => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}`;

export const verdictVariant = (verdict: EvalBaselineComparison['verdict']) =>
  verdict === 'regressed' ? 'destructive' : verdict === 'improved' ? 'success' : 'outline';

export const verdictLabel = (comparison: EvalBaselineComparison): string =>
  comparison.verdict === 'unchanged'
    ? `no clear change (${signedPoints(comparison.difference.mean)} pts)`
    : `${comparison.verdict} ${signedPoints(comparison.difference.mean)} pts`;

/** Everything a run spent: the target's calls plus the judges', or undefined when any part is unpriced. */
export const runCost = (summary: EvalRunSummary): number | undefined => {
  const target = summary.targetUsage?.total.cost?.total;
  const judges = summary.judgeUsage?.cost?.total;
  const targetUnpriced = summary.targetUsage !== undefined && target === undefined;
  const judgesUnpriced = summary.judgeUsage !== undefined && judges === undefined;
  if (targetUnpriced || judgesUnpriced || (target === undefined && judges === undefined)) return undefined;
  return (target ?? 0) + (judges ?? 0);
};
