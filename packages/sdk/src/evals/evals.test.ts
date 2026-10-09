import { describe, expect, it } from 'vitest';
import {
  EvalCaseId,
  type EvalGrade,
  type EvalGrader,
  EvalGraderId,
  EvalRunId,
  type EvalTrial,
  EvalTrialId,
  type EvalUsage,
} from '../schemas/evals';
import { evalCasesFromTable, evalCasesToJsonl, guessEvalFieldMapping, parseEvalDatasetFile } from './dataset-file';
import { baselineComparison, clusteredMetric, compareEvalRuns, metricFromValues, summarizeEvalRun } from './summary';
import { renderEvalTemplate, renderEvalTranscript, unknownEvalTemplateVariables } from './template';
import { targetUsageFromCalls } from './usage';

describe('renderEvalTemplate', () => {
  const context = {
    input: 'What is 2+2?',
    output: '4',
    expected: 'four',
    metadata: { city: 'Berlin', nested: { level: 2 }, list: [1, 2] },
  };

  it('fills case, output and metadata variables, including the autoevals triple-brace form', () => {
    expect(renderEvalTemplate('Q: {{input}} A: {{ output }} E: {{{expected}}}', context)).toBe(
      'Q: What is 2+2? A: 4 E: four',
    );
    expect(renderEvalTemplate('{{metadata.city}} {{metadata.nested.level}} {{metadata.list}}', context)).toBe(
      'Berlin 2 [1,2]',
    );
  });

  it('renders unknown and absent variables empty and reports unknown roots', () => {
    expect(renderEvalTemplate('[{{criteria}}][{{metadata.missing}}][{{transcript}}]', context)).toBe('[][][]');
    expect(unknownEvalTemplateVariables('{{input}} {{criteria}} {{metadata.x}} {{critera.y}}')).toEqual([
      'criteria',
      'critera.y',
    ]);
  });

  it('renders a transcript with clipped tool results', () => {
    const transcript = renderEvalTranscript([
      { toolName: 'search', input: { q: 'x' }, output: 'y'.repeat(2_100) },
      { toolName: 'fetch', input: {}, error: 'timeout' },
    ]);
    expect(transcript).toContain('1. search({"q":"x"})');
    expect(transcript).toContain('(100 more characters)');
    expect(transcript).toContain('2. fetch({})\n   → error: timeout');
    expect(renderEvalTranscript([])).toBe('(no tool calls)');
  });
});

describe('dataset files', () => {
  it('parses quoted CSV fields holding separators, quotes and line breaks', () => {
    const table = parseEvalDatasetFile('question,answer,tags\n"Hi, there","say ""hello""\nback",a;b\n\n', 'csv');
    expect(table.columns).toEqual(['question', 'answer', 'tags']);
    expect(table.rows).toEqual([{ question: 'Hi, there', answer: 'say "hello"\nback', tags: 'a;b' }]);
    const mapping = guessEvalFieldMapping(table.columns);
    expect(mapping).toEqual({ input: 'question', expected: 'answer', tags: 'tags' });
    expect(evalCasesFromTable(table, mapping)).toEqual([
      { input: 'Hi, there', expected: 'say "hello"\nback', tags: ['a', 'b'] },
    ]);
  });

  it('keeps unmapped columns as metadata and skips rows without input', () => {
    const table = parseEvalDatasetFile(
      '{"prompt":"a","ideal":"b","difficulty":3,"metadata":{"source":"ticket"}}\n{"prompt":""}\n',
      'jsonl',
    );
    expect(evalCasesFromTable(table, guessEvalFieldMapping(table.columns))).toEqual([
      { input: 'a', expected: 'b', tags: [], metadata: { difficulty: 3, source: 'ticket' } },
    ]);
  });

  it('round-trips its own JSONL export', () => {
    const cases = [
      { input: 'q1', expected: 'a1', tags: ['regression'], metadata: { k: 'v' } },
      { input: 'q2', tags: [] },
    ];
    const table = parseEvalDatasetFile(evalCasesToJsonl(cases), 'jsonl');
    expect(evalCasesFromTable(table, guessEvalFieldMapping(table.columns))).toEqual(cases);
  });

  it('accepts a JSON array or a `cases` object and rejects anything else', () => {
    expect(parseEvalDatasetFile('[{"input":"x"}]', 'json').rows).toEqual([{ input: 'x' }]);
    expect(parseEvalDatasetFile('{"cases":[{"input":"y"}]}', 'json').rows).toEqual([{ input: 'y' }]);
    expect(() => parseEvalDatasetFile('{"input":"x"}', 'json')).toThrow('Expected a JSON array');
    expect(() => parseEvalDatasetFile('{"input":"x"}\nnot json', 'jsonl')).toThrow('Line 2 is not valid JSON.');
  });
});

