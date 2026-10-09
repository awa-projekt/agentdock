import { describe, expect, it } from '@effect/vitest';
import {
  type EvalCaseSnapshot,
  type EvalGrader,
  type EvalGraderConfig,
  EvalGraderId,
  type EvalToolCall,
  type EvalTrialOutput,
  type LlmJudgeGraderConfig,
} from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { gradeTrial, judgeSystemPrompt, similarity, trialPassed } from './graders';
import { EvalJudge, EvalJudgeError, type EvalJudgeRequest } from './judge';

const grader = (config: EvalGraderConfig): EvalGrader => ({
  id: EvalGraderId.make('grd_test'),
  name: 'Test',
  description: '',
  config,
  createdAt: 0,
  updatedAt: 0,
});

const output = (text: string, overrides: Partial<EvalTrialOutput> = {}): EvalTrialOutput => ({
  text,
  state: 'completed',
  toolCalls: [],
  durationMs: 1_200,
  ...overrides,
});

const evalCase = (overrides: Partial<EvalCaseSnapshot> = {}): EvalCaseSnapshot => ({
  input: 'What is the capital of France?',
  expected: 'Paris',
  tags: [],
  ...overrides,
});

/** A judge that answers from a script and records what it was asked. */
const scriptedJudge = (answer: (request: EvalJudgeRequest) => string, requests: Array<EvalJudgeRequest> = []) =>
  Layer.succeed(
    EvalJudge,
    EvalJudge.of({
      judge: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return {
            reasoning: 'Because.',
            verdict: answer(request),
            usage: {
              calls: 1,
              tokens: { input: 100, cacheRead: 0, cacheWrite: 0, output: 20, reasoning: 0, total: 120 },
              cost: { input: 0.0004, cacheRead: 0, cacheWrite: 0, output: 0.0006, reasoning: 0, total: 0.001 },
              reasoningEstimated: false,
            },
          };
        }),
    }),
  );

const unusedJudge = Layer.succeed(
  EvalJudge,
  EvalJudge.of({
    judge: () => Effect.fail(new EvalJudgeError({ message: 'no judge in this test', cause: undefined })),
  }),
);

const grade = (config: EvalGraderConfig, trialOutput: EvalTrialOutput, snapshot = evalCase()) =>
  gradeTrial(grader(config), { case: snapshot, output: trialOutput }).pipe(Effect.provide(unusedJudge));

