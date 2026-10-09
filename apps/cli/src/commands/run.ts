import { localRuntimeLayer, runWorkflowLocally } from 'agentdock-sdk';
import type { AgentRunRecord } from 'agentdock-sdk/schemas';
import { InvocationOutcome, manifestAgentNames, manifestToolNames, manifestWorkflowNames } from 'agentdock-sdk/schemas';
import { loadWorkflowManifest, WorkflowToolInvokeError } from 'agentdock-sdk/workflows';
import * as Console from 'effect/Console';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import { Api } from '../api';
import {
  parseAssignments,
  resolveBindings,
  resolveModelBindings,
  resolveSecrets,
  resolveToolBindings,
} from '../bindings';
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

const folder = Argument.String('workflow-folder').pipe(Argument.withDescription('Workflow artifact folder'));
const input = Argument.String('input').pipe(
  Argument.withDescription('Task input: text, a JSON object, or @path to read it from a file'),
);
const agent = Flag.String('agent').pipe(
  Flag.atLeast(0),
  Flag.withDescription('Bind a manifest agent name to an .agent.yaml file or an a2a URL, as name=value'),
);
const secret = Flag.String('secret').pipe(
  Flag.atLeast(0),
  Flag.withDescription('Value for a manifest secret, as NAME=value (falls back to the environment)'),
);
const toolFlag = Flag.String('tool').pipe(
  Flag.atLeast(0),
  Flag.withDescription('Bind a manifest tool name to a catalog tool id on the server, as name=id'),
);
const modelFlag = Flag.String('model').pipe(
  Flag.atLeast(0),
  Flag.withDescription('Bind a manifest model name to a model, as name=provider:model (default: the manifest default)'),
);

const summarizeAgentRun = (run: AgentRunRecord) => ({
  id: run.id,
  agentId: run.agentId,
  status: run.status.state,
  messages: run.history.length,
});

type RunFlags = {
  readonly agent: ReadonlyArray<string>;
  readonly secret: ReadonlyArray<string>;
  readonly tool: ReadonlyArray<string>;
  readonly model: ReadonlyArray<string>;
  readonly answer: ReadonlyArray<string>;
  readonly json: boolean;
  readonly verbose: boolean;
};

const run = (folder: string, rawInput: string, flags: RunFlags) =>
  Effect.gen(function* () {
    const output: OutputOptions = { json: flags.json, verbose: flags.verbose };
    const loaded = yield* loadWorkflowManifest(folder).pipe(Effect.mapError((error) => cliError(error.message)));
    const workflowNames = manifestWorkflowNames(loaded.manifest);
    if (workflowNames.length > 0) {
      return yield* cliError(`Local runs cannot bind workflows yet (manifest declares: ${workflowNames.join(', ')}).`);
    }
    const input = yield* readInputArgument(rawInput);
    const agentBindings = yield* resolveBindings(
      manifestAgentNames(loaded.manifest),
      yield* parseAssignments(flags.agent, 'agent'),
    );
    const toolBindings = yield* resolveToolBindings(
      manifestToolNames(loaded.manifest),
      yield* parseAssignments(flags.tool, 'tool'),
    );
    const modelBindings = yield* resolveModelBindings(loaded.manifest, yield* parseAssignments(flags.model, 'model'));
    const api = yield* Api;
    const secrets = yield* resolveSecrets(
      loaded.manifest.secrets ?? [],
      yield* parseAssignments(flags.secret, 'secret'),
    );
    const promptServices = yield* Effect.context<PromptServices>();
    const answers = [...flags.answer];

    const result = yield* runWorkflowLocally({
      artifact: loaded,
      bindings: [...agentBindings, ...toolBindings, ...modelBindings],
      secrets,
      input,
      onEvent: (event) => writeEvent(event, output),
      onInputRequired: (request) =>
        answerInputRequired(request, answers, output).pipe(Effect.provideContext(promptServices)),
    }).pipe(
      Effect.provide(
        localRuntimeLayer({
          // Local runs still execute bound tools on the platform, so the
          // gateway's policy and audit apply exactly as they do to a hosted run.
          workflowTools: (toolId, input) =>
            api.call(InvocationOutcome, 'POST', 'tools/execute', { body: { toolId, input } }).pipe(
              Effect.mapError((error) => new WorkflowToolInvokeError({ message: error.message, error })),
              Effect.flatMap((outcome) =>
                outcome.status === 'succeeded'
                  ? Effect.succeed(outcome.result)
                  : Effect.fail(
                      new WorkflowToolInvokeError({
                        message: `Tool '${toolId}' did not run: ${outcome.status}`,
                        error: outcome,
                      }),
                    ),
              ),
            ),
        }),
      ),
      Effect.mapError((error) => cliError(`Run failed: ${messageOf(error)}`)),
    );

    if (flags.json) {
      writeJson({
        type: 'result',
        status: result.status,
        text: result.text,
        pending: result.pending,
        agentRuns: result.agentRuns.map(summarizeAgentRun),
      });
    } else {
      yield* Console.log(`\n${result.status}`);
      if (result.text.length > 0) yield* Console.log(result.text);
      if (result.pending) {
        yield* Console.log(describeInputRequest(result.pending));
        yield* Console.log('The run is waiting for input. Re-run with --answer <json> to supply it.');
      }
      if (flags.verbose && result.agentRuns.length > 0) {
        yield* Console.log('\nagent runs:');
        for (const agentRun of result.agentRuns) {
          yield* Console.log(
            `  ${agentRun.id}  ${agentRun.agentId}  ${agentRun.status.state}  ${agentRun.history.length} messages`,
          );
        }
      }
    }
    if (result.status !== 'completed') return yield* cliError(`Workflow run ${result.status}.`);
  });

export const runCommand = Command.make(
  'run',
  {
    folder,
    input,
    agent,
    secret,
    tool: toolFlag,
    model: modelFlag,
    answer: answerFlag,
    json: jsonFlag,
    verbose: verboseFlag,
  },
  ({ folder, input, ...flags }) => run(folder, input, flags),
).pipe(Command.withDescription('Run a workflow folder locally without a server'));
