import * as Schema from 'effect/Schema';
import { Json, JsonObject } from './json';
import { ReasoningEffort } from './reasoning';
import { CostBreakdown, NonNegativeInt, TokenUsage } from './usage';

/**
 * Evals follow the vocabulary of Anthropic's "Demystifying evals for AI
 * agents": a dataset holds cases (tasks), a run sends every case to a target
 * one or more times (trials), and graders score each trial's output and
 * transcript. Human reviews sit beside the automated grades so LLM judges can
 * be calibrated against them.
 */

export const EvalDatasetId = Schema.String.pipe(Schema.brand('EvalDatasetId'));
export const EvalCaseId = Schema.String.pipe(Schema.brand('EvalCaseId'));
export const EvalGraderId = Schema.String.pipe(Schema.brand('EvalGraderId'));
export const EvalRunId = Schema.String.pipe(Schema.brand('EvalRunId'));
export const EvalGateId = Schema.String.pipe(Schema.brand('EvalGateId'));
export const EvalTrialId = Schema.String.pipe(Schema.brand('EvalTrialId'));

const Fraction = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * One task: the message sent to the target, and what a good answer looks
 * like. `expected` is the reference ("golden") answer graders compare
 * against; `metadata` carries any further per-case facts a grader template
 * can reference as `{{metadata.<key>}}`. Tags split a dataset into suites,
 * such as `regression` and `capability`.
 */
export const EvalCaseInput = Schema.Struct({
  input: Schema.String,
  expected: Schema.optional(Schema.String),
  metadata: Schema.optional(JsonObject),
  tags: Schema.optional(Schema.Array(Schema.String)),
});

export const EvalCase = Schema.Struct({
  id: EvalCaseId,
  datasetId: EvalDatasetId,
  input: Schema.String,
  expected: Schema.optional(Schema.String),
  metadata: Schema.optional(JsonObject),
  tags: Schema.Array(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const EvalDataset = Schema.Struct({
  id: EvalDatasetId,
  name: Schema.String,
  description: Schema.String,
  /** The graders a new run of this dataset starts with. */
  graderIds: Schema.Array(EvalGraderId),
  caseCount: NonNegativeInt,
  /** Every tag used by one of its cases, for filtering a run to a suite. */
  tags: Schema.Array(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const EvalDatasetList = Schema.Array(EvalDataset);

export const EvalDatasetInput = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  graderIds: Schema.Array(EvalGraderId),
});

export const CreateEvalDatasetInput = Schema.Struct({
  ...EvalDatasetInput.fields,
  cases: Schema.optional(Schema.Array(EvalCaseInput)),
});

export const EvalDatasetDetail = Schema.Struct({
  dataset: EvalDataset,
  cases: Schema.Array(EvalCase),
});

export const AddEvalCasesInput = Schema.Struct({
  cases: Schema.Array(EvalCaseInput),
});

export const EvalCaseList = Schema.Array(EvalCase);

export const RemoveEvalCasesInput = Schema.Struct({
  caseIds: Schema.Array(EvalCaseId),
});

export const RemoveEvalCasesResponse = Schema.Struct({
  removed: NonNegativeInt,
});

export const RemoveEvalResponse = Schema.Struct({
  removed: Schema.Boolean,
});

/**
 * Code-based graders. Every string option is a template rendered against the
 * case and the trial before it is used, so `{{expected}}` compares against the
 * case's reference answer and `{{metadata.city}}` against one of its fields.
 */
export const ExactMatchGraderConfig = Schema.Struct({
  type: Schema.Literal('exact-match'),
  expected: Schema.String,
  caseSensitive: Schema.Boolean,
  /** Trim and collapse runs of whitespace on both sides before comparing. */
  normalizeWhitespace: Schema.Boolean,
});

export const ContainsGraderConfig = Schema.Struct({
  type: Schema.Literal('contains'),
  values: Schema.Array(Schema.String),
  /** `all` and `any` require the values; `none` forbids every one of them. */
  mode: Schema.Literals(['all', 'any', 'none']),
  caseSensitive: Schema.Boolean,
});

export const RegexGraderConfig = Schema.Struct({
  type: Schema.Literal('regex'),
  pattern: Schema.String,
  flags: Schema.String,
  /** Pass when the pattern does not match. */
  negate: Schema.Boolean,
});

/** The output parses as JSON and, when a schema is set, validates against it. */
export const JsonGraderConfig = Schema.Struct({
  type: Schema.Literal('json'),
  schema: Schema.optional(JsonObject),
});

/**
 * The output parses as JSON and matches the expected JSON: `exact` needs
 * deep equality, `subset` only the expected fields. The score is the share of
 * expected leaf values that matched, so a near miss earns partial credit.
 */
export const JsonMatchGraderConfig = Schema.Struct({
  type: Schema.Literal('json-match'),
  expected: Schema.String,
  mode: Schema.Literals(['exact', 'subset']),
});

/** The first number in the output is within `tolerance` of the expected number. */
export const NumericGraderConfig = Schema.Struct({
  type: Schema.Literal('numeric'),
  expected: Schema.String,
  tolerance: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Read `tolerance` as a fraction of the expected value instead of an absolute difference. */
  relative: Schema.Boolean,
});

/** Normalized Levenshtein similarity to the expected text, passing at `threshold`. */
export const SimilarityGraderConfig = Schema.Struct({
  type: Schema.Literal('similarity'),
  expected: Schema.String,
  threshold: Fraction,
  caseSensitive: Schema.Boolean,
});

/**
 * Transcript checks on the tools the target called. Anthropic warns that
 * exact tool sequences are too rigid a bar, so this checks presence, absence,
 * optional relative order, and a call budget rather than an exact trajectory.
 */
export const ToolCallsGraderConfig = Schema.Struct({
  type: Schema.Literal('tool-calls'),
  required: Schema.Array(Schema.String),
  forbidden: Schema.Array(Schema.String),
  /** The required tools must first appear in the listed order. */
  ordered: Schema.Boolean,
  maxCalls: Schema.optional(NonNegativeInt),
});

export const LatencyGraderConfig = Schema.Struct({
  type: Schema.Literal('latency'),
  maxDurationMs: PositiveInt,
});

/** A verdict the judge may return and what it scores. */
export const EvalJudgeChoice = Schema.Struct({
  label: Schema.String,
  score: Fraction,
  description: Schema.optional(Schema.String),
});

/**
 * How the judge answers. `choices` makes it pick one labelled verdict (the
 * `PASS`/`FAIL` pair, or graded levels such as autoevals' factuality
 * classes); `scale` makes it pick an integer that is normalized onto 0..1.
 */
export const LlmJudgeScoring = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('choices'), choices: Schema.Array(EvalJudgeChoice) }),
  Schema.Struct({ kind: Schema.Literal('scale'), min: Schema.Int, max: Schema.Int }),
]);

