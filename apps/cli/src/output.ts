import type {
  JsonObject,
  JsonSerializable,
  WorkflowA2AHumanInputRequestEnvelope,
  WorkflowRunEvent,
} from 'agentdock-sdk/schemas';
import {
  AgentCallProgressState,
  decodeJsonStringOption,
  isJsonObject,
  ModelTokenProgressState,
  renderJson,
} from 'agentdock-sdk/schemas';
import * as Console from 'effect/Console';
import * as Flag from 'effect/cli/Flag';
import * as Prompt from 'effect/cli/Prompt';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import type * as Terminal from 'effect/Terminal';
import { type CliError, cliError, messageOf } from './errors';
import type { FileServices } from './files';

// A bare `Flag.Boolean` fails when omitted; switches default to off.
export const jsonFlag = Flag.Boolean('json').pipe(
  Flag.withDefault(false),
  Flag.withDescription('Emit newline-delimited JSON instead of text, for scripts and coding agents'),
);
export const verboseFlag = Flag.Boolean('verbose').pipe(
  Flag.withDefault(false),
  Flag.withAlias('v'),
  Flag.withDescription('Show step inputs, outputs and progress data'),
);
export const answerFlag = Flag.String('answer').pipe(
  Flag.atLeast(0),
  Flag.withDescription('Response to the next interrupt() as JSON or text; repeat for several gates'),
);

export type OutputOptions = { readonly json: boolean; readonly verbose: boolean };

const writeLine = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

export const writeJson = (value: JsonSerializable): void => writeLine(JSON.stringify(value));

export const clip = (text: string, max = 160): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Reads `@path` arguments from disk so long JSON inputs need not be quoted on the command line. */
export const readInputArgument = (input: string): Effect.Effect<string, CliError, FileSystem.FileSystem> =>
  input.startsWith('@')
    ? Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.readFileString(input.slice(1));
      }).pipe(Effect.mapError((error) => cliError(`Cannot read input file '${input.slice(1)}': ${messageOf(error)}`)))
    : Effect.succeed(input);

const detail = (label: string, value: string): string => `\n    ${label}: ${clip(value, 400)}`;

export const describeEvent = (event: WorkflowRunEvent, verbose: boolean): string => {
  switch (event.type) {
    case 'run-started':
      return `${event.type}${verbose ? detail('input', event.input) : ''}`;
    case 'run-completed':
      return `${event.type}${verbose ? detail('output', event.output) : ''}`;
    case 'run-canceled':
      return event.type;
    case 'run-failed':
      return `${event.type}  ${event.error}`;
    case 'step-started':
      return `${event.type}  ${event.stepId}${verbose ? detail('input', event.input) : ''}`;
    case 'step-completed':
      return `${event.type}  ${event.stepId}${verbose ? detail('output', event.output) : ''}`;
    case 'step-failed':
      return `${event.type}  ${event.stepId}  ${event.error}`;
    case 'step-progress':
      return `${event.type}  ${event.stepId}  ${event.state}${verbose ? detail('data', JSON.stringify(event.data)) : ''}`;
    case 'human-input-requested':
      return `${event.type}  ${event.stepId}  ${event.title}`;
    case 'human-input-resolved':
      return `${event.type}  ${event.stepId}${verbose ? detail('response', event.response) : ''}`;
  }
};

/** Streamed text arrives a few characters per event; a line each says nothing until `--verbose` asks for it. */
const isTextChunk = (event: WorkflowRunEvent): boolean =>
  event.type === 'step-progress' &&
  (event.state === AgentCallProgressState.Artifact || event.state === ModelTokenProgressState);

export const writeEvent = (event: WorkflowRunEvent, options: OutputOptions): void => {
  if (options.json) writeJson(event);
  else if (options.verbose || !isTextChunk(event)) writeLine(describeEvent(event, options.verbose));
};

const parseAnswer = (text: string): JsonObject =>
  Option.match(decodeJsonStringOption(text), {
    onNone: () => ({ value: text }),
    onSome: (json) => (isJsonObject(json) ? json : { value: json }),
  });

export const describeInputRequest = (request: WorkflowA2AHumanInputRequestEnvelope): string => {
  const lines = [`Input required at step '${request.stepId}': ${request.title}`];
  if (request.description) lines.push(`  ${request.description}`);
  if (request.input !== undefined) lines.push(`  input: ${renderJson(request.input)}`);
  if (request.responseSchema) lines.push(`  response schema: ${request.responseSchema}`);
  return lines.join('\n');
};

export type PromptServices = FileServices | Terminal.Terminal;

/**
 * Answers an interrupt from the `--answer` queue first, then interactively when
 * attached to a terminal. `undefined` leaves the run waiting.
 */
export const answerInputRequired = (
  request: WorkflowA2AHumanInputRequestEnvelope,
  answers: Array<string>,
  options: OutputOptions,
): Effect.Effect<JsonObject | undefined, never, PromptServices> =>
  Effect.gen(function* () {
    if (options.json) writeJson(request);
    else yield* Console.log(describeInputRequest(request));
    const queued = answers.shift();
    if (queued !== undefined) return parseAnswer(queued);
    if (!process.stdin.isTTY || options.json) return undefined;
    const typed = yield* Prompt.run(Prompt.String({ message: 'Response (JSON object or text)' })).pipe(
      Effect.catchTag('QuitError', () => Effect.succeed(undefined)),
    );
    return typed === undefined ? undefined : parseAnswer(typed);
  });