describe('code graders', () => {
  it.effect('exact match normalizes case and whitespace, and refuses an empty reference', () =>
    Effect.gen(function* () {
      const config: EvalGraderConfig = {
        type: 'exact-match',
        expected: '{{expected}}',
        caseSensitive: false,
        normalizeWhitespace: true,
      };
      expect((yield* grade(config, output('  paris \n'))).passed).toBe(true);
      expect((yield* grade({ ...config, caseSensitive: true }, output('paris'))).passed).toBe(false);
      const missing = yield* grade(config, output(''), evalCase({ expected: undefined }));
      expect(missing.passed).toBe(false);
      expect(missing.score).toBeUndefined();
      expect(missing.error).toContain('renders empty');
    }),
  );

  it.effect('contains checks all, any and none, with partial credit for all', () =>
    Effect.gen(function* () {
      const values = ['Paris', 'France', 'Berlin'];
      const all = yield* grade(
        { type: 'contains', values, mode: 'all', caseSensitive: false },
        output('paris, france'),
      );
      expect(all).toMatchObject({ passed: false, score: 2 / 3 });
      expect(all.reasoning).toContain('"Berlin"');
      const any = yield* grade({ type: 'contains', values, mode: 'any', caseSensitive: false }, output('Berlin!'));
      expect(any.passed).toBe(true);
      const none = yield* grade({ type: 'contains', values, mode: 'none', caseSensitive: true }, output('paris'));
      expect(none.passed).toBe(true);
    }),
  );

  it.effect('regex matches, negates, and reports a broken pattern as a grader error', () =>
    Effect.gen(function* () {
      const matched = yield* grade(
        { type: 'regex', pattern: '\\bparis\\b', flags: 'i', negate: false },
        output('Paris.'),
      );
      expect(matched.passed).toBe(true);
      const negated = yield* grade({ type: 'regex', pattern: 'sorry', flags: 'i', negate: true }, output('Paris.'));
      expect(negated.passed).toBe(true);
      const broken = yield* grade({ type: 'regex', pattern: '(', flags: '', negate: false }, output('x'));
      expect(broken.error).toContain('Invalid regular expression');
    }),
  );

  it.effect('json parses fenced output and validates it against a schema', () =>
    Effect.gen(function* () {
      const schema = {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      };
      const fenced = '```json\n{"city": "Paris"}\n```';
      expect((yield* grade({ type: 'json', schema }, output(fenced))).passed).toBe(true);
      const invalid = yield* grade({ type: 'json', schema }, output('{"town": "Paris"}'));
      expect(invalid.passed).toBe(false);
      expect(invalid.reasoning).toContain('does not match the schema');
      expect((yield* grade({ type: 'json' }, output('Paris'))).passed).toBe(false);
    }),
  );

  it.effect('json match gives partial credit per field and flags extra fields in exact mode', () =>
    Effect.gen(function* () {
      const snapshot = evalCase({ expected: '{"city":"Paris","country":{"name":"France","code":"FR"}}' });
      const subset = yield* grade(
        { type: 'json-match', expected: '{{expected}}', mode: 'subset' },
        output('{"city":"Paris","country":{"name":"France","code":"F"},"extra":1}'),
        snapshot,
      );
      expect(subset).toMatchObject({ passed: false, score: 2 / 3 });
      expect(subset.reasoning).toContain('country.code');
      const exact = yield* grade(
        { type: 'json-match', expected: '{{expected}}', mode: 'exact' },
        output('{"city":"Paris","country":{"name":"France","code":"FR"},"extra":1}'),
        snapshot,
      );
      expect(exact).toMatchObject({ passed: false, score: 3 / 4 });
      expect(exact.reasoning).toContain('Unexpected: extra');
    }),
  );

  it.effect('numeric reads the first number, with thousands separators and relative tolerance', () =>
    Effect.gen(function* () {
      const config: EvalGraderConfig = { type: 'numeric', expected: '{{expected}}', tolerance: 0.01, relative: true };
      const snapshot = evalCase({ expected: '12500' });
      expect((yield* grade(config, output('About 12,540 people.'), snapshot)).passed).toBe(true);
      expect((yield* grade(config, output('About 13,000 people.'), snapshot)).passed).toBe(false);
      expect((yield* grade(config, output('Many people.'), snapshot)).reasoning).toBe('The output contains no number.');
    }),
  );

  it.effect('similarity scores by normalized edit distance', () =>
    Effect.gen(function* () {
      expect(similarity('kitten', 'sitting')).toBeCloseTo(1 - 3 / 7);
      const result = yield* grade(
        { type: 'similarity', expected: '{{expected}}', threshold: 0.8, caseSensitive: false },
        output('paris'),
      );
      expect(result).toMatchObject({ passed: true, score: 1 });
    }),
  );

  it.effect('tool calls check required, forbidden, order, wildcards and the call budget', () =>
    Effect.gen(function* () {
      const calls: ReadonlyArray<EvalToolCall> = [
        { toolName: 'crm.lookup', input: {} },
        { toolName: 'orders.refund', input: {} },
        { toolName: 'email.send', input: {} },
      ];
      const passing = yield* grade(
        { type: 'tool-calls', required: ['crm.*', 'orders.refund'], forbidden: ['orders.delete'], ordered: true },
        output('done', { toolCalls: calls }),
      );
      expect(passing).toMatchObject({ passed: true, score: 1 });
      const failing = yield* grade(
        {
          type: 'tool-calls',
          required: ['orders.refund', 'crm.lookup', '{{metadata.tool}}'],
          forbidden: ['email.*'],
          ordered: true,
          maxCalls: 2,
        },
        output('done', { toolCalls: calls }),
        evalCase({ metadata: { tool: 'kb.search' } }),
      );
      expect(failing.passed).toBe(false);
      expect(failing.reasoning).toContain('Not called: kb.search.');
      expect(failing.reasoning).toContain('Called forbidden: email.*.');
      expect(failing.reasoning).toContain('over the budget of 2');
    }),
  );

  it.effect('latency compares the trial duration to the limit', () =>
    Effect.gen(function* () {
      expect((yield* grade({ type: 'latency', maxDurationMs: 1_000 }, output('x'))).passed).toBe(false);
      expect((yield* grade({ type: 'latency', maxDurationMs: 2_000 }, output('x'))).passed).toBe(true);
    }),
  );

  it('passes a trial only when every grade passed', () => {
    const base = { graderId: EvalGraderId.make('g'), graderName: 'g', graderType: 'latency' as const };
    expect(trialPassed([])).toBeUndefined();
    expect(
      trialPassed([
        { ...base, passed: true },
        { ...base, passed: false },
      ]),
    ).toBe(false);
    expect(trialPassed([{ ...base, passed: true }])).toBe(true);
  });
});