/**
 * A model-based grader. The prompt is the rubric; its template variables are
 * `{{input}}`, `{{output}}`, `{{expected}}`, `{{transcript}}` and
 * `{{metadata.<key>}}`. The judge always writes its reasoning before its
 * verdict. With `allowUnknown` it may also answer `UNKNOWN` when the rubric
 * cannot be applied, which fails the grade and flags the trial for a human
 * rather than forcing a guess.
 */
export const LlmJudgeGraderConfig = Schema.Struct({
  type: Schema.Literal('llm-judge'),
  model: Schema.String,
  reasoningEffort: Schema.optional(ReasoningEffort),
  prompt: Schema.String,
  scoring: LlmJudgeScoring,
  passThreshold: Fraction,
  allowUnknown: Schema.Boolean,
});

export const EvalGraderConfig = Schema.Union([
  ExactMatchGraderConfig,
  ContainsGraderConfig,
  RegexGraderConfig,
  JsonGraderConfig,
  JsonMatchGraderConfig,
  NumericGraderConfig,
  SimilarityGraderConfig,
  ToolCallsGraderConfig,
  LatencyGraderConfig,
  LlmJudgeGraderConfig,
]);

export const EvalGraderType = Schema.Literals([
  'exact-match',
  'contains',
  'regex',
  'json',
  'json-match',
  'numeric',
  'similarity',
  'tool-calls',
  'latency',
  'llm-judge',
]);

export const EvalGrader = Schema.Struct({
  id: EvalGraderId,
  name: Schema.String,
  description: Schema.String,
  config: EvalGraderConfig,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const EvalGraderList = Schema.Array(EvalGrader);

export const EvalGraderInput = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  config: EvalGraderConfig,
});

/** One tool call from a trial's transcript. */
export const EvalToolCall = Schema.Struct({
  toolName: Schema.String,
  toolCallId: Schema.optional(Schema.String),
  input: Schema.optional(Json),
  output: Schema.optional(Json),
  error: Schema.optional(Schema.String),
});