const graderId = EvalGraderId.make('grd_1');
const grader: EvalGrader = {
  id: graderId,
  name: 'Exact',
  description: '',
  config: { type: 'exact-match', expected: '{{expected}}', caseSensitive: false, normalizeWhitespace: true },
  createdAt: 0,
  updatedAt: 0,
};

/** A priced call whose whole cost is billed as input and output in proportion. */
const usage = (input: number, output: number, cost: number): EvalUsage => ({
  calls: 1,
  tokens: { input, cacheRead: 0, cacheWrite: 0, output, reasoning: 0, total: input + output },
  cost: { input: cost / 2, cacheRead: 0, cacheWrite: 0, output: cost / 2, reasoning: 0, total: cost },
  reasoningEstimated: false,
});

const grade = (passed: boolean, overrides: Partial<EvalGrade> = {}): EvalGrade => ({
  graderId,
  graderName: 'Exact',
  graderType: 'exact-match',
  passed,
  score: passed ? 1 : 0,
  ...overrides,
});

let trialCounter = 0;
const trial = (caseId: string, passed: boolean | undefined, overrides: Partial<EvalTrial> = {}): EvalTrial => {
  trialCounter += 1;
  const base: EvalTrial = {
    id: EvalTrialId.make(`trl_${trialCounter}`),
    runId: EvalRunId.make('run_1'),
    caseId: EvalCaseId.make(caseId),
    index: 0,
    case: { input: `input ${caseId}`, tags: [] },
    status: 'completed',
    output: { text: '', state: 'completed', toolCalls: [], durationMs: 100 },
    grades: passed === undefined ? [] : [grade(passed)],
  };
  return { ...base, ...(passed === undefined ? undefined : { passed }), ...overrides };
};

