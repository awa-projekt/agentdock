import * as NodeCrypto from 'node:crypto';
import * as NodeServices from '@effect/platform-node/NodeServices';
import type { WorkflowArtifactFile } from 'agentdock-sdk/schemas';
import {
  ARTIFACT_IGNORED_DIRECTORIES,
  artifactSourceFiles,
  HOST_PROVIDED_PACKAGES,
  type HostProvidedPackage,
  hostPackageDirectory,
  type LoadedWorkflowManifest,
  loadWorkflowManifest,
} from 'agentdock-sdk/workflows';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import type * as PlatformError from 'effect/PlatformError';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { satisfies } from 'semver';

const hash = (bytes: Uint8Array | string): string => NodeCrypto.createHash('sha256').update(bytes).digest('hex');

const DEFAULT_ARTIFACT_ROOT = '.agentdock/artifacts';

export class WorkflowDeployError extends Schema.TaggedError<WorkflowDeployError>()('WorkflowDeployError', {
  message: Schema.String,
}) {}
const isWorkflowDeployError = Schema.is(WorkflowDeployError);

const PackageVersion = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));
const decodePackageVersion = Schema.decodeUnknownSync(PackageVersion);

/** Deployment is host-local by definition, so the Node services back every file and process access here. */
const onHost = <A>(
  effect: Effect.Effect<A, WorkflowDeployError | PlatformError.PlatformError, NodeServices.NodeServices>,
): Effect.Effect<A, WorkflowDeployError> =>
  effect.pipe(
    Effect.mapError((error) =>
      isWorkflowDeployError(error) ? error : new WorkflowDeployError({ message: error.message }),
    ),
    Effect.provide(NodeServices.layer),
  );

const loadManifest = (folder: string) =>
  loadWorkflowManifest(folder).pipe(Effect.mapError((error) => new WorkflowDeployError({ message: error.message })));

/** The host's installed copy of a shared package; a workspace package such as `agentdock-patterns` included. */
const hostPackage = (name: HostProvidedPackage) =>
  hostPackageDirectory(name).pipe(Effect.mapError((error) => new WorkflowDeployError({ message: error.message })));

const hostPackageVersion = (name: HostProvidedPackage) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* hostPackage(name);
    return decodePackageVersion(yield* fs.readFileString(path.join(directory, 'package.json'))).version;
  });

const linkHostPackages = (artifactRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const name of HOST_PROVIDED_PACKAGES) {
      const link = path.join(artifactRoot, 'node_modules', name);
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      yield* fs.remove(link, { recursive: true, force: true });
      yield* fs.symlink(yield* hostPackage(name), link);
    }
  });

/**
 * Artifacts resolve host-provided packages through symlinks in the artifact
 * root's `node_modules`, so every artifact shares the host's single instance.
 * Idempotent; called before every deploy and at startup.
 */
export const ensureHostPackageLinks = (
  artifactRoot: string = DEFAULT_ARTIFACT_ROOT,
): Effect.Effect<void, WorkflowDeployError> =>
  onHost(Effect.flatMap(Effect.service(Path.Path), (path) => linkHostPackages(path.resolve(artifactRoot))));

const safeArtifactPath = (candidate: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const normalized = path.normalize(candidate);
    const [head] = normalized.split(/[\\/]/);
    if (path.isAbsolute(normalized) || normalized.startsWith('..') || !head || ARTIFACT_IGNORED_DIRECTORIES.has(head)) {
      return yield* new WorkflowDeployError({ message: `Artifact file path '${candidate}' is not allowed.` });
    }
    return normalized;
  });

const checkHostPackageRanges = (loaded: LoadedWorkflowManifest) =>
  Effect.gen(function* () {
    if (!loaded.package.peerDependencies['@langchain/langgraph']) {
      return yield* new WorkflowDeployError({
        message: `'${loaded.manifest.name}' must declare '@langchain/langgraph' as a peerDependency so the host can check its version.`,
      });
    }
    for (const name of HOST_PROVIDED_PACKAGES) {
      const range = loaded.package.peerDependencies[name];
      if (!range) continue;
      const installed = yield* hostPackageVersion(name);
      if (!satisfies(installed, range)) {
        return yield* new WorkflowDeployError({
          message: `'${loaded.manifest.name}' needs ${name}@${range} but this host provides ${installed}.`,
        });
      }
    }
  });

