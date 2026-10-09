import type { EvalToolCall } from '../schemas/evals';
import { type Json, type JsonObject, jsonProperty, renderJson } from '../schemas/json';

/** What a grader template can reference while grading one trial. */
export type EvalTemplateContext = {
  readonly input: string;
  readonly output: string;
  readonly expected?: string | undefined;
  readonly metadata?: JsonObject | undefined;
  /** The trial's tool calls rendered as text, for judges that grade the path as well as the answer. */
  readonly transcript?: string | undefined;
};

/**
 * `{{name}}`, `{{ metadata.key.nested }}`, and the Mustache-style triple
 * `{{{name}}}` the autoevals templates use. Rendering never escapes: the
 * output is a prompt or a comparison value, not HTML.
 */
const PLACEHOLDER = /\{\{\{?\s*([A-Za-z_][\w-]*(?:\.[\w-]+)*)\s*\}?\}\}/g;

const EVAL_TEMPLATE_VARIABLES = ['input', 'output', 'expected', 'transcript', 'metadata'] as const;

const lookup = (context: EvalTemplateContext, path: ReadonlyArray<string>): Json | undefined => {
  const [head, ...rest] = path;
  switch (head) {
    case 'input':
      return rest.length === 0 ? context.input : undefined;
    case 'output':
      return rest.length === 0 ? context.output : undefined;
    case 'expected':
      return rest.length === 0 ? context.expected : undefined;
    case 'transcript':
      return rest.length === 0 ? context.transcript : undefined;
    case 'metadata':
      return rest.reduce<Json | undefined>((value, key) => jsonProperty(value, key), context.metadata);
    default:
      return undefined;
  }
};

/** Renders a template; a variable with no value renders empty. */
export const renderEvalTemplate = (template: string, context: EvalTemplateContext): string =>
  template.replace(PLACEHOLDER, (_match, path: string) => renderJson(lookup(context, path.split('.'))));

/** The variable paths a template references, in order of first use. */
const evalTemplateVariables = (template: string): ReadonlyArray<string> => [
  ...new Set(Array.from(template.matchAll(PLACEHOLDER), (match) => match[1] ?? '')),
];

/** Variables whose root is not one the renderer knows, so a typo can be flagged while editing. */
export const unknownEvalTemplateVariables = (template: string): ReadonlyArray<string> =>
  evalTemplateVariables(template).filter((path) => {
    const root = path.split('.')[0] ?? '';
    return !EVAL_TEMPLATE_VARIABLES.some((variable) => variable === root);
  });

/** Tool results are clipped so a chatty tool cannot blow up a judge's prompt, and its bill. */
const MAX_TRANSCRIPT_VALUE_LENGTH = 2_000;

const clip = (text: string): string =>
  text.length > MAX_TRANSCRIPT_VALUE_LENGTH
    ? `${text.slice(0, MAX_TRANSCRIPT_VALUE_LENGTH)}… (${text.length - MAX_TRANSCRIPT_VALUE_LENGTH} more characters)`
    : text;

/** A trial's tool calls as numbered plain text, the `{{transcript}}` a judge reads. */
export const renderEvalTranscript = (toolCalls: ReadonlyArray<EvalToolCall>): string =>
  toolCalls.length === 0
    ? '(no tool calls)'
    : toolCalls
        .map((call, index) => {
          const result = call.error === undefined ? clip(renderJson(call.output)) : `error: ${call.error}`;
          return `${index + 1}. ${call.toolName}(${clip(renderJson(call.input))})\n   → ${result}`;
        })
        .join('\n');