describe('eval statistics', () => {
  it('computes a mean with its standard error and a clamped 95% interval', () => {
    const metric = metricFromValues([0.6, 0.4, 0.5, 0.5]);
    expect(metric.mean).toBeCloseTo(0.5);
    expect(metric.standardError).toBeCloseTo(Math.sqrt(0.02 / 3 / 4));
    expect(metric.low).toBeCloseTo(0.5 - 1.959964 * metric.standardError);
    expect(metricFromValues([1, 1, 0, 0]).low).toBe(0);
    expect(metricFromValues([1])).toEqual({ mean: 1, standardError: 0, low: 1, high: 1, n: 1 });
  });

  it('clusters trials by case before taking the error', () => {
    const metric = clusteredMetric([
      { caseId: 'a', value: 1 },
      { caseId: 'a', value: 1 },
      { caseId: 'a', value: 0 },
      { caseId: 'b', value: 0 },
    ]);
    expect(metric?.n).toBe(2);
    expect(metric?.mean).toBeCloseTo((2 / 3 + 0) / 2);
  });

  it('summarizes pass rates, pass@k, pass^k, judge agreement and trial states', () => {
    const summary = summarizeEvalRun(
      [grader],
      [
        trial('a', true, { review: { passed: true, note: '', reviewedAt: 1 } }),
        trial('a', false, { index: 1, review: { passed: true, note: '', reviewedAt: 1 } }),
        trial('b', true),
        trial('b', true, { index: 1 }),
        trial('c', undefined, { status: 'errored', output: undefined, error: 'model down' }),
        trial('d', undefined, { status: 'pending', output: undefined }),
      ],
    );
    expect(summary).toMatchObject({
      totalTrials: 6,
      completedTrials: 4,
      erroredTrials: 1,
      pendingTrials: 1,
      canceledTrials: 0,
      passAtK: 1,
      passAllK: 0.5,
      reviewedTrials: 2,
      meanDurationMs: 100,
    });
    expect(summary.passRate?.mean).toBeCloseTo(0.75);
    expect(summary.passRate?.n).toBe(2);
    expect(summary.graders[0]?.agreement).toEqual({ agreed: 1, total: 2 });
  });

  it('counts unscored grades apart from failures and sums judge usage', () => {
    const summary = summarizeEvalRun(
      [grader],
      [
        trial('a', false, {
          grades: [grade(false, { score: undefined, label: 'UNKNOWN', usage: usage(10, 5, 0.5) })],
        }),
        trial('b', true, { grades: [grade(true, { usage: usage(10, 5, 0.25) })] }),
      ],
    );
    expect(summary.graders[0]?.unscored).toBe(1);
    expect(summary.graders[0]?.passRate?.n).toBe(1);
    expect(summary.judgeUsage?.calls).toBe(2);
    expect(summary.judgeUsage?.tokens).toMatchObject({ input: 20, output: 10, total: 30 });
    expect(summary.judgeUsage?.cost?.total).toBeCloseTo(0.75);
  });

  it('rolls target usage up by loop phase and model, and averages the cost per trial', () => {
    const first = targetUsageFromCalls([
      { phase: 'tool-use', model: 'openai:a', usage: usage(100, 20, 0.1) },
      { phase: 'answer', model: 'openai:a', usage: usage(150, 40, 0.2) },
      { phase: 'subagents', model: 'anthropic:b', usage: { ...usage(50, 30, 0.3), reasoningEstimated: true } },
    ]);
    const second = targetUsageFromCalls([{ phase: 'answer', model: 'openai:a', usage: usage(80, 10, 0.1) }]);
    expect(first?.total).toMatchObject({ calls: 3, reasoningEstimated: true });
    expect(first?.phases.map((entry) => [entry.phase, entry.usage.calls])).toEqual([
      ['tool-use', 1],
      ['answer', 1],
      ['subagents', 1],
    ]);
    const summary = summarizeEvalRun(
      [grader],
      [trial('a', true, first ? { usage: first } : {}), trial('b', true, second ? { usage: second } : {})],
    );
    expect(summary.targetUsage?.total.calls).toBe(4);
    expect(summary.targetUsage?.phases.find((entry) => entry.phase === 'answer')?.usage.tokens.input).toBe(230);
    expect(summary.targetUsage?.models.map((entry) => [entry.model, entry.usage.calls])).toEqual([
      ['openai:a', 3],
      ['anthropic:b', 1],
    ]);
    expect(summary.meanTrialCost).toBeCloseTo(0.35);
  });

  it('drops the cost of a total that includes an unpriced call', () => {
    const { cost: _cost, ...unpriced } = usage(10, 5, 0);
    const total = targetUsageFromCalls([
      { phase: 'tool-use', model: 'custom:x', usage: unpriced },
      { phase: 'answer', model: 'openai:a', usage: usage(10, 5, 0.1) },
    ]);
    expect(total?.total.cost).toBeUndefined();
    expect(total?.phases.find((entry) => entry.phase === 'answer')?.usage.cost?.total).toBeCloseTo(0.1);
  });

  it('calls a change only when the interval of the paired difference excludes zero', () => {
    const baselineRun = (trials: ReadonlyArray<EvalTrial>) => ({
      id: EvalRunId.make('run_base'),
      name: 'Base',
      graderIds: ['grd_1'],
      trials,
    });
    const cases = ['a', 'b', 'c', 'd', 'e'];
    const regressed = baselineComparison(baselineRun(cases.map((id) => trial(id, true))), {
      graderIds: ['grd_1'],
      trials: cases.map((id) => trial(id, false)),
    });
    expect(regressed).toMatchObject({ verdict: 'regressed', regressions: 5, sameGraders: true, pairedCases: 5 });
    const noisy = baselineComparison(baselineRun(cases.map((id) => trial(id, true))), {
      graderIds: ['grd_2'],
      trials: cases.map((id, index) => trial(id, index !== 0)),
    });
    expect(noisy).toMatchObject({ verdict: 'unchanged', regressions: 1, sameGraders: false });
  });

  it('compares runs pairwise over their shared cases', () => {
    const baseline = [trial('a', true), trial('b', false), trial('c', true), trial('x', true)];
    const candidate = [trial('a', true), trial('b', true), trial('c', false), trial('d', true)];
    const comparison = compareEvalRuns(baseline, candidate);
    expect(comparison.pairedCases).toBe(3);
    expect(comparison.difference.mean).toBeCloseTo(0);
    expect(comparison.regressions.map((entry) => entry.caseId)).toEqual(['c']);
    expect(comparison.improvements.map((entry) => entry.caseId)).toEqual(['b']);
    expect(comparison.baselinePassRate).toBeCloseTo(2 / 3);
  });
});
