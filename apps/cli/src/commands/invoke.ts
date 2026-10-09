import * as NodeCrypto from 'node:crypto';
import type { Message, MessageSendParams } from '@a2a-js/sdk';
import type { Client } from '@a2a-js/sdk/client';
import { workflowUserMessage } from 'agentdock-sdk';
import { tracedA2aClientFactory } from 'agentdock-sdk/a2a/client';
import { buildWorkflowA2aUrl } from 'agentdock-sdk/routes';
import type {
  JsonObject,
  RegisteredWorkflow,
  WorkflowA2AHumanInputRequestEnvelope,
  WorkflowA2AHumanInputResponseEnvelope,
} from 'agentdock-sdk/schemas';
import { decodeWorkflowA2AEnvelopeOption } from 'agentdock-sdk/schemas';
import * as Console from 'effect/Console';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { Api } from '../api';
import { cliError, messageOf } from '../errors';
import {
  answerFlag,
  answerInputRequired,
  describeInputRequest,
  jsonFlag,
  type OutputOptions,
  type PromptServices,
  readInputArgument,
  verboseFlag,
  writeEvent,
  writeJson,
} from '../output';
import { findRemoteWorkflow } from '../remote';

const workflowRef = Argument.String('workflow').pipe(
  Argument.withDescription('Workflow id, folder slug or manifest name'),
);
const input = Argument.String('input').pipe(
  Argument.withDescription('Task input: text, a JSON object, or @path to read it from a file'),
);

const StreamMessage = Schema.Struct({
  parts: Schema.Array(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal('text'), text: Schema.String }),
      Schema.Struct({ kind: Schema.Literal('data'), data: Schema.Unknown }),
    ]),
  ),
});

/** The slice of the a2a stream the CLI reacts to; other event kinds and part kinds are ignored. */
const StreamEvent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('task'), id: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('status-update'),
    taskId: Schema.String,
    final: Schema.optional(Schema.Boolean),
    status: Schema.Struct({ state: Schema.String, message: Schema.optional(StreamMessage) }),
  }),
]);
type StreamMessage = Schema.Schema.Type<typeof StreamMessage>;
const decodeStreamEvent = Schema.decodeUnknownOption(StreamEvent);

const messageText = (message: StreamMessage | undefined): string =>
  message?.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('') ?? '';

type Outcome = {
  readonly state: string | undefined;
  readonly text: string;
  readonly taskId: string | undefined;
  readonly pending: WorkflowA2AHumanInputRequestEnvelope | undefined;
};

/** Drains one a2a stream, printing workflow events, until the task settles or asks for input. */
const drain = (client: Client, params: MessageSendParams, output: OutputOptions): Effect.Effect<Outcome> =>
  Effect.promise(async () => {
    let state: string | undefined;
    let text = '';
    let taskId: string | undefined;
    let pending: WorkflowA2AHumanInputRequestEnvelope | undefined;
    for await (const raw of client.sendMessageStream(params)) {
      const event = Option.getOrUndefined(decodeStreamEvent(raw));
      if (event === undefined) continue;
      if (event.kind === 'task') {
        taskId = event.id;
        continue;
      }
      taskId = event.taskId;
      for (const part of event.status.message?.parts ?? []) {
        if (part.kind !== 'data') continue;
        const envelope = Option.getOrUndefined(decodeWorkflowA2AEnvelopeOption(part.data));
        if (envelope?.type === 'workflow-event') writeEvent(envelope.event, output);
        if (envelope?.type === 'workflow-human-input-request') pending = envelope;
      }
      if (event.status.state === 'input-required' || event.final === true) {
        state = event.status.state;
        text = messageText(event.status.message);
      }
    }
    return { state, text, taskId, pending };
  });

const invoke = (ref: string, rawInput: string, answerValues: ReadonlyArray<string>, output: OutputOptions) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const workflow: RegisteredWorkflow = yield* findRemoteWorkflow(ref);
    const input = yield* readInputArgument(rawInput);
    const promptServices = yield* Effect.context<PromptServices>();
    const answers = [...answerValues];
    const contextId = NodeCrypto.randomUUID();
    const clientFactory = yield* tracedA2aClientFactory;
    const client = yield* Effect.tryPromise({
      try: () => clientFactory.createFromUrl(`${buildWorkflowA2aUrl(api.baseUrl, workflow.id)}/`),
      catch: (error) => cliError(`Cannot reach workflow ${workflow.id}: ${messageOf(error)}`),
    });

    const send = (message: Message) =>
      drain(client, { configuration: { blocking: false }, message: { ...message, contextId } }, output).pipe(
        Effect.mapError((error) => cliError(`Invoking ${workflow.manifest.name} failed: ${messageOf(error)}`)),
      );

    let outcome = yield* send(yield* workflowUserMessage(workflow, input));
    while (outcome.pending !== undefined && outcome.taskId !== undefined) {
      const response: JsonObject | undefined = yield* answerInputRequired(outcome.pending, answers, output).pipe(
        Effect.provideContext(promptServices),
      );
      if (response === undefined) break;
      const answer: WorkflowA2AHumanInputResponseEnvelope = {
        type: 'workflow-human-input-response',
        actionId: outcome.pending.actionId,
        response,
      };
      outcome = yield* send({
        kind: 'message',
        messageId: NodeCrypto.randomUUID(),
        role: 'user',
        taskId: outcome.taskId,
        parts: [{ kind: 'data', data: answer }],
      });
    }

    const status = outcome.state ?? 'failed';
    if (output.json) {
      writeJson({
        type: 'result',
        status,
        text: outcome.text,
        taskId: outcome.taskId,
        contextId,
        pending: outcome.pending,
      });
    } else {
      yield* Console.log(`\n${status}`);
      if (outcome.text.length > 0) yield* Console.log(outcome.text);
      if (outcome.pending) {
        yield* Console.log(describeInputRequest(outcome.pending));
        yield* Console.log(
          `The task ${outcome.taskId} is waiting for input; answer it in the web UI or re-run with --answer.`,
        );
      }
    }
    if (status !== 'completed') return yield* cliError(`Workflow task ${status}.`);
  });

export const invokeCommand = Command.make(
  'invoke',
  { workflow: workflowRef, input, answer: answerFlag, json: jsonFlag, verbose: verboseFlag },
  ({ workflow, input, answer, json, verbose }) => invoke(workflow, input, answer, { json, verbose }),
).pipe(Command.withDescription('Run a registered workflow on the server over a2a and stream its events'));
