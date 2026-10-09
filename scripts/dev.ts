import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import * as Path from 'effect/Path';
import * as ChildProcess from 'effect/process/ChildProcess';
import { localUrl } from '../packages/sdk/src/config.ts';
import { ports } from '../packages/sdk/src/ports.ts';

const localPorts = ports();

const childEnv = {
  AGENTDOCK_PORT_BASE: String(localPorts.api),
};

const server = (name: string, entrypoint: string, nodeEnv: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const handle = yield* ChildProcess.make(
      process.execPath,
      [
        '--watch',
        '--no-warnings=ExperimentalWarning',
        '--import',
        'tsx',
        path.resolve(import.meta.dirname, '..', entrypoint),
      ],
      {
        env: { ...childEnv, NODE_ENV: nodeEnv },
        extendEnv: true,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    const exitCode = yield* handle.exitCode;
    yield* Console.log(`[dev] ${name} exited with code ${exitCode}`);
  }).pipe(Effect.scoped);

const main = Effect.gen(function* () {
  yield* Console.log(`[dev] api ${localUrl(localPorts.api)}`);
  yield* Console.log(`[dev] web ${localUrl(localPorts.web)}`);
  yield* Effect.race(
    server('api', 'apps/server/src/index.ts', 'development'),
    server('web', 'apps/web/src/index.ts', 'development'),
  );
});

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