/**
 * What the target produced for one trial. `state` is the target run's
 * terminal state; `agentRunId` opens the full transcript of an agent target
 * and `taskId` the a2a task of a workflow target.
 */
export const EvalTrialOutput = Schema.Struct({
  text: Schema.String,
  structured: Schema.optional(JsonObject),
  state: Schema.String,
  toolCalls: Schema.Array(EvalToolCall),
  durationMs: NonNegativeInt,
  agentRunId: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
});

/**
 * Tokens and USD spent by a set of model calls. `cost` is absent when a call's
 * model has no known rates, since a partial sum would read as the whole bill.
 * `reasoningEstimated` marks thinking tokens the provider did not count on
 * their own (Anthropic folds them into output); they are estimated from how
 * much output the call visibly produced.
 */
export const EvalUsage = Schema.Struct({
  calls: NonNegativeInt,
  tokens: TokenUsage,
  cost: Schema.optional(CostBreakdown),
  reasoningEstimated: Schema.Boolean,
});

/**
 * Where in the agent loop the tokens went. `tool-use` calls chose and called
 * tools, `answer` wrote the final response, and `subagents` are the runs the
 * agent delegated to with `send_task`, however deep.
 */
export const EvalUsagePhase = Schema.Literals(['tool-use', 'answer', 'subagents']);

/** What a target spent on one trial, or a run on all of them, split by loop phase and by model. */
export const EvalTargetUsage = Schema.Struct({
  total: EvalUsage,
  phases: Schema.Array(Schema.Struct({ phase: EvalUsagePhase, usage: EvalUsage })),
  models: Schema.Array(Schema.Struct({ model: Schema.String, usage: EvalUsage })),
});

/**
 * One grader's verdict on one trial. `score` is on 0..1 and absent when the
 * grader could not score: it errored, or the judge answered `UNKNOWN`.
 */
export const EvalGrade = Schema.Struct({
  graderId: EvalGraderId,
  graderName: Schema.String,
  graderType: EvalGraderType,
  passed: Schema.Boolean,
  score: Schema.optional(Fraction),
  label: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  usage: Schema.optional(EvalUsage),
  durationMs: Schema.optional(NonNegativeInt),
});

/** A person's verdict on a trial; the reference automated graders are calibrated against. */
export const EvalReview = Schema.Struct({
  passed: Schema.Boolean,
  note: Schema.String,
  reviewedAt: Schema.Number,
  reviewedBy: Schema.optional(Schema.String),
});

export const EvalReviewInput = Schema.Struct({
  passed: Schema.Boolean,
  note: Schema.String,
});

export const SetEvalReviewInput = Schema.Struct({
  review: Schema.NullOr(EvalReviewInput),
});

/**
 * `errored` is a trial the harness could not complete: the target run failed
 * or the harness broke. It is reported beside agent failures rather than as
 * one, since infrastructure noise is not a verdict on the target.
 */
export const EvalTrialStatus = Schema.Literals(['pending', 'running', 'completed', 'errored', 'canceled']);

/** The case as it was when the run started, so later dataset edits leave past results intact. */
export const EvalCaseSnapshot = Schema.Struct({
  input: Schema.String,
  expected: Schema.optional(Schema.String),
  metadata: Schema.optional(JsonObject),
  tags: Schema.Array(Schema.String),
});

export const EvalTrial = Schema.Struct({
  id: EvalTrialId,
  runId: EvalRunId,
  caseId: EvalCaseId,
  /** Which attempt at the case this is, from 0. */
  index: NonNegativeInt,
  case: EvalCaseSnapshot,
  status: EvalTrialStatus,
  output: Schema.optional(EvalTrialOutput),
  error: Schema.optional(Schema.String),
  grades: Schema.Array(EvalGrade),
  /** Every grader passed. Absent until the trial is graded. */
  passed: Schema.optional(Schema.Boolean),
  /** What the target spent answering, errored trials included; a re-grade spends nothing here. */
  usage: Schema.optional(EvalTargetUsage),
  review: Schema.optional(EvalReview),
  startedAt: Schema.optional(Schema.Number),
  completedAt: Schema.optional(Schema.Number),
});

/**
 * A mean with its standard error and 95% confidence interval. When a case ran
 * several trials, `n` counts cases and the error is taken over per-case means,
 * the clustering the "Adding error bars to evals" paper calls for.
 */
