import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Console from 'effect/Console';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { ApiLive } from './api';
import { loginCommand, logoutCommand, whoamiCommand } from './commands/auth';
import { checkCommand } from './commands/check';
import { initCommand } from './commands/init';
import { invokeCommand } from './commands/invoke';
import { agentsCommand, workflowsCommand } from './commands/list';
import { newCommand } from './commands/new';
import { pullCommand } from './commands/pull';
import { pushCommand } from './commands/push';
import { runCommand } from './commands/run';
import { runsCommand } from './commands/runs';
import { sendCommand } from './commands/send';
import { statusCommand } from './commands/status';
import { commandSpan, flushTraces, TelemetryLive } from './telemetry';

const command = Command.make('agentdock', {}).pipe(
  Command.withDescription('Agentdock CLI'),
  Command.withSubcommands([
    loginCommand,
    logoutCommand,
    whoamiCommand,
    initCommand,
    pullCommand,
    pushCommand,
    statusCommand,
    newCommand,
    checkCommand,
    runCommand,
    agentsCommand,
    workflowsCommand,
    invokeCommand,
    runsCommand,
    sendCommand,
  ]),
);

// Undici rather than `FetchHttpClient`: node's `fetch` rejects the
// `content-length` header `HttpClientRequest` sets on a body, so POSTs fail.
const platform = Layer.merge(NodeHttpClient.layerUndici, NodeServices.layer);

const exitWithFailure = (): void => {
  process.exit(1);
};

const failWithMessage = (message: string) =>
  Console.error(message).pipe(Effect.andThen(flushTraces), Effect.andThen(Effect.sync(exitWithFailure)));

Command.run(command, { version: '0.1.0' }).pipe(
  commandSpan(process.argv.slice(2)),
  Effect.catchTag(['CliError', 'ApiError'], (error) => failWithMessage(error.message)),
  Effect.provide(Layer.merge(Layer.provideMerge(ApiLive, platform), TelemetryLive)),
  NodeRuntime.runMain,
);
