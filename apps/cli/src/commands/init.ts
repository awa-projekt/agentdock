import { BUNDLED_HOST_PACKAGES, hostPackageDirectory, hostPackageVersions } from 'agentdock-sdk/workflows';
import * as Console from 'effect/Console';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import { cliError, messageOf } from '../errors';
import { writeJsonFile } from '../files';
import type { ProjectFile as ProjectFileType } from '../project';
import { AGENTS_DIR, PackageJson, PROJECT_FILE, ProjectFile, WORKFLOWS_DIR } from '../project';

const GITIGNORE_LINE = '.agentdock/';
const NODE_MODULES_LINE = 'node_modules/';

const api = Flag.String('api').pipe(Flag.optional, Flag.withDescription('API base URL to store in the project file'));

/**
 * The host packages at the platform's versions. Packages that ship with
 * agentdock rather than npm link to the host's own copy.
 */
const hostDevDependencies = Effect.gen(function* () {
  const bundled = yield* Effect.forEach(BUNDLED_HOST_PACKAGES, (name) =>
    Effect.map(hostPackageDirectory(name), (directory): readonly [string, string] => [name, `file:${directory}`]),
  );
  return { ...hostPackageVersions(), ...Object.fromEntries(bundled) };
}).pipe(Effect.mapError((error) => cliError(error.message)));

const init = (apiUrl: Option.Option<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = process.cwd();
    const projectFile = path.join(root, PROJECT_FILE);
    if (yield* fs.exists(projectFile)) return yield* cliError(`${PROJECT_FILE} already exists in ${root}.`);

    const config: ProjectFileType = Option.match(apiUrl, { onNone: () => ({}), onSome: (api) => ({ api }) });
    yield* writeJsonFile(ProjectFile, projectFile, config);
    for (const dir of [AGENTS_DIR, WORKFLOWS_DIR, '.agentdock']) {
      yield* fs.makeDirectory(path.join(root, dir), { recursive: true });
    }

    const packageJson = path.join(root, 'package.json');
    const wrotePackage = !(yield* fs.exists(packageJson));
    if (wrotePackage) {
      yield* writeJsonFile(PackageJson, packageJson, {
        name: path.basename(root),
        private: true,
        type: 'module',
        devDependencies: yield* hostDevDependencies,
      });
    }

    const gitignore = path.join(root, '.gitignore');
    const existing = (yield* fs.exists(gitignore)) ? yield* fs.readFileString(gitignore) : '';
    const lines = existing.split('\n').map((line) => line.trim());
    const additions = [
      ...(lines.includes(GITIGNORE_LINE) || lines.includes('.agentdock') ? [] : [GITIGNORE_LINE]),
      ...(lines.includes(NODE_MODULES_LINE) || lines.includes('node_modules') ? [] : [NODE_MODULES_LINE]),
    ];
    if (additions.length > 0) {
      const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
      yield* fs.writeFileString(gitignore, `${existing}${separator}${additions.join('\n')}\n`);
    }

    yield* Console.log(`Initialized agentdock project in ${root}.`);
    if (wrotePackage) {
      yield* Console.log(
        'Run `bun install` so workflow artifacts resolve the LangGraph packages the platform provides at the same versions.',
      );
    }
  }).pipe(
    Effect.catchTag('PlatformError', (error) =>
      Effect.fail(cliError(`Cannot initialize project: ${messageOf(error)}`)),
    ),
  );

export const initCommand = Command.make('init', { api }, ({ api }) => init(api)).pipe(
  Command.withDescription('Create an agentdock project in the current directory'),
);
