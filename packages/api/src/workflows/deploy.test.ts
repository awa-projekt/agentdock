import * as NodeServices from '@effect/platform-node/NodeServices';
import { expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';
import * as Schema from 'effect/Schema';
import { deployWorkflowFiles, readArtifactFiles } from './deploy';

const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const GRAPH = `
import { entrypoint } from '@langchain/langgraph';
export default entrypoint('test', async (input) => input);
`;

const sources = (folder: string, answer: string, patterns = '^0.1.0') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(
      path.join(folder, 'agentdock.workflow.json'),
      encodeJsonString({ name: 'Test', description: 'Test', version: '1', graph: './workflow.mjs:default' }),
    );
    yield* fs.writeFileString(
      path.join(folder, 'package.json'),
      encodeJsonString({
        name: 'deploy-test',
        type: 'module',
        peerDependencies: { '@langchain/langgraph': '^1.4.0', 'agentdock-patterns': patterns },
        // Not on the npm registry: optional, so the install records it without fetching it.
        peerDependenciesMeta: { 'agentdock-patterns': { optional: true } },
      }),
    );
    yield* fs.writeFileString(path.join(folder, 'workflow.mjs'), GRAPH);
    yield* fs.writeFileString(path.join(folder, 'prompt.md'), answer);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* spawner.exitCode(ChildProcess.make('bun', ['install', '--silent'], { cwd: folder }));
    return yield* readArtifactFiles(folder);
  });

const tempDirectory = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.makeTempDirectoryScoped({ directory: path.resolve('.'), prefix });
  });

it.effect(
  'installs uploaded sources into an immutable content-addressed folder with host package links',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = yield* tempDirectory('.deploy-test-');
      const artifacts = yield* tempDirectory('.artifact-test-');

      const first = yield* deployWorkflowFiles(yield* sources(source, 'original prompt'), artifacts);
      const second = yield* deployWorkflowFiles(yield* sources(source, 'changed prompt'), artifacts);

      expect(second.sourceHash).not.toBe(first.sourceHash);
      expect(first.folder).toBe(path.join(artifacts, first.sourceHash));
      expect(yield* fs.readFileString(path.join(first.folder, 'prompt.md'))).toBe('original prompt');
      expect(first.package.hasLockfile).toBe(true);
      // `readLink` resolves only for a symbolic link, which is what the host package links must be.
      expect(yield* fs.readLink(path.join(artifacts, 'node_modules', '@langchain', 'langgraph'))).toContain(
        'langgraph',
      );
      // A workspace package ships with the host rather than npm and links the same way.
      expect(yield* fs.readLink(path.join(artifacts, 'node_modules', 'agentdock-patterns'))).toContain('patterns');
      expect((yield* readArtifactFiles(first.folder)).map((file) => file.path)).toContain('bun.lock');
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  'refuses a host package range this host cannot satisfy',
  () =>
    Effect.gen(function* () {
      const source = yield* tempDirectory('.deploy-test-');
      const artifacts = yield* tempDirectory('.artifact-test-');

      const error = yield* Effect.flip(deployWorkflowFiles(yield* sources(source, 'prompt', '^9.0.0'), artifacts));

      expect(error.message).toContain('needs agentdock-patterns@^9.0.0 but this host provides 0.1.0');
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect('refuses sources without a lockfile', () =>
  Effect.gen(function* () {
    const artifacts = yield* tempDirectory('.artifact-test-');
    const files = [
      {
        path: 'agentdock.workflow.json',
        content: Buffer.from(
          encodeJsonString({ name: 'T', description: 'T', version: '1', graph: './w.mjs:default' }),
        ).toString('base64'),
      },
      { path: 'package.json', content: Buffer.from('{"name":"t","type":"module"}').toString('base64') },
      { path: 'w.mjs', content: Buffer.from(GRAPH).toString('base64') },
    ];
    const error = yield* Effect.flip(deployWorkflowFiles(files, artifacts));
    expect(error.message).toContain('bun.lock');
  }).pipe(Effect.provide(NodeServices.layer)),
);
