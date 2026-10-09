import {
  type EvalGraderInput,
  type EvalRunDetail,
  type EvalRunId,
  type EvalRunTarget,
  type EvalTargetUsage,
  EvalValidationError,
  type LlmJudgeGraderConfig,
} from 'agentdock-sdk/schemas';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schedule from 'effect/Schedule';
import { ProviderKeyRegistry } from '../providers/service';
import { TestDatabaseLive } from '../workflows/test-db';
import { EvalJudge } from './judge';
import { EvalService, EvalServiceLive } from './service';
import { EvalStoreLive } from './store';
import { EvalTargetError, type EvalTargetResult, EvalTargets } from './targets';

/** Fakes the eval service tests share: no model is called and nothing is billed. */

export type TargetCall = { readonly input: string; readonly revision: number | undefined };

/** One answer call's spend: 100 input and 10 output tokens for a cent. */
const trialUsage: EvalTargetUsage = (() => {
  const usage = {
    calls: 1,
    tokens: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0, total: 110 },
    cost: { input: 0.004, cacheRead: 0, cacheWrite: 0, output: 0.006, reasoning: 0, total: 0.01 },
    reasoningEstimated: false,
  };
  return { total: usage, phases: [{ phase: 'answer', usage }], models: [{ model: 'openai:echo', usage }] };
})();

/**
 * Answers every case from its input: `fail:` inputs make the harness error
 * after spending one call, `hang:` inputs never answer, and anything else is
 * echoed back uppercased after calling a `lookup` tool. `revision` is read
 * from the target as the run resolved it.
 */
export const fakeTargets = (calls: Array<TargetCall>, revision: () => number = () => 1) =>
  Layer.succeed(
    EvalTargets,
    EvalTargets.of({
      resolve: (target) =>
        target.id === 'missing'
          ? Effect.fail(new EvalValidationError({ message: `The ${target.kind} 'missing' does not exist.` }))
          : Effect.sync(() => ({
              kind: target.kind,
              id: target.id,
              name: 'Echo agent',
              model: 'openai:echo',
              revision: revision(),
            })),
      run: (target: EvalRunTarget, input: string) =>
        Effect.suspend((): Effect.Effect<EvalTargetResult, EvalTargetError> => {
          calls.push({ input, revision: target.revision });
          if (input.startsWith('fail:')) {
            return Effect.fail(new EvalTargetError({ message: 'model unavailable', usage: trialUsage }));
          }
          if (input.startsWith('hang:')) return Effect.never;
          return Effect.succeed({
            output: {
              text: input.toUpperCase(),
              state: 'completed',
              toolCalls: [{ toolName: 'lookup', input: { q: input }, output: 'ok' }],
              durationMs: 5,
            },
            usage: trialUsage,
          });
        }),
    }),
  );

export const fakeJudge = (prompts: Array<string> = []) =>
  Layer.succeed(
    EvalJudge,
    EvalJudge.of({
      judge: (request) =>
        Effect.sync(() => {
          prompts.push(request.prompt);
          return { reasoning: 'Looks right.', verdict: request.prompt.includes('PARIS') ? 'PASS' : 'FAIL' };
        }),
    }),
  );

/** Only the `openai` key is configured, so a judge on any other provider is refused before a run starts. */
export const fakeProviderKeys = Layer.succeed(
  ProviderKeyRegistry,
  ProviderKeyRegistry.of({
    list: () => Effect.succeed([]),
    set: () => Effect.die('unused'),
    remove: () => Effect.succeed(false),
    listCustom: () => Effect.succeed([]),
    getRuntimeConfig: (provider) => Effect.succeed(provider === 'openai' ? { apiKey: 'test' } : {}),
  }),
);

export const storeLayer = EvalStoreLive.pipe(Layer.provideMerge(TestDatabaseLive));

export const serviceLayer = (calls: Array<TargetCall>, prompts: Array<string> = [], revision?: () => number) =>
  EvalServiceLive.pipe(
    Layer.provideMerge(storeLayer),
    Layer.provide(Layer.mergeAll(fakeTargets(calls, revision), fakeJudge(prompts), fakeProviderKeys)),
  );

export const exactMatch: EvalGraderInput = {
  name: 'Exact',
  description: 'Uppercased reference',
  config: { type: 'exact-match', expected: '{{expected}}', caseSensitive: true, normalizeWhitespace: true },
};

export const judgeConfig = (model = 'openai:judge'): LlmJudgeGraderConfig => ({
  type: 'llm-judge',
  model,
  prompt: 'Answer: {{output}}',
  scoring: {
    kind: 'choices',
    choices: [
      { label: 'PASS', score: 1 },
      { label: 'FAIL', score: 0 },
    ],
  },
  passThreshold: 1,
  allowUnknown: true,
});

export const judge = (model?: string): EvalGraderInput => ({
  name: 'Judge',
  description: '',
  config: judgeConfig(model),
});

/** Runs finish in the background; poll until this one has. */
export const awaitRun = (id: EvalRunId) =>
  EvalService.use((evals) => evals.getRun(id)).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(Duration.millis(10)),
      until: (detail: EvalRunDetail) => detail.run.status !== 'running',
    }),
    Effect.timeout(Duration.seconds(5)),
  );
