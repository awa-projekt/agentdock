import { EVAL_GRADER_PRESETS, type EvalGraderPreset, unknownEvalTemplateVariables } from 'agentdock-sdk/evals';
import {
  decodeJsonObjectStringOption,
  decodeJsonStringOption,
  type EvalGrade,
  type EvalGrader,
  type EvalGraderConfig,
  type EvalGraderInput,
  type EvalGraderType,
  type EvalToolCall,
  isJsonArray,
  isJsonObject,
  jsonProperty,
  jsonString,
  type LlmJudgeGraderConfig,
  REASONING_EFFORT_LABELS,
  type ReasoningEffort,
} from 'agentdock-sdk/schemas';
import * as Option from 'effect/Option';
import { FlaskConical, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useLocation } from 'wouter';
import { ConfirmButton } from '@/components/ConfirmButton';
import { Field, Toggle } from '@/components/form';
import { JsonTextarea } from '@/components/json-textarea';
import { ModelPicker } from '@/components/model-picker';
import { StatusMessage } from '@/components/StatusMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toErrorMessage } from '@/lib/format';
import { useCreateEvalGrader, useRemoveEvalGrader, useTestEvalGrader, useUpdateEvalGrader } from '@/lib/queries';
import { providersPath } from '@/lib/routing';
import { GRADER_TYPE_LABELS } from '@/views/evals/eval-format';
import { GradeCard } from '@/views/evals/GradeCard';

const GRADER_TYPES: ReadonlyArray<EvalGraderType> = [
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
];

/** The default config for a type: the first preset of that type. */
const configForType = (type: EvalGraderType): EvalGraderConfig | undefined =>
  EVAL_GRADER_PRESETS.find((preset) => preset.grader.config.type === type)?.grader.config;

const CATEGORY_LABELS = {
  code: 'Code checks: fast, free, reproducible',
  transcript: 'Transcript checks',
  judge: 'LLM judges: for what code cannot check',
} satisfies Record<EvalGraderPreset['category'], string>;

