import { apiBaseUrlFromEnv, normalizeBaseUrl } from 'agentdock-sdk/config';
import type { AgentConfig as AgentConfigType } from 'agentdock-sdk/schemas';
import { AgentConfig, type AgentRecord } from 'agentdock-sdk/schemas';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import * as Schema from 'effect/Schema';
import YAML from 'yaml';
import { type CliError, cliError, messageOf } from './errors';
import { type FileServices, readJsonFile, writeJsonFile, writeTextFile } from './files';

export const PROJECT_FILE = 'agentdock.project.json';
const STATE_FILE = '.agentdock/state.json';
export const AGENTS_DIR = 'agents';
export const WORKFLOWS_DIR = 'workflows';
export const AGENT_FILE_SUFFIX = '.agent.yaml';

export const ProjectFile = Schema.Struct({ api: Schema.optional(Schema.String) });

const Tracked = Schema.Struct({ id: Schema.String, revision: Schema.Number });
export const StateFile = Schema.Struct({
  agents: Schema.Record(Schema.String, Tracked),
  workflows: Schema.Record(Schema.String, Tracked),
});
export type StateFile = Schema.Schema.Type<typeof StateFile>;
const emptyState: StateFile = { agents: {}, workflows: {} };

export type ProjectFile = Schema.Schema.Type<typeof ProjectFile>;

const PackageVersions = Schema.Record(Schema.String, Schema.String);
export const PackageJson = Schema.Struct({
  name: Schema.String,
  private: Schema.Boolean,
  type: Schema.Literal('module'),
  dependencies: Schema.optional(PackageVersions),
  devDependencies: Schema.optional(PackageVersions),
  peerDependencies: Schema.optional(PackageVersions),
  peerDependenciesMeta: Schema.optional(Schema.Record(Schema.String, Schema.Struct({ optional: Schema.Boolean }))),
});
export type PackageJson = Schema.Schema.Type<typeof PackageJson>;

export type Project = { readonly root: string; readonly api: string };

export const slugify = (name: string): string =>
  name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

export const findProject: Effect.Effect<Option.Option<Project>, CliError, FileServices> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let dir = path.resolve(process.cwd());
  while (true) {
    const file = path.join(dir, PROJECT_FILE);
    if (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))) {
      const config = Option.getOrElse(yield* readJsonFile(ProjectFile, file), (): ProjectFile => ({}));
      return Option.some({ root: dir, api: normalizeBaseUrl(config.api ?? apiBaseUrlFromEnv()) });
    }
    const parent = path.dirname(dir);
    if (parent === dir) return Option.none();
    dir = parent;
  }
});

export const requireProject: Effect.Effect<Project, CliError, FileServices> = Effect.flatMap(findProject, (project) =>
  Option.match(project, {
    onNone: () =>
      Effect.fail(cliError(`Not inside an agentdock project (no ${PROJECT_FILE} found). Run 'init' first.`)),
    onSome: Effect.succeed,
  }),
);

export const resolveApiBaseUrl: Effect.Effect<string, CliError, FileServices> = Effect.map(findProject, (project) =>
  Option.match(project, { onNone: () => normalizeBaseUrl(apiBaseUrlFromEnv()), onSome: (found) => found.api }),
);

/** An optional environment setting; a provider failure is reported rather than read as an absent value. */
export const optionalSetting = (name: string): Effect.Effect<Option.Option<string>, CliError> =>
  Config.option(Config.String(name)).pipe(
    Effect.mapError((error) => cliError(`Cannot read setting '${name}': ${error.message}`)),
  );

export const readState = (project: Project): Effect.Effect<StateFile, CliError, FileServices> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const state = yield* readJsonFile(StateFile, path.join(project.root, STATE_FILE));
    return Option.getOrElse(state, () => emptyState);
  });

export const writeState = (project: Project, state: StateFile): Effect.Effect<void, CliError, FileServices> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* writeJsonFile(StateFile, path.join(project.root, STATE_FILE), state);
  });

export type LocalAgent = { readonly slug: string; readonly file: string; readonly config: AgentConfigType };