export const EvalMetric = Schema.Struct({
  mean: Schema.Finite,
  standardError: Schema.Finite,
  low: Schema.Finite,
  high: Schema.Finite,
  n: NonNegativeInt,
});

/** How often a grader's verdict matched the human review, over reviewed trials it graded. */
export const EvalAgreement = Schema.Struct({
  agreed: NonNegativeInt,
  total: NonNegativeInt,
});

export const EvalGraderSummary = Schema.Struct({
  graderId: EvalGraderId,
  graderName: Schema.String,
  graderType: EvalGraderType,
  passRate: Schema.optional(EvalMetric),
  meanScore: Schema.optional(EvalMetric),
  /** Grades without a score: grader errors and `UNKNOWN` verdicts. */
  unscored: NonNegativeInt,
  agreement: EvalAgreement,
  usage: Schema.optional(EvalUsage),
});

export const EvalRunSummary = Schema.Struct({
  totalTrials: NonNegativeInt,
  completedTrials: NonNegativeInt,
  erroredTrials: NonNegativeInt,
  pendingTrials: NonNegativeInt,
  canceledTrials: NonNegativeInt,
  /** Share of completed trials on which every grader passed. */
  passRate: Schema.optional(EvalMetric),
  /** Share of cases with at least one passing trial. */
  passAtK: Schema.optional(Fraction),
  /** Share of cases whose every trial passed: the bar for an agent users rely on each time. */
  passAllK: Schema.optional(Fraction),
  graders: Schema.Array(EvalGraderSummary),
  meanDurationMs: Schema.optional(Schema.Finite),
  reviewedTrials: NonNegativeInt,
  /** Tokens and cost spent by the target across every trial. */
  targetUsage: Schema.optional(EvalTargetUsage),
  /** The target's mean cost per trial, over trials whose every call was priced. */
  meanTrialCost: Schema.optional(Schema.Finite),
  /** Tokens and cost spent by model-based graders. */
  judgeUsage: Schema.optional(EvalUsage),
});

export const EvalRunTargetInput = Schema.Struct({
  kind: Schema.Literals(['agent', 'workflow']),
  id: Schema.String,
});

export const EvalRunTarget = Schema.Struct({
  kind: Schema.Literals(['agent', 'workflow']),
  id: Schema.String,
  name: Schema.String,
  /** The agent's model when the run started, so a judge on the same model can be flagged. */
  model: Schema.optional(Schema.String),
  /** The agent's revision when the run started, so runs line up with the config they measured. */
  revision: Schema.optional(NonNegativeInt),
});

/**
 * The agent settings a gate watches. A change to any of them changes what the
 * model is asked or which model answers, so the suite runs again.
 */
export const EvalGateWatchedField = Schema.Literals(['instructions', 'model', 'reasoningEffort', 'skills']);

/** Why a run exists: started by hand, re-grading another run, or a gate reacting to an agent change. */
export const EvalRunTrigger = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('manual') }),
  Schema.Struct({ kind: Schema.Literal('regrade') }),
  Schema.Struct({
    kind: Schema.Literal('gate'),
    gateId: EvalGateId,
    /** The watched fields that changed; empty when the gate was run on demand. */
    changed: Schema.Array(EvalGateWatchedField),
  }),
]);

export const EvalComparisonVerdict = Schema.Literals(['regressed', 'improved', 'unchanged']);

/**
 * A run against its baseline, the previous finished run of the same dataset
 * and target, over the cases both completed. The verdict is `regressed` or
 * `improved` only when the 95% interval of the paired difference excludes
 * zero; case-level regressions are counted either way.
 */
export const EvalBaselineComparison = Schema.Struct({
  runId: EvalRunId,
  name: Schema.String,
  pairedCases: NonNegativeInt,
  baselinePassRate: Schema.Finite,
  candidatePassRate: Schema.Finite,
  difference: Schema.Struct({
    mean: Schema.Finite,
    standardError: Schema.Finite,
    low: Schema.Finite,
    high: Schema.Finite,
  }),
  verdict: EvalComparisonVerdict,
  /** Both runs were graded by the same graders; when not, pass rates can move for that reason alone. */
  sameGraders: Schema.Boolean,
  regressions: NonNegativeInt,
  improvements: NonNegativeInt,
  baselineMeanCost: Schema.optional(Schema.Finite),
  candidateMeanCost: Schema.optional(Schema.Finite),
  baselineMeanDurationMs: Schema.optional(Schema.Finite),
  candidateMeanDurationMs: Schema.optional(Schema.Finite),
});

