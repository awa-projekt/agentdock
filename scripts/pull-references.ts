import * as NodeURL from 'node:url';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Console from 'effect/Console';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';

const REFERENCE_DIR = NodeURL.fileURLToPath(new URL('../.references', import.meta.url));

const repos = [
  { name: 'effect', url: 'https://github.com/Effect-TS/effect-smol.git' },
  { name: 'effect-atom', url: 'https://github.com/tim-smart/effect-atom.git' },
  { name: 'opencode', url: 'https://github.com/anomalyco/opencode.git' },
  { name: 't3code', url: 'https://github.com/pingdotgg/t3code.git' },
  {
    name: 'tanstack-router',
    url: 'https://github.com/TanStack/router.git',
  },
];

class GitCommandError extends Data.TaggedError('GitCommandError')<{
  readonly args: ReadonlyArray<string>;
  readonly exitCode: number;
}> {
  override get message(): string {
    return `git ${this.args.join(' ')} exited with code ${this.exitCode}`;
  }
}

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const git = (args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const exitCode = yield* spawner.exitCode(ChildProcess.make('git', args, { stdout: 'ignore', stderr: 'ignore' }));
      if (exitCode !== 0) return yield* new GitCommandError({ args, exitCode });
    });

  yield* fs.makeDirectory(REFERENCE_DIR, { recursive: true });

  for (const repo of repos) {
    const dest = path.join(REFERENCE_DIR, repo.name);
    if (yield* fs.exists(dest)) {
      yield* Console.log(`Pulling ${repo.name}...`);
      yield* git(['-C', dest, 'pull', '--ff-only']);
    } else {
      yield* Console.log(`Cloning ${repo.name}...`);
      yield* git(['clone', '--depth', '1', repo.url, dest]);
    }
    yield* Console.log(`  ✓ ${repo.name}`);
  }
});

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
