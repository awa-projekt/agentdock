import * as NodeCrypto from 'node:crypto';
import * as NodeModule from 'node:module';
import * as NodeURL from 'node:url';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import type { PlatformError } from 'effect/PlatformError';
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import {
  decodeWorkflowManifestTextEffect,
  manifestGraphLocation,
  WORKFLOW_MANIFEST_FILENAME,
  type WorkflowGraphLocation,
  type WorkflowManifest,
} from '../schemas';
import {
  type CompiledWorkflow,
  HOST_PROVIDED_PACKAGES,
  type HostProvidedPackage,
  type WorkflowContext,
  type WorkflowGraphExport,
} from './context';

export class WorkflowArtifactReadError extends Schema.TaggedError<WorkflowArtifactReadError>()(
  'WorkflowArtifactReadError',
  { message: Schema.String },
) {}

export class WorkflowArtifactDecodeError extends Schema.TaggedError<WorkflowArtifactDecodeError>()(
  'WorkflowArtifactDecodeError',
  { message: Schema.String },
) {}

export class WorkflowArtifactValidationError extends Schema.TaggedError<WorkflowArtifactValidationError>()(
  'WorkflowArtifactValidationError',
  { message: Schema.String, issues: Schema.Array(Schema.String) },
) {}

export type WorkflowArtifactError =
  | WorkflowArtifactReadError
  | WorkflowArtifactDecodeError
  | WorkflowArtifactValidationError;

const WorkflowPackageJson = Schema.Struct({
  name: Schema.optional(Schema.String),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export type WorkflowPackage = {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly hasLockfile: boolean;
};

export type LoadedWorkflowManifest = {
  /** Absolute path to the artifact folder. */
  readonly folder: string;
  readonly manifest: WorkflowManifest;
  readonly graph: WorkflowGraphLocation;
  readonly package: WorkflowPackage;
  /** SHA-256 over every source file in the folder (never `node_modules`), including the lockfile. */
  readonly sourceHash: string;
};

export const ARTIFACT_IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', '.turbo', '.agentdock']);

type ArtifactFs = FileSystem.FileSystem | Path.Path;

const sourceFiles = (folder: string): Effect.Effect<ReadonlyArray<string>, PlatformError, ArtifactFs> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const walk = (directory: string): Effect.Effect<ReadonlyArray<string>, PlatformError> =>
      fs.readDirectory(directory).pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(entries, (entry) => {
            const full = path.join(directory, entry);
            return fs.stat(full).pipe(
              Effect.flatMap((info): Effect.Effect<ReadonlyArray<string>, PlatformError> => {
                if (info.type === 'Directory') {
                  return ARTIFACT_IGNORED_DIRECTORIES.has(entry) ? Effect.succeed([]) : walk(full);
                }
                return Effect.succeed(info.type === 'File' ? [full] : []);
              }),
            );
          }),
        ),
        Effect.map((nested) => nested.flat()),
      );

    const files = yield* walk(folder);
    return files.map((file) => path.relative(folder, file)).sort((left, right) => left.localeCompare(right));
  });

/** Every source file in the folder, relative and sorted, so the hash is stable. */
export const artifactSourceFiles = (folder: string): Promise<ReadonlyArray<string>> =>
  Effect.runPromise(sourceFiles(folder).pipe(Effect.provide(NodeServices.layer)));

const hashFolder = (folder: string): Effect.Effect<string, PlatformError, ArtifactFs> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files = yield* sourceFiles(folder);
    const hash = NodeCrypto.createHash('sha256');
    for (const file of files) {
      hash.update(file);
      hash.update('\0');
      hash.update(yield* fs.readFile(path.join(folder, file)));
      hash.update('\0');
    }
    return hash.digest('hex');
  });

const decodePackageJson = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowPackageJson));
const decodeHostPackage = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }));

const readFailure = (path: string) => (): WorkflowArtifactReadError =>
  new WorkflowArtifactReadError({ message: `Cannot read '${path}'.` });

