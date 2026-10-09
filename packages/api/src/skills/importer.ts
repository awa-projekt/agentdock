import * as NodeServices from '@effect/platform-node/NodeServices';
import { PullSkillsInput, type Skill } from 'agentdock-sdk/schemas';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { SkillParser } from './parser';

type SkillImporterService = {
  readonly pull: (input: PullSkillsInput) => Effect.Effect<ReadonlyArray<Skill>, SkillImporterError>;
};

export class SkillImporterError extends Schema.TaggedError<SkillImporterError>()('SkillImporterError', {
  cause: Schema.Defect(),
}) {}

const decodePullSkillsInput = Schema.decodeUnknownSync(PullSkillsInput);
const toSkillImporterError = (cause: unknown): SkillImporterError => new SkillImporterError({ cause });

/** `rg --files` lists SKILL.md anywhere under the pulled tree, including hidden and ignored folders. */
const findSkillFiles = (directory: string) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make('rg', ['--files', '--hidden', '--no-ignore', '-g', 'SKILL.md', directory]);
    const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout));
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }).pipe(Effect.scoped);

const installSkills = (directory: string, source: string, skills: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const args = ['skills', 'add', source, '--global', '-a', 'universal', '--copy', '-y'];
    for (const skill of skills) args.push('--skill', skill);
    if (skills.length === 0) args.push('--skill', '*');
    const handle = yield* ChildProcess.make('npx', args, {
      cwd: directory,
      env: { HOME: directory, DISABLE_TELEMETRY: '1' },
      extendEnv: true,
    });
    const [, stderr, exitCode] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode,
      ],
      { concurrency: 3 },
    );
    if (exitCode !== 0) {
      return yield* new SkillImporterError({ cause: `Pulling skills from '${source}' failed: ${stderr.trim()}` });
    }
  }).pipe(Effect.scoped);

export const SkillImporter = Context.Service<SkillImporterService>('@agentdock/api/SkillImporter');

export const SkillImporterLive = Layer.effect(
  SkillImporter,
  Effect.gen(function* () {
    const parser = yield* SkillParser;

    return SkillImporter.of({
      pull: Effect.fn('SkillImporter.pull')(
        function* (input) {
          const validated = decodePullSkillsInput(input);
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'agentdock-skills-' });
          yield* installSkills(directory, validated.source, validated.skills);
          const files = yield* findSkillFiles(directory);
          const imported: Array<Skill> = [];
          for (const file of files) {
            const content = yield* fs.readFileString(file);
            imported.push(yield* parser.parse({ content, source: validated.source }));
          }
          return imported;
        },
        (effect) =>
          effect.pipe(Effect.scoped, Effect.mapError(toSkillImporterError), Effect.provide(NodeServices.layer)),
      ),
    });
  }),
);