describe('LLM judge graders', () => {
  const judgeConfig = (overrides: Partial<LlmJudgeGraderConfig> = {}): LlmJudgeGraderConfig => ({
    type: 'llm-judge',
    model: 'openai:judge',
    prompt: 'Task: {{input}}\nAnswer: {{output}}\nReference: {{expected}}\nTools:\n{{transcript}}',
    scoring: {
      kind: 'choices',
      choices: [
        { label: 'CORRECT', score: 1, description: 'Matches the reference.' },
        { label: 'PARTIAL', score: 0.5 },
        { label: 'WRONG', score: 0 },
      ],
    },
    passThreshold: 1,
    allowUnknown: true,
    ...overrides,
  });

  it.effect('renders the rubric, offers the verdicts, and maps the verdict onto its score', () => {
    const requests: Array<EvalJudgeRequest> = [];
    return Effect.gen(function* () {
      const result = yield* gradeTrial(grader(judgeConfig()), {
        case: evalCase(),
        output: output('Paris', { toolCalls: [{ toolName: 'search', input: { q: 'capital' }, output: 'Paris' }] }),
      });
      expect(result).toMatchObject({ passed: false, score: 0.5, label: 'PARTIAL', reasoning: 'Because.' });
      expect(result.usage?.cost?.total).toBe(0.001);
      const [request] = requests;
      expect(request?.verdicts).toEqual(['CORRECT', 'PARTIAL', 'WRONG', 'UNKNOWN']);
      expect(request?.prompt).toContain('Answer: Paris\nReference: Paris');
      expect(request?.prompt).toContain('1. search({"q":"capital"})');
      expect(request?.system).toContain('- CORRECT: Matches the reference.');
      expect(request?.system).toContain('- UNKNOWN: The instructions cannot be applied');
    }).pipe(Effect.provide(scriptedJudge(() => 'PARTIAL', requests)));
  });

  it.effect('normalizes a scale verdict onto 0..1', () =>
    Effect.gen(function* () {
      const result = yield* gradeTrial(
        grader(judgeConfig({ scoring: { kind: 'scale', min: 1, max: 5 }, passThreshold: 0.75, allowUnknown: false })),
        { case: evalCase(), output: output('Paris') },
      );
      expect(result).toMatchObject({ passed: true, score: 0.75, label: '4' });
    }).pipe(Effect.provide(scriptedJudge((request) => request.verdicts[3] ?? ''))),
  );

  it.effect('leaves an UNKNOWN verdict unscored and failing, for a person to review', () =>
    Effect.gen(function* () {
      const result = yield* gradeTrial(grader(judgeConfig()), { case: evalCase(), output: output('Paris') });
      expect(result).toMatchObject({ passed: false, label: 'UNKNOWN' });
      expect(result.score).toBeUndefined();
    }).pipe(Effect.provide(scriptedJudge(() => 'UNKNOWN'))),
  );

  it.effect('turns a failed judge call into an unscored grade with the error', () =>
    Effect.gen(function* () {
      const result = yield* gradeTrial(grader(judgeConfig()), { case: evalCase(), output: output('Paris') });
      expect(result).toMatchObject({ passed: false, error: 'no judge in this test' });
    }).pipe(Effect.provide(unusedJudge)),
  );

  it('lists scale points in the system prompt', () => {
    const prompt = judgeSystemPrompt(judgeConfig({ scoring: { kind: 'scale', min: 1, max: 3 }, allowUnknown: false }));
    expect(prompt).toContain('- 1: the lowest rating\n- 2\n- 3: the highest rating');
    expect(prompt).not.toContain('UNKNOWN');
  });
});