const readPackage = (folder: string): Effect.Effect<WorkflowPackage, WorkflowArtifactError, ArtifactFs> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packagePath = path.join(folder, 'package.json');
    if (!(yield* fs.exists(packagePath).pipe(Effect.mapError(readFailure(packagePath))))) {
      return yield* new WorkflowArtifactValidationError({
        message: `'${folder}' has no package.json. A workflow artifact declares its dependencies like any package.`,
        issues: ['missing package.json'],
      });
    }
    const text = yield* fs.readFileString(packagePath).pipe(Effect.mapError(readFailure(packagePath)));
    const parsed = yield* decodePackageJson(text).pipe(
      Effect.mapError(
        () => new WorkflowArtifactDecodeError({ message: `'${packagePath}' is not a valid package.json.` }),
      ),
    );
    const lockfilePath = path.join(folder, 'bun.lock');
    const hasLockfile = yield* fs.exists(lockfilePath).pipe(Effect.mapError(readFailure(lockfilePath)));
    return {
      dependencies: parsed.dependencies ?? {},
      peerDependencies: parsed.peerDependencies ?? {},
      hasLockfile,
    };
  });

/**
 * Host-provided packages must be peer dependencies: installing a second copy of
 * LangGraph inside the artifact breaks every `instanceof` the runtime relies on.
 */
const hostPackageIssues = (pkg: WorkflowPackage): ReadonlyArray<string> =>
  HOST_PROVIDED_PACKAGES.flatMap((name) => {
    const issues: Array<string> = [];
    if (name in pkg.dependencies)
      issues.push(
        `'${name}' must be a peerDependency: the host provides it, the artifact must not install its own copy`,
      );
    return issues;
  });

/**
 * Reads and validates an artifact folder without executing any of its code:
 * manifest, graph export location, package metadata, and the source hash.
 */
export const loadWorkflowManifest = (
  folderPath: string,
): Effect.Effect<LoadedWorkflowManifest, WorkflowArtifactError> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = path.isAbsolute(folderPath) ? folderPath : path.resolve(folderPath);
    const manifestPath = path.join(folder, WORKFLOW_MANIFEST_FILENAME);

    const manifestText = yield* fs.readFileString(manifestPath).pipe(
      Effect.mapError(
        () =>
          new WorkflowArtifactReadError({
            message: `Cannot read '${WORKFLOW_MANIFEST_FILENAME}' in '${folder}'.`,
          }),
      ),
    );

    const manifest = yield* decodeWorkflowManifestTextEffect(manifestText).pipe(
      Effect.mapError(
        (error) =>
          new WorkflowArtifactDecodeError({
            message: `'${manifestPath}' does not satisfy the workflow manifest contract: ${error.message}`,
          }),
      ),
    );

    const graph = manifestGraphLocation(manifest);
    const graphPath = path.join(folder, graph.module);
    if (!(yield* fs.exists(graphPath).pipe(Effect.mapError(readFailure(graphPath))))) {
      return yield* new WorkflowArtifactValidationError({
        message: `Graph module '${graph.module}' does not exist in '${folder}'.`,
        issues: [`missing graph module: ${graph.module}`],
      });
    }

    const pkg = yield* readPackage(folder);
    const packageIssues = hostPackageIssues(pkg);
    if (packageIssues.length > 0) {
      return yield* new WorkflowArtifactValidationError({
        message: `'${folder}' installs host-provided packages: ${packageIssues.join('; ')}`,
        issues: packageIssues,
      });
    }

    const sourceHash = yield* hashFolder(folder).pipe(
      Effect.mapError(() => new WorkflowArtifactReadError({ message: `Cannot hash artifact folder '${folder}'.` })),
    );

    return { folder, manifest, graph, package: pkg, sourceHash };
  }).pipe(Effect.provide(NodeServices.layer));

/**
 * A host-provided package installed inside the artifact would load a second
 * copy of LangGraph, and `instanceof` checks between the two silently fail.
 * Reported as a list so the caller can name every offender at once.
 */
const hostPackageConflicts = (folder: string): Effect.Effect<ReadonlyArray<string>, PlatformError, ArtifactFs> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const conflicts: Array<string> = [];
    for (const name of HOST_PROVIDED_PACKAGES) {
      const local = path.join(folder, 'node_modules', name);
      if (!(yield* fs.exists(local))) continue;
      const host = yield* hostPackageDirectory(name).pipe(Effect.orDie);
      if ((yield* fs.realPath(local)) !== (yield* fs.realPath(host))) conflicts.push(name);
    }
    return conflicts;
  });

/**
 * The folder of the copy of a host-provided package this runtime loads. Every
 * host package exports its `package.json`, which also locates a workspace
 * package that is not under any `node_modules`.
 */
export const hostPackageDirectory = (
  name: HostProvidedPackage,
): Effect.Effect<string, WorkflowArtifactReadError, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const manifest = yield* Effect.try({
      try: () => NodeModule.createRequire(import.meta.url).resolve(`${name}/package.json`),
      catch: () => new WorkflowArtifactReadError({ message: `Cannot locate the host's installed copy of '${name}'.` }),
    });
    return path.dirname(manifest);
  });

