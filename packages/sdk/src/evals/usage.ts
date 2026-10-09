import type { EvalTargetUsage, EvalUsage, EvalUsagePhase } from '../schemas/evals';
import { addCostBreakdown, addTokenUsage } from '../schemas/usage';

/**
 * Sums two usages. The cost survives only when both sides are priced: one
 * unpriced call makes the total a floor rather than a sum, so it is dropped
 * instead of quietly under-reporting.
 */
const addEvalUsage = (left: EvalUsage, right: EvalUsage): EvalUsage => {
  const sum: EvalUsage = {
    calls: left.calls + right.calls,
    tokens: addTokenUsage(left.tokens, right.tokens),
    reasoningEstimated: left.reasoningEstimated || right.reasoningEstimated,
  };
  return left.cost === undefined || right.cost === undefined
    ? sum
    : { ...sum, cost: addCostBreakdown(left.cost, right.cost) };
};

export const sumEvalUsage = (usages: ReadonlyArray<EvalUsage>): EvalUsage | undefined => {
  const [first, ...rest] = usages;
  return first === undefined ? undefined : rest.reduce(addEvalUsage, first);
};

/** One priced model call and where in the agent loop it happened. */
export type EvalModelCall = {
  readonly phase: EvalUsagePhase;
  readonly model: string;
  readonly usage: EvalUsage;
};

const PHASES: ReadonlyArray<EvalUsagePhase> = ['tool-use', 'answer', 'subagents'];

const groupUsage = <K extends string>(
  entries: ReadonlyArray<{ readonly key: K; readonly usage: EvalUsage }>,
  order: ReadonlyArray<K>,
): ReadonlyArray<{ readonly key: K; readonly usage: EvalUsage }> =>
  order.flatMap((key) => {
    const usage = sumEvalUsage(entries.filter((entry) => entry.key === key).map((entry) => entry.usage));
    return usage === undefined ? [] : [{ key, usage }];
  });

const fromEntries = (
  phases: ReadonlyArray<{ readonly key: EvalUsagePhase; readonly usage: EvalUsage }>,
  models: ReadonlyArray<{ readonly key: string; readonly usage: EvalUsage }>,
): EvalTargetUsage | undefined => {
  const byPhase = groupUsage(phases, PHASES);
  const total = sumEvalUsage(byPhase.map((entry) => entry.usage));
  if (total === undefined) return undefined;
  const modelOrder = [...new Set(models.map((entry) => entry.key))];
  return {
    total,
    phases: byPhase.map(({ key, usage }) => ({ phase: key, usage })),
    models: groupUsage(models, modelOrder).map(({ key, usage }) => ({ model: key, usage })),
  };
};

/** A trial's calls rolled up by loop phase and by model. */
export const targetUsageFromCalls = (calls: ReadonlyArray<EvalModelCall>): EvalTargetUsage | undefined =>
  fromEntries(
    calls.map((call) => ({ key: call.phase, usage: call.usage })),
    calls.map((call) => ({ key: call.model, usage: call.usage })),
  );

/** Several trials' usage rolled into one, keeping the phase and model splits. */
export const sumTargetUsage = (usages: ReadonlyArray<EvalTargetUsage>): EvalTargetUsage | undefined =>
  fromEntries(
    usages.flatMap((usage) => usage.phases.map((entry) => ({ key: entry.phase, usage: entry.usage }))),
    usages.flatMap((usage) => usage.models.map((entry) => ({ key: entry.model, usage: entry.usage }))),
  );