const decodeAgentConfig = Schema.decodeUnknownEffect(AgentConfig);
const encodeAgentConfig = Schema.encodeSync(AgentConfig);

/** The authoring fields of a record, with absent contracts spelled as `null` so files and comparisons are stable. */
export const agentConfigOf = (agent: AgentRecord | AgentConfigType): AgentConfigType => ({
  name: agent.name,
  description: agent.description,
  color: agent.color,
  instructions: agent.instructions,
  model: agent.model,
  reasoningEffort: agent.reasoningEffort ?? null,
  version: agent.version,
  integrations: agent.integrations,
  skills: agent.skills,
  communication: agent.communication,
  capabilities: agent.capabilities,
  defaultInputModes: agent.defaultInputModes,
  defaultOutputModes: agent.defaultOutputModes,
  inputContract: agent.inputContract ?? null,
  outputContract: agent.outputContract ?? null,
});

export const agentConfigJson = (config: AgentConfigType): string =>
  JSON.stringify(encodeAgentConfig(agentConfigOf(config)));

export const readAgentConfigFile = (file: string): Effect.Effect<AgentConfigType, CliError, FileServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file);
    const parsed = yield* Effect.try({ try: () => YAML.parse(text), catch: (error) => cliError(messageOf(error)) });
    return yield* decodeAgentConfig(parsed);
  }).pipe(Effect.mapError((error) => cliError(`Cannot read agent file '${file}': ${messageOf(error)}`)));

const agentFilePath = (project: Project, slug: string): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(project.root, AGENTS_DIR, `${slug}${AGENT_FILE_SUFFIX}`);
  });

export const readLocalAgents = (project: Project): Effect.Effect<ReadonlyArray<LocalAgent>, CliError, FileServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(project.root, AGENTS_DIR);
    if (!(yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false)))) return [];
    const entries = yield* fs
      .readDirectory(dir)
      .pipe(Effect.mapError((error) => cliError(`Cannot list '${dir}': ${messageOf(error)}`)));
    const files = entries.filter((entry) => entry.endsWith(AGENT_FILE_SUFFIX)).sort();
    return yield* Effect.forEach(files, (entry) =>
      Effect.map(readAgentConfigFile(path.join(dir, entry)), (config) => ({
        slug: entry.slice(0, -AGENT_FILE_SUFFIX.length),
        file: path.join(dir, entry),
        config,
      })),
    );
  });

export const writeLocalAgent = (
  project: Project,
  config: AgentConfigType,
): Effect.Effect<string, CliError, FileServices> =>
  Effect.gen(function* () {
    const slug = slugify(config.name);
    const file = yield* agentFilePath(project, slug);
    yield* writeTextFile(file, YAML.stringify(encodeAgentConfig(agentConfigOf(config))));
    return slug;
  });

export type LocalWorkflow = { readonly slug: string; readonly folder: string };

export const localWorkflowFolders = (
  project: Project,
): Effect.Effect<ReadonlyArray<LocalWorkflow>, CliError, FileServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(project.root, WORKFLOWS_DIR);
    if (!(yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false)))) return [];
    const entries = yield* fs
      .readDirectory(dir)
      .pipe(Effect.mapError((error) => cliError(`Cannot list '${dir}': ${messageOf(error)}`)));
    const folders = yield* Effect.forEach(entries.sort(), (entry) =>
      Effect.gen(function* () {
        const folder = path.join(dir, entry);
        const isWorkflow = yield* fs
          .exists(path.join(folder, 'agentdock.workflow.json'))
          .pipe(Effect.orElseSucceed(() => false));
        return isWorkflow ? [{ slug: entry, folder }] : [];
      }),
    );
    return folders.flat();
  });

export const workflowFolderPath = (project: Project, slug: string): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(project.root, WORKFLOWS_DIR, slug);
  });

/** `names` filters by slug or display name; an empty selection means everything. */
export const selects = (names: ReadonlyArray<string>, slug: string, name: string): boolean =>
  names.length === 0 || names.includes(slug) || names.includes(name);
