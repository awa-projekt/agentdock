import * as NodeModule from 'node:module';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import type * as PlatformError from 'effect/PlatformError';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';

const oxlintPackageJson = NodeModule.createRequire(import.meta.url).resolve('oxlint/package.json');
const pluginPath = new URL('../index.ts', import.meta.url).pathname;

const OxlintConfig = Schema.Struct({
  jsPlugins: Schema.Array(Schema.Struct({ name: Schema.String, specifier: Schema.String })),
  rules: Schema.Record(Schema.String, Schema.Literal('error')),
});
const encodeOxlintConfig = Schema.encodeEffect(Schema.fromJsonString(OxlintConfig));

export class OxlintFixtureFailure extends Schema.TaggedError<OxlintFixtureFailure>()('OxlintFixtureFailure', {
  exitCode: Schema.Number,
  output: Schema.String,
}) {}
const isFixtureFailure = Schema.is(OxlintFixtureFailure);

export class OxlintFixturePassed extends Schema.TaggedError<OxlintFixturePassed>()('OxlintFixturePassed', {
  ruleName: Schema.String,
}) {
  override get message(): string {
    return `Expected oxlint to report ${this.ruleName}, but the fixture passed.`;
  }
}

type FixtureEffect<A, E> = Effect.Effect<
  A,
  E | PlatformError.PlatformError | Schema.SchemaError,
  NodeServices.NodeServices
>;

interface RuleHarness {
  readonly valid: (name: string, source: string) => void;
  readonly invalid: (name: string, source: string, assertion?: (output: string) => void) => void;
}

/** Lints one fixture with the real oxlint binary and only the rule under test enabled. */
export const oxlintRuleHarness = (ruleName: string, options: { readonly filename?: string } = {}): RuleHarness => {
  const [pluginName, shortName] = ruleName.split('/');
  const diagnosticPattern = new RegExp(`${pluginName}\\(${shortName}\\)`);
  const test = it.layer(NodeServices.layer);

  const lint = (source: string): FixtureEffect<string, OxlintFixtureFailure> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixtureDir = yield* fs.makeTempDirectoryScoped({ prefix: 'agentdock-oxlint-' });
      const configPath = path.join(fixtureDir, '.oxlintrc.json');
      const sourcePath = path.join(fixtureDir, options.filename ?? 'fixture.ts');
      const oxlintBin = path.join(path.dirname(oxlintPackageJson), 'bin', 'oxlint');

      yield* fs.writeFileString(
        configPath,
        yield* encodeOxlintConfig({
          jsPlugins: [{ name: pluginName ?? ruleName, specifier: pluginPath }],
          rules: { [ruleName]: 'error' },
        }),
      );
      yield* fs.writeFileString(sourcePath, source);

      const handle = yield* ChildProcess.make(process.execPath, [oxlintBin, '--config', configPath, sourcePath]);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: 'unbounded' },
      );
      const output = `${stdout}${stderr}`;
      if (exitCode !== 0) return yield* new OxlintFixtureFailure({ exitCode: Number(exitCode), output });
      return output;
    }).pipe(Effect.scoped);

  const lintExpectingFailure = (source: string): FixtureEffect<string, OxlintFixturePassed> =>
    lint(source).pipe(
      Effect.matchEffect({
        onFailure: (error) => (isFixtureFailure(error) ? Effect.succeed(error.output) : Effect.fail(error)),
        onSuccess: () => Effect.fail(new OxlintFixturePassed({ ruleName })),
      }),
    );

  return {
    valid(name, source) {
      test(name, (it) => {
        it.effect('passes', () => lint(source));
      });
    },
    invalid(name, source, assertion) {
      test(name, (it) => {
        it.effect('reports the rule diagnostic', () =>
          lintExpectingFailure(source).pipe(
            Effect.tap((output) =>
              Effect.sync(() => {
                assert.match(output, diagnosticPattern);
                assertion?.(output);
              }),
            ),
          ),
        );
      });
    },
  };
};