const installDependencies = (folder: string) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(
      'bun',
      ['install', '--frozen-lockfile', '--production', '--omit=peer', '--ignore-scripts', '--silent'],
      { cwd: folder, env: { CI: '1' }, extendEnv: true },
    );
    const [, stderr, exitCode] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode,
      ],
      { concurrency: 3 },
    );
    if (exitCode !== 0) {
      return yield* new WorkflowDeployError({
        message: `Installing artifact dependencies failed: ${stderr.trim()}`,
      });
    }
  }).pipe(Effect.scoped);

/**
 * Deploys uploaded artifact sources into an immutable, content-addressed folder:
 * write, validate, install the artifact's own dependencies from its lockfile,
 * then move into place under its source hash. Two uploads of identical sources
 * share one folder.
 */
export const deployWorkflowFiles = (
  files: ReadonlyArray<WorkflowArtifactFile>,
  artifactRoot: string = DEFAULT_ARTIFACT_ROOT,
): Effect.Effect<LoadedWorkflowManifest, WorkflowDeployError> =>
  onHost(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.resolve(artifactRoot);
      yield* fs.makeDirectory(root, { recursive: true });
      yield* linkHostPackages(root);
      const staging = yield* fs.makeTempDirectory({ directory: root, prefix: '.staging-' });
      return yield* Effect.gen(function* () {
        for (const file of files) {
          const target = path.join(staging, yield* safeArtifactPath(file.path));
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* fs.writeFile(target, Buffer.from(file.content, 'base64'));
        }
        const loaded = yield* loadManifest(staging);
        if (!loaded.package.hasLockfile) {
          return yield* new WorkflowDeployError({
            message: `'${loaded.manifest.name}' has no bun.lock. Run 'bun install' in the artifact and upload the lockfile.`,
          });
        }
        yield* checkHostPackageRanges(loaded);
        yield* installDependencies(staging);

        // A failing rename means another deploy of identical sources already produced this folder.
        yield* Effect.ignore(fs.rename(staging, path.join(root, loaded.sourceHash)));
        return yield* loadManifest(path.join(root, loaded.sourceHash));
      }).pipe(Effect.ensuring(Effect.ignore(fs.remove(staging, { recursive: true, force: true }))));
    }),
  );

/** Reads a deployed artifact's sources back, for pulling it into a local project. */
export const readArtifactFiles = (
  folder: string,
): Effect.Effect<ReadonlyArray<WorkflowArtifactFile>, WorkflowDeployError> =>
  onHost(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const paths = yield* Effect.promise(() => artifactSourceFiles(folder));
      return yield* Effect.forEach(paths, (relativePath) =>
        Effect.map(fs.readFile(path.join(folder, relativePath)), (content) => ({
          path: relativePath,
          content: Buffer.from(content).toString('base64'),
        })),
      );
    }),
  );

export const runtimeFingerprint: Effect.Effect<string, WorkflowDeployError> = onHost(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dirname, '../../../..');
    const sourceRoots = [
      'packages/sdk/src',
      'packages/patterns/src',
      'packages/api/src',
      'packages/db/src',
      'apps/server/src',
    ];
    const groups = yield* Effect.forEach(sourceRoots, (directory) =>
      Effect.map(fs.readDirectory(path.join(root, directory), { recursive: true }), (entries) =>
        entries
          .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
          .filter((entry) => !entry.split('/').some((part) => part.startsWith('.')))
          .map((entry) => path.join(root, directory, entry)),
      ),
    );
    const sources = groups.flat().sort();
    const content = yield* Effect.forEach(sources, (file) =>
      Effect.map(fs.readFile(file), (bytes) =>
        Buffer.concat([Buffer.from(`${path.relative(root, file)}\0`), bytes, Buffer.from('\0')]),
      ),
    );
    const lock = yield* fs.readFile(path.join(root, 'bun.lock'));
    return hash(Buffer.concat([Buffer.from(process.versions.node), lock, ...content]));
  }),
);