/** The versions of the host-provided packages this runtime loaded, as an artifact should declare them. */
export const hostPackageVersions = () => {
  const require = NodeModule.createRequire(import.meta.url);
  const range = (name: string): string => `^${decodeHostPackage(require(`${name}/package.json`)).version}`;
  return Object.fromEntries(HOST_PROVIDED_PACKAGES.map((name) => [name, range(name)]));
};

/**
 * A compiled LangGraph is a live object graph, not data, so the artifact's
 * export is refined by the methods the host drives rather than decoded.
 */
const isCompiledWorkflow: Predicate.Refinement<unknown, CompiledWorkflow> = (value): value is CompiledWorkflow =>
  Predicate.hasProperty(value, 'stream') &&
  Predicate.isFunction(value.stream) &&
  Predicate.hasProperty(value, 'getState') &&
  Predicate.isFunction(value.getState) &&
  Predicate.hasProperty(value, 'getGraphAsync') &&
  Predicate.isFunction(value.getGraphAsync);

/**
 * Imports the manifest's graph export and returns the compiled graph.
 *
 * Artifact code runs in this process with its privileges; the registry is the
 * trust boundary. The query string ties the module instance to the source
 * hash, and `attempt` lets a caller retry past Node's cache of a failed import.
 */
export const importWorkflowGraph = (
  loaded: LoadedWorkflowManifest,
  runtime: { readonly context?: WorkflowContext } = {},
  attempt = 0,
): Effect.Effect<CompiledWorkflow, WorkflowArtifactError> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const conflicts = yield* hostPackageConflicts(loaded.folder).pipe(
      Effect.mapError(
        () => new WorkflowArtifactReadError({ message: `Cannot inspect node_modules of '${loaded.folder}'.` }),
      ),
    );
    if (conflicts.length > 0) {
      return yield* new WorkflowArtifactValidationError({
        message:
          `'${loaded.folder}' has its own copy of ${conflicts.join(', ')} under node_modules. ` +
          "Host-provided packages must resolve to the host's copy: run 'bun install --omit=peer' in the artifact.",
        issues: conflicts.map((name) => `duplicate host package: ${name}`),
      });
    }
    const modulePath = path.join(loaded.folder, loaded.graph.module);
    const moduleUrl = `${NodeURL.pathToFileURL(modulePath).href}?hash=${loaded.sourceHash}${attempt ? `&attempt=${attempt}` : ''}`;

    const imported = yield* Effect.tryPromise({
      // SAFETY: a dynamic import's shape is unknowable statically; the named
      // export is refined by `isCompiledWorkflow` below before it is used.
      try: (): Promise<Readonly<Record<string, WorkflowGraphExport | undefined>>> =>
        import(moduleUrl) as Promise<Record<string, WorkflowGraphExport | undefined>>,
      catch: (error) =>
        new WorkflowArtifactReadError({
          message: `Cannot import workflow module '${modulePath}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
    });

    const exported = imported[loaded.graph.exportName];
    if (exported === undefined) {
      return yield* new WorkflowArtifactValidationError({
        message: `'${loaded.graph.module}' has no export named '${loaded.graph.exportName}'.`,
        issues: [`missing export: ${loaded.graph.exportName}`],
      });
    }

    const compiled = yield* Effect.tryPromise({
      try: async (): Promise<CompiledWorkflow> => (Predicate.isFunction(exported) ? exported(runtime) : exported),
      catch: (error) =>
        new WorkflowArtifactValidationError({
          message: `Workflow graph factory threw: ${error instanceof Error ? error.message : String(error)}`,
          issues: ['graph factory threw'],
        }),
    });

    if (!isCompiledWorkflow(compiled)) {
      return yield* new WorkflowArtifactValidationError({
        message: `Export '${loaded.graph.exportName}' of '${loaded.graph.module}' is not a compiled LangGraph.`,
        issues: ['export is not a compiled graph'],
      });
    }

    if (compiled.checkpointer !== undefined && compiled.checkpointer !== false) {
      return yield* new WorkflowArtifactValidationError({
        message:
          'Compile the workflow without a checkpointer. The platform injects its durable checkpointer at run time.',
        issues: ['graph compiled with its own checkpointer'],
      });
    }

    return compiled;
  }).pipe(Effect.provide(NodeServices.layer));
