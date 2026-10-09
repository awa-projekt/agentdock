import { createChatModel, parseModelString, tokenUsageFromUsageMetadata, withReasoningEstimate } from 'agentdock-sdk';
import { coerceJson, type EvalUsage, type JsonObject, type ReasoningEffort, renderJson } from 'agentdock-sdk/schemas';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import { ModelCatalog } from '../models/catalog';
import { ProviderKeyRegistry } from '../providers/service';
import { priceModelCall } from './usage';

/** One judge call: a system prompt, the rendered rubric, and the verdicts the judge may answer. */
export type EvalJudgeRequest = {
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffort | undefined;
  readonly system: string;
  readonly prompt: string;
  readonly verdicts: ReadonlyArray<string>;
};

export type EvalJudgeVerdict = {
  readonly reasoning: string;
  readonly verdict: string;
  readonly usage?: EvalUsage | undefined;
};

export class EvalJudgeError extends Schema.TaggedError<EvalJudgeError>()('EvalJudgeError', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/**
 * The model call behind LLM-judge graders, a service of its own so tests can
 * script verdicts instead of spending tokens.
 */
export const EvalJudge = Context.Service<{
  readonly judge: (request: EvalJudgeRequest) => Effect.Effect<EvalJudgeVerdict, EvalJudgeError>;
}>('@agentdock/api/EvalJudge');

const JUDGE_TIMEOUT = Duration.minutes(2);
const JUDGE_RETRIES = 2;

const JudgeOutput = Schema.Struct({ reasoning: Schema.String, verdict: Schema.String });
const decodeJudgeOutput = Schema.decodeUnknownOption(JudgeOutput);

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * Reasoning comes first in the schema so the model writes it before it
 * commits to a verdict, and the verdict is an enum so it cannot answer
 * outside the scale.
 */
const verdictJsonSchema = (verdicts: ReadonlyArray<string>): JsonObject => ({
  type: 'object',
  properties: {
    reasoning: {
      type: 'string',
      description: 'Your reasoning, written before you decide. Cite the evidence for each criterion.',
    },
    verdict: { type: 'string', enum: [...verdicts], description: 'Your verdict: exactly one of the allowed values.' },
  },
  required: ['reasoning', 'verdict'],
  additionalProperties: false,
});

export const EvalJudgeLive = Layer.effect(
  EvalJudge,
  Effect.gen(function* () {
    const providerKeys = yield* ProviderKeyRegistry;
    const catalog = yield* ModelCatalog;

    return EvalJudge.of({
      judge: Effect.fn('EvalJudge.judge')(function* (request) {
        yield* Effect.annotateCurrentSpan({ 'eval.judge.model': request.model });
        const reference = yield* Effect.try({
          try: () => parseModelString(request.model),
          catch: (cause) => new EvalJudgeError({ message: errorMessage(cause), cause }),
        });
        const config = yield* providerKeys
          .getRuntimeConfig(reference.provider)
          .pipe(Effect.mapError((cause) => new EvalJudgeError({ message: errorMessage(cause.cause), cause })));
        const chatModel = yield* Effect.try({
          try: () => createChatModel(reference.provider, reference.modelId, config, request.reasoningEffort),
          catch: (cause) => new EvalJudgeError({ message: errorMessage(cause), cause }),
        });
        const structured = chatModel.withStructuredOutput(verdictJsonSchema(request.verdicts), {
          name: 'submit_verdict',
          includeRaw: true,
        });
        const result = yield* Effect.tryPromise({
          try: (signal) =>
            structured.invoke(
              [
                { role: 'system', content: request.system },
                { role: 'user', content: request.prompt },
              ],
              { signal },
            ),
          catch: (cause) => new EvalJudgeError({ message: `Judge call failed: ${errorMessage(cause)}`, cause }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: JUDGE_TIMEOUT,
            orElse: () => Effect.fail(new EvalJudgeError({ message: 'Judge call timed out.', cause: undefined })),
          }),
          Effect.retry({ times: JUDGE_RETRIES, schedule: Schedule.exponential('1 second') }),
        );

        const raw = result.raw;
        const tokens = tokenUsageFromUsageMetadata(
          coerceJson('usage_metadata' in raw ? raw.usage_metadata : undefined),
        );
        const reasoned = raw.contentBlocks.some((block) => block.type === 'reasoning');
        const counted =
          tokens === undefined
            ? undefined
            : withReasoningEstimate(tokens, renderJson(coerceJson(result.parsed)).length, reasoned);
        const usage =
          counted === undefined
            ? undefined
            : yield* priceModelCall(catalog, request.model, counted.tokens, counted.estimated);
        const parsed = decodeJudgeOutput(coerceJson(result.parsed));
        if (Option.isNone(parsed)) {
          return yield* new EvalJudgeError({ message: 'The judge returned no verdict.', cause: undefined });
        }
        if (!request.verdicts.includes(parsed.value.verdict)) {
          return yield* new EvalJudgeError({
            message: `The judge answered '${parsed.value.verdict}', which is not one of ${request.verdicts.join(', ')}.`,
            cause: undefined,
          });
        }
        return usage === undefined ? parsed.value : { ...parsed.value, usage };
      }),
    });
  }),
);