export const EvalRunStatus = Schema.Literals(['running', 'completed', 'failed', 'canceled']);

export const MAX_EVAL_TRIALS = 20;
export const MAX_EVAL_CONCURRENCY = 16;

/**
 * Starts a run. `caseIds`, `tags` (any of) and `limit` narrow the cases, so a
 * rubric can be tried on a handful of cases before it is spent on all of them.
 */
export const CreateEvalRunInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  datasetId: EvalDatasetId,
  target: EvalRunTargetInput,
  graderIds: Schema.Array(EvalGraderId),
  trials: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_EVAL_TRIALS)),
  concurrency: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_EVAL_CONCURRENCY)),
  caseIds: Schema.optional(Schema.Array(EvalCaseId)),
  tags: Schema.optional(Schema.Array(Schema.String)),
  limit: Schema.optional(PositiveInt),
});

export const EvalRun = Schema.Struct({
  id: EvalRunId,
  name: Schema.String,
  /** Set on a re-grade: the run whose outputs were graded again instead of calling the target. */
  sourceRunId: Schema.optional(EvalRunId),
  dataset: Schema.Struct({ id: EvalDatasetId, name: Schema.String }),
  target: EvalRunTarget,
  /** The graders as they were when the run started. */
  graders: Schema.Array(EvalGrader),
  trials: PositiveInt,
  concurrency: PositiveInt,
  status: EvalRunStatus,
  error: Schema.optional(Schema.String),
  trigger: EvalRunTrigger,
  summary: EvalRunSummary,
  /** How this run compares with the previous finished run of the same dataset and target. */
  baseline: Schema.optional(EvalBaselineComparison),
  createdAt: Schema.Number,
  completedAt: Schema.optional(Schema.Number),
});

export const EvalRunList = Schema.Array(EvalRun);

/**
 * A regression gate: a dataset that reruns against an agent whenever the
 * agent's instructions, model, reasoning effort or skills change, and is
 * compared with its previous run. Each change spends a full run, so gates are
 * opt-in per agent and can be narrowed with tags and a limit.
 */
export const EvalGateInput = Schema.Struct({
  datasetId: EvalDatasetId,
  agentId: Schema.String,
  graderIds: Schema.Array(EvalGraderId),
  tags: Schema.Array(Schema.String),
  trials: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_EVAL_TRIALS)),
  concurrency: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_EVAL_CONCURRENCY)),
  limit: Schema.optional(PositiveInt),
  enabled: Schema.Boolean,
});

export const EvalGate = Schema.Struct({
  id: EvalGateId,
  ...EvalGateInput.fields,
  datasetName: Schema.optional(Schema.String),
  agentName: Schema.optional(Schema.String),
  /** The most recent run the gate started. */
  lastRunId: Schema.optional(EvalRunId),
  /** Why the gate's last attempt to start a run failed, e.g. a missing API key. */
  lastError: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const EvalGateList = Schema.Array(EvalGate);

/**
 * Grades a finished run's outputs again with the given graders, as a new run.
 * The target is not called, so iterating on a rubric only spends judge tokens,
 * and both runs grade the very same outputs for a like-for-like comparison.
 */
export const RegradeEvalRunInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  graderIds: Schema.Array(EvalGraderId),
});

export const EvalRunDetail = Schema.Struct({
  run: EvalRun,
  trials: Schema.Array(EvalTrial),
});

/** An output to grade outside a run, for trying a grader while writing it. */
export const EvalGraderSample = Schema.Struct({
  input: Schema.String,
  expected: Schema.optional(Schema.String),
  metadata: Schema.optional(JsonObject),
  output: Schema.String,
  toolCalls: Schema.optional(Schema.Array(EvalToolCall)),
  durationMs: Schema.optional(NonNegativeInt),
});

export const TestEvalGraderInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  config: EvalGraderConfig,
  sample: EvalGraderSample,
});