const lines = (text: string): ReadonlyArray<string> =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const numberOr = (value: string, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Creates or edits a grader, then tries it on a hand-written sample. Test
 * grading an LLM judge makes one model call; everything else runs for free.
 */
export function GraderEditor({
  grader,
  onSaved,
  onDeleted,
}: {
  grader: EvalGrader | null;
  onSaved: (grader: EvalGrader) => void;
  onDeleted: () => void;
}) {
  const createGrader = useCreateEvalGrader();
  const updateGrader = useUpdateEvalGrader();
  const removeGrader = useRemoveEvalGrader();
  const [name, setName] = useState(grader?.name ?? '');
  const [description, setDescription] = useState(grader?.description ?? '');
  const [config, setConfig] = useState<EvalGraderConfig | null>(grader?.config ?? null);
  const [configKey, setConfigKey] = useState(0);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const pending = createGrader.isPending || updateGrader.isPending;

  const applyPreset = (preset: EvalGraderPreset) => {
    setName(preset.grader.name);
    setDescription(preset.grader.description);
    setConfig(preset.grader.config);
    setConfigKey((key) => key + 1);
  };

  if (config === null) {
    return <PresetGallery onPick={applyPreset} />;
  }

  const save = () => {
    setMessage(null);
    const input: EvalGraderInput = { name, description, config };
    const handlers = {
      onSuccess: (saved: EvalGrader) => {
        setMessage({ kind: 'success', text: 'Grader saved.' });
        onSaved(saved);
      },
      onError: (cause: Error) =>
        setMessage({ kind: 'error', text: toErrorMessage(cause, 'Could not save the grader.') }),
    };
    if (grader) updateGrader.mutate({ graderId: grader.id, input }, handlers);
    else createGrader.mutate(input, handlers);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{grader ? grader.name : 'New grader'}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Graders are shared by every dataset; runs keep a snapshot of the definition they used.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={save} disabled={pending || name.trim().length === 0}>
            {pending ? 'Saving…' : 'Save grader'}
          </Button>
          {grader ? (
            <ConfirmButton
              variant="destructiveGhost"
              size="icon"
              title="Delete grader"
              description={`Delete "${grader.name}"? Datasets drop it from their defaults; past runs keep their results.`}
              confirmLabel="Delete"
              disabled={removeGrader.isPending}
              onConfirm={() => removeGrader.mutate(grader.id, { onSuccess: onDeleted })}
            >
              <Trash2 className="size-4" />
            </ConfirmButton>
          ) : null}
        </div>
      </div>

      {message ? <StatusMessage kind={message.kind}>{message.text}</StatusMessage> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="grader-name">
          <Input id="grader-name" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Type" htmlFor="grader-type">
          <Select
            value={config.type}
            items={GRADER_TYPES.map((type) => ({ value: type, label: GRADER_TYPE_LABELS[type] }))}
            onValueChange={(type) => {
              const next = configForType(type);
              if (next) {
                setConfig(next);
                setConfigKey((key) => key + 1);
              }
            }}
          >
            <SelectTrigger id="grader-type" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GRADER_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {GRADER_TYPE_LABELS[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field label="Description" htmlFor="grader-description">
        <Input
          id="grader-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What this grader checks, in one line."
        />
      </Field>

      <ConfigFields key={configKey} config={config} onChange={setConfig} />

      <TestPanel name={name} config={config} />
    </div>
  );
}

function PresetGallery({ onPick }: { onPick: (preset: EvalGraderPreset) => void }) {
  const categories: ReadonlyArray<EvalGraderPreset['category']> = ['code', 'transcript', 'judge'];
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">New grader</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Start from a template. Prefer code checks where they work, and give each LLM judge one dimension to grade.
        </p>
      </div>
      {categories.map((category) => (
        <section key={category} className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {CATEGORY_LABELS[category]}
          </h3>
          <div className="grid gap-2 @2xl:grid-cols-2">
            {EVAL_GRADER_PRESETS.filter((preset) => preset.category === category).map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => onPick(preset)}
                className="rounded-lg border border-border p-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
              >
                <div className="text-sm font-medium">{preset.name}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{preset.description}</div>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ConfigFields({
  config,
  onChange,
}: {
  config: EvalGraderConfig;
  onChange: (config: EvalGraderConfig) => void;
}) {
  switch (config.type) {
    case 'exact-match':
      return (
        <div className="space-y-3">
          <TemplateField value={config.expected} onChange={(expected) => onChange({ ...config, expected })} />
          <div className="grid gap-2 sm:grid-cols-2">
            <Toggle
              label="Case-sensitive"
              checked={config.caseSensitive}
              onChange={(caseSensitive) => onChange({ ...config, caseSensitive })}
            />
            <Toggle
              label="Normalize whitespace"
              description="Trim and collapse runs of spaces and line breaks."
              checked={config.normalizeWhitespace}
              onChange={(normalizeWhitespace) => onChange({ ...config, normalizeWhitespace })}
            />
          </div>
        </div>
      );
    case 'contains':
      return (
        <div className="space-y-3">
          <ListField
            label="Values"
            description="One per line; templates such as {{expected}} work."
            values={config.values}
            onChange={(values) => onChange({ ...config, values })}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Mode" htmlFor="contains-mode">
              <Select
                value={config.mode}
                items={{ all: 'Contains all', any: 'Contains any', none: 'Contains none' }}
                onValueChange={(mode) => onChange({ ...config, mode })}
              >
                <SelectTrigger id="contains-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Contains all</SelectItem>
                  <SelectItem value="any">Contains any</SelectItem>
                  <SelectItem value="none">Contains none</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Toggle
              label="Case-sensitive"
              checked={config.caseSensitive}
              onChange={(caseSensitive) => onChange({ ...config, caseSensitive })}
            />
          </div>
        </div>
      );
    case 'regex':
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
            <Field label="Pattern" htmlFor="regex-pattern">
              <Input
                id="regex-pattern"
                value={config.pattern}
                onChange={(event) => onChange({ ...config, pattern: event.target.value })}
                className="font-mono"
              />
            </Field>
            <Field label="Flags" htmlFor="regex-flags">
              <Input
                id="regex-flags"
                value={config.flags}
                onChange={(event) => onChange({ ...config, flags: event.target.value })}
                className="font-mono"
              />
            </Field>
          </div>
          <Toggle
            label="Pass when it does not match"
            checked={config.negate}
            onChange={(negate) => onChange({ ...config, negate })}
          />
        </div>
      );
    case 'json':
      return <JsonSchemaField config={config} onChange={onChange} />;
    case 'json-match':
      return (
        <div className="space-y-3">
          <TemplateField
            value={config.expected}
            onChange={(expected) => onChange({ ...config, expected })}
            description="Must render to JSON, usually {{expected}} holding a JSON reference answer."
          />
          <Field label="Mode" htmlFor="json-match-mode">
            <Select
              value={config.mode}
              items={{ subset: 'Expected fields must match', exact: 'Must equal exactly' }}
              onValueChange={(mode) => onChange({ ...config, mode })}
            >
              <SelectTrigger id="json-match-mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="subset">Expected fields must match</SelectItem>
                <SelectItem value="exact">Must equal exactly</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      );
    case 'numeric':
      return (
        <div className="space-y-3">
          <TemplateField value={config.expected} onChange={(expected) => onChange({ ...config, expected })} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Tolerance" htmlFor="numeric-tolerance">
              <Input
                id="numeric-tolerance"
                type="number"
                min={0}
                step="any"
                value={config.tolerance}
                onChange={(event) => onChange({ ...config, tolerance: Math.max(0, numberOr(event.target.value, 0)) })}
              />
            </Field>
            <Toggle
              label="Relative tolerance"
              description="Read the tolerance as a fraction of the expected value."
              checked={config.relative}
              onChange={(relative) => onChange({ ...config, relative })}
            />
          </div>
        </div>
      );
    case 'similarity':
      return (
        <div className="space-y-3">
          <TemplateField value={config.expected} onChange={(expected) => onChange({ ...config, expected })} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Pass threshold (0–1)" htmlFor="similarity-threshold">
              <Input
                id="similarity-threshold"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={config.threshold}
                onChange={(event) =>
                  onChange({ ...config, threshold: Math.min(1, Math.max(0, numberOr(event.target.value, 0.8))) })
                }
              />
            </Field>
            <Toggle
              label="Case-sensitive"
              checked={config.caseSensitive}
              onChange={(caseSensitive) => onChange({ ...config, caseSensitive })}
            />
          </div>
        </div>
      );
    case 'tool-calls':
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <ListField
              label="Must call"
              description="One tool per line; * wildcards such as github.* work."
              values={config.required}
              onChange={(required) => onChange({ ...config, required })}
            />
            <ListField
              label="Must never call"
              description="One tool per line."
              values={config.forbidden}
              onChange={(forbidden) => onChange({ ...config, forbidden })}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Toggle
              label="In the listed order"
              description="Checking order is often too rigid: agents find valid paths you did not plan."
              checked={config.ordered}
              onChange={(ordered) => onChange({ ...config, ordered })}
            />
            <Field label="Call budget" htmlFor="tool-max-calls" description="Optional maximum number of calls.">
              <Input
                id="tool-max-calls"
                type="number"
                min={0}
                value={config.maxCalls ?? ''}
                onChange={(event) => {
                  const { maxCalls: _previous, ...rest } = config;
                  const value = event.target.value.trim();
                  onChange(value ? { ...rest, maxCalls: Math.max(0, Math.round(numberOr(value, 0))) } : rest);
                }}
              />
            </Field>
          </div>
        </div>
      );
    case 'latency':
      return (
        <Field label="Maximum duration (seconds)" htmlFor="latency-max">
          <Input
            id="latency-max"
            type="number"
            min={0.1}
            step="any"
            value={config.maxDurationMs / 1000}
            onChange={(event) =>
              onChange({ ...config, maxDurationMs: Math.max(1, Math.round(numberOr(event.target.value, 30) * 1000)) })
            }
          />
        </Field>
      );
    case 'llm-judge':
      return <JudgeFields config={config} onChange={onChange} />;
  }
}

function TemplateField({
  value,
  onChange,
  description = 'A template: {{expected}} is the case’s reference answer, {{metadata.key}} one of its fields.',
}: {
  value: string;
  onChange: (value: string) => void;
  description?: string;
}) {
  return (
    <Field label="Compare against" htmlFor="grader-expected" description={description}>
      <Input
        id="grader-expected"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="font-mono"
      />
    </Field>
  );
}

function ListField({
  label,
  description,
  values,
  onChange,
}: {
  label: string;
  description: string;
  values: ReadonlyArray<string>;
  onChange: (values: ReadonlyArray<string>) => void;
}) {
  const [text, setText] = useState(values.join('\n'));
  const id = `list-${label.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <Field label={label} htmlFor={id} description={description}>
      <Textarea
        id={id}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onChange(lines(event.target.value));
        }}
        className="min-h-20 font-mono text-xs"
      />
    </Field>
  );
}

function JsonSchemaField({
  config,
  onChange,
}: {
  config: Extract<EvalGraderConfig, { type: 'json' }>;
  onChange: (config: EvalGraderConfig) => void;
}) {
  const [text, setText] = useState(config.schema ? JSON.stringify(config.schema, null, 2) : '');
  const invalid = text.trim().length > 0 && Option.isNone(decodeJsonObjectStringOption(text));
  return (
    <Field
      label="JSON Schema"
      htmlFor="json-schema"
      description="Optional. Leave empty to only check that the output parses as JSON."
    >
      <JsonTextarea
        id="json-schema"
        value={text}
        onChange={(next) => {
          setText(next);
          const parsed = decodeJsonObjectStringOption(next);
          if (next.trim().length === 0) onChange({ type: 'json' });
          else if (Option.isSome(parsed)) onChange({ type: 'json', schema: parsed.value });
        }}
        className="min-h-32"
        placeholder='{ "type": "object", "required": ["answer"] }'
      />
      {invalid ? <span className="text-destructive">Not a JSON object yet; the last valid schema is kept.</span> : null}
    </Field>
  );
}

const TEMPLATE_HINTS = ['{{input}}', '{{output}}', '{{expected}}', '{{transcript}}', '{{metadata.key}}'];

function JudgeFields({
  config,
  onChange,
}: {
  config: LlmJudgeGraderConfig;
  onChange: (config: EvalGraderConfig) => void;
}) {
  const [, navigate] = useLocation();
  // Verdict rows are edited in place, so each gets an id of its own for React to track it by.
  const [choiceIds, setChoiceIds] = useState<ReadonlyArray<number>>(() =>
    config.scoring.kind === 'choices' ? config.scoring.choices.map((_, position) => position) : [0, 1],
  );
  const [nextChoiceId, setNextChoiceId] = useState(() =>
    config.scoring.kind === 'choices' ? config.scoring.choices.length : 2,
  );
  const unknown = unknownEvalTemplateVariables(config.prompt);
  const blind = !/\{\{\{?\s*(output|transcript)\s*\}?\}\}/.test(config.prompt);
  const scoring = config.scoring;

  const setChoice = (index: number, patch: Partial<{ label: string; score: number; description: string }>) =>
    scoring.kind === 'choices'
      ? onChange({
          ...config,
          scoring: {
            ...scoring,
            choices: scoring.choices.map((choice, position) => (position === index ? { ...choice, ...patch } : choice)),
          },
        })
      : undefined;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
        <Field label="Judge model" htmlFor="judge-model" description="Use a different model from the one under test.">
          <ModelPicker
            id="judge-model"
            value={config.model}
            onChange={(model) => onChange({ ...config, model })}
            onAddProviderKey={() => navigate(providersPath())}
          />
        </Field>
        <Field label="Reasoning effort" htmlFor="judge-effort">
          <Select
            value={config.reasoningEffort ?? 'default'}
            items={{ default: 'Model default', ...REASONING_EFFORT_LABELS }}
            onValueChange={(value) => {
              const { reasoningEffort: _previous, ...rest } = config;
              const effort = Object.keys(REASONING_EFFORT_LABELS).find((key): key is ReasoningEffort => key === value);
              onChange(effort === undefined ? rest : { ...rest, reasoningEffort: effort });
            }}
          >
            <SelectTrigger id="judge-effort" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Model default</SelectItem>
              {Object.entries(REASONING_EFFORT_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field
        label="Rubric"
        htmlFor="judge-prompt"
        description="Specific, checkable criteria beat vague ones: two experts should agree on every verdict. The judge always reasons before it answers."
      >
        <Textarea
          id="judge-prompt"
          value={config.prompt}
          onChange={(event) => onChange({ ...config, prompt: event.target.value })}
          className="min-h-64 font-mono text-xs"
          spellCheck={false}
        />
        <div className="flex flex-wrap gap-1">
          {TEMPLATE_HINTS.map((hint) => (
            <code key={hint} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
              {hint}
            </code>
          ))}
        </div>
        {blind ? (
          <span className="text-destructive">
            Include {'{{output}}'} or {'{{transcript}}'}, or the judge has nothing to grade.
          </span>
        ) : null}
        {unknown.length > 0 ? (
          <span className="text-destructive">Unknown variables: {unknown.map((path) => `{{${path}}}`).join(', ')}</span>
        ) : null}
      </Field>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Verdicts" htmlFor="judge-scoring">
          <Select
            value={scoring.kind}
            items={{ choices: 'Labelled choices', scale: 'Numeric scale' }}
            onValueChange={(kind) => {
              setChoiceIds([nextChoiceId, nextChoiceId + 1]);
              setNextChoiceId(nextChoiceId + 2);
              onChange({
                ...config,
                scoring:
                  kind === 'scale'
                    ? { kind: 'scale', min: 1, max: 5 }
                    : {
                        kind: 'choices',
                        choices: [
                          { label: 'PASS', score: 1 },
                          { label: 'FAIL', score: 0 },
                        ],
                      },
              });
            }}
          >
            <SelectTrigger id="judge-scoring" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="choices">Labelled choices</SelectItem>
              <SelectItem value="scale">Numeric scale</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Pass at score ≥" htmlFor="judge-threshold" description="Scores run from 0 to 1.">
          <Input
            id="judge-threshold"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={config.passThreshold}
            onChange={(event) =>
              onChange({ ...config, passThreshold: Math.min(1, Math.max(0, numberOr(event.target.value, 1))) })
            }
          />
        </Field>
        <Toggle
          label="Allow UNKNOWN"
          description="Lets the judge abstain instead of guessing; the trial is flagged for review."
          checked={config.allowUnknown}
          onChange={(allowUnknown) => onChange({ ...config, allowUnknown })}
        />
      </div>

      {scoring.kind === 'scale' ? (
        <div className="grid max-w-sm grid-cols-2 gap-3">
          <Field label="Lowest" htmlFor="judge-min">
            <Input
              id="judge-min"
              type="number"
              value={scoring.min}
              onChange={(event) =>
                onChange({ ...config, scoring: { ...scoring, min: Math.round(numberOr(event.target.value, 1)) } })
              }
            />
          </Field>
          <Field label="Highest" htmlFor="judge-max">
            <Input
              id="judge-max"
              type="number"
              value={scoring.max}
              onChange={(event) =>
                onChange({ ...config, scoring: { ...scoring, max: Math.round(numberOr(event.target.value, 5)) } })
              }
            />
          </Field>
        </div>
      ) : (
        <div className="space-y-2">
          {scoring.choices.map((choice, index) => (
            <div key={choiceIds[index]} className="grid grid-cols-[140px_90px_1fr_auto] items-center gap-2">
              <Input
                value={choice.label}
                onChange={(event) => setChoice(index, { label: event.target.value })}
                placeholder="Label"
                className="font-mono"
                aria-label="Verdict label"
              />
              <Input
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={choice.score}
                onChange={(event) =>
                  setChoice(index, { score: Math.min(1, Math.max(0, numberOr(event.target.value, 0))) })
                }
                aria-label="Verdict score"
              />
              <Input
                value={choice.description ?? ''}
                onChange={(event) => setChoice(index, { description: event.target.value })}
                placeholder="What this verdict means"
                aria-label="Verdict description"
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Remove verdict"
                disabled={scoring.choices.length <= 2}
                onClick={() => {
                  setChoiceIds(choiceIds.filter((_, position) => position !== index));
                  onChange({
                    ...config,
                    scoring: { ...scoring, choices: scoring.choices.filter((_, position) => position !== index) },
                  });
                }}
              >
                <X />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setChoiceIds([...choiceIds, nextChoiceId]);
              setNextChoiceId(nextChoiceId + 1);
              onChange({
                ...config,
                scoring: { ...scoring, choices: [...scoring.choices, { label: '', score: 0 }] },
              });
            }}
          >
            <Plus className="size-3" />
            Add verdict
          </Button>
        </div>
      )}
    </div>
  );
}

const decodeToolCalls = (text: string): ReadonlyArray<EvalToolCall> | undefined => {
  const parsed = Option.getOrUndefined(decodeJsonStringOption(text));
  if (!isJsonArray(parsed)) return undefined;
  return parsed.flatMap((item) => {
    const toolName = isJsonObject(item) ? jsonString(item, 'toolName') : undefined;
    return toolName
      ? [{ toolName, input: jsonProperty(item, 'input') ?? null, output: jsonProperty(item, 'output') ?? null }]
      : [];
  });
};

function TestPanel({ name, config }: { name: string; config: EvalGraderConfig }) {
  const testGrader = useTestEvalGrader();
  const [input, setInput] = useState('');
  const [expected, setExpected] = useState('');
  const [output, setOutput] = useState('');
  const [toolCalls, setToolCalls] = useState('[]');
  const [durationSeconds, setDurationSeconds] = useState('1');
  const [result, setResult] = useState<EvalGrade | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needsTools =
    config.type === 'tool-calls' || (config.type === 'llm-judge' && config.prompt.includes('transcript'));
  const parsedTools = needsTools ? decodeToolCalls(toolCalls) : [];

  const run = () => {
    setError(null);
    setResult(null);
    testGrader.mutate(
      {
        name: name || undefined,
        config,
        sample: {
          input,
          expected: expected || undefined,
          output,
          toolCalls: parsedTools ? [...parsedTools] : undefined,
          durationMs: Math.round(numberOr(durationSeconds, 1) * 1000),
        },
      },
      {
        onSuccess: setResult,
        onError: (cause) => setError(toErrorMessage(cause, 'Could not test the grader.')),
      },
    );
  };

  return (
    <section className="space-y-3 rounded-lg border border-dashed border-border p-4">
      <div className="flex items-center gap-2">
        <FlaskConical className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Try it</h3>
        <span className="text-xs text-muted-foreground">
          Grade a hand-written answer with the unsaved definition.
          {config.type === 'llm-judge' ? ' This makes one call to the judge model.' : ' This is free.'}
        </span>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Case input" htmlFor="test-input">
          <Textarea
            id="test-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            className="min-h-16 text-xs"
          />
        </Field>
        <Field label="Reference answer" htmlFor="test-expected">
          <Textarea
            id="test-expected"
            value={expected}
            onChange={(event) => setExpected(event.target.value)}
            className="min-h-16 text-xs"
          />
        </Field>
      </div>
      <Field label="Output to grade" htmlFor="test-output">
        <Textarea
          id="test-output"
          value={output}
          onChange={(event) => setOutput(event.target.value)}
          className="min-h-20 text-xs"
        />
      </Field>
      {needsTools ? (
        <Field
          label="Tool calls"
          htmlFor="test-tools"
          description='A JSON array such as [{ "toolName": "crm.lookup", "input": {}, "output": {} }].'
        >
          <JsonTextarea id="test-tools" value={toolCalls} onChange={setToolCalls} className="min-h-16" />
        </Field>
      ) : null}
      {config.type === 'latency' ? (
        <Field label="Duration (seconds)" htmlFor="test-duration">
          <Input
            id="test-duration"
            type="number"
            min={0}
            step="any"
            value={durationSeconds}
            onChange={(event) => setDurationSeconds(event.target.value)}
            className="max-w-40"
          />
        </Field>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          onClick={run}
          disabled={testGrader.isPending || output.length === 0 || parsedTools === undefined}
        >
          {testGrader.isPending ? 'Grading…' : 'Grade sample'}
        </Button>
        {parsedTools === undefined ? <Badge variant="destructive">tool calls are not a JSON array</Badge> : null}
      </div>
      {error ? <StatusMessage kind="error">{error}</StatusMessage> : null}
      {result ? <GradeCard grade={result} /> : null}
    </section>
  );
}
