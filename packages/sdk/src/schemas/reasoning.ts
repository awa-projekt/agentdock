import * as Schema from 'effect/Schema';

/**
 * How hard a model should think before answering, in provider-neutral tiers.
 * The tiers a model accepts come from models.dev (`reasoning_options` of type
 * `effort`); each provider maps a tier onto its own knob in
 * packages/sdk/src/agents/providers.ts.
 */
export const ReasoningEffort = Schema.Literals(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ReasoningEffort = typeof ReasoningEffort.Type;

export const REASONING_EFFORT_LABELS = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
} satisfies Record<ReasoningEffort, string>;