export class EvalNotFoundError extends Schema.TaggedError<EvalNotFoundError>()(
  'EvalNotFoundError',
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class EvalValidationError extends Schema.TaggedError<EvalValidationError>()(
  'EvalValidationError',
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class EvalOperationError extends Schema.TaggedError<EvalOperationError>()(
  'EvalOperationError',
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

export type EvalDatasetId = typeof EvalDatasetId.Type;
export type EvalCaseId = typeof EvalCaseId.Type;
export type EvalGraderId = typeof EvalGraderId.Type;
export type EvalRunId = typeof EvalRunId.Type;
export type EvalTrialId = typeof EvalTrialId.Type;
export type EvalCaseInput = typeof EvalCaseInput.Type;
export type EvalCase = typeof EvalCase.Type;
export type EvalDataset = typeof EvalDataset.Type;
export type EvalDatasetInput = typeof EvalDatasetInput.Type;
export type CreateEvalDatasetInput = typeof CreateEvalDatasetInput.Type;
export type EvalDatasetDetail = typeof EvalDatasetDetail.Type;
export type AddEvalCasesInput = typeof AddEvalCasesInput.Type;
export type RemoveEvalCasesInput = typeof RemoveEvalCasesInput.Type;
export type ExactMatchGraderConfig = typeof ExactMatchGraderConfig.Type;
export type ContainsGraderConfig = typeof ContainsGraderConfig.Type;
export type RegexGraderConfig = typeof RegexGraderConfig.Type;
export type JsonGraderConfig = typeof JsonGraderConfig.Type;
export type JsonMatchGraderConfig = typeof JsonMatchGraderConfig.Type;
export type NumericGraderConfig = typeof NumericGraderConfig.Type;
export type SimilarityGraderConfig = typeof SimilarityGraderConfig.Type;
export type ToolCallsGraderConfig = typeof ToolCallsGraderConfig.Type;
export type LatencyGraderConfig = typeof LatencyGraderConfig.Type;
export type EvalJudgeChoice = typeof EvalJudgeChoice.Type;
export type LlmJudgeScoring = typeof LlmJudgeScoring.Type;
export type LlmJudgeGraderConfig = typeof LlmJudgeGraderConfig.Type;
export type EvalGraderConfig = typeof EvalGraderConfig.Type;
export type EvalGraderType = typeof EvalGraderType.Type;
export type EvalGrader = typeof EvalGrader.Type;
export type EvalGraderInput = typeof EvalGraderInput.Type;
export type EvalToolCall = typeof EvalToolCall.Type;
export type EvalTrialOutput = typeof EvalTrialOutput.Type;
export type EvalGrade = typeof EvalGrade.Type;
export type EvalReview = typeof EvalReview.Type;
export type EvalReviewInput = typeof EvalReviewInput.Type;
export type SetEvalReviewInput = typeof SetEvalReviewInput.Type;
export type EvalTrialStatus = typeof EvalTrialStatus.Type;
export type EvalCaseSnapshot = typeof EvalCaseSnapshot.Type;
export type EvalTrial = typeof EvalTrial.Type;
export type EvalMetric = typeof EvalMetric.Type;
export type EvalAgreement = typeof EvalAgreement.Type;
export type EvalGraderSummary = typeof EvalGraderSummary.Type;
export type EvalRunSummary = typeof EvalRunSummary.Type;
export type EvalRunTargetInput = typeof EvalRunTargetInput.Type;
export type EvalRunTarget = typeof EvalRunTarget.Type;
export type EvalRunStatus = typeof EvalRunStatus.Type;
export type CreateEvalRunInput = typeof CreateEvalRunInput.Type;
export type EvalRun = typeof EvalRun.Type;
export type EvalRunDetail = typeof EvalRunDetail.Type;
export type EvalGateId = typeof EvalGateId.Type;
export type EvalUsage = typeof EvalUsage.Type;
export type EvalUsagePhase = typeof EvalUsagePhase.Type;
export type EvalTargetUsage = typeof EvalTargetUsage.Type;
export type EvalGateWatchedField = typeof EvalGateWatchedField.Type;
export type EvalRunTrigger = typeof EvalRunTrigger.Type;
export type EvalComparisonVerdict = typeof EvalComparisonVerdict.Type;
export type EvalBaselineComparison = typeof EvalBaselineComparison.Type;
export type EvalGateInput = typeof EvalGateInput.Type;
export type EvalGate = typeof EvalGate.Type;
export type RegradeEvalRunInput = typeof RegradeEvalRunInput.Type;
export type EvalGraderSample = typeof EvalGraderSample.Type;
export type TestEvalGraderInput = typeof TestEvalGraderInput.Type;
