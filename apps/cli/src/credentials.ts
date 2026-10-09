import * as NodeOS from 'node:os';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import * as Schema from 'effect/Schema';
import type { CliError } from './errors';
import { type FileServices, readJsonFile, writeJsonFile } from './files';
import { optionalSetting } from './project';

const Credentials = Schema.Record(Schema.String, Schema.Struct({ accessToken: Schema.String }));
type Credentials = Schema.Schema.Type<typeof Credentials>;

const credentialsFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  const configHome = Option.getOrElse(yield* optionalSetting('XDG_CONFIG_HOME'), () =>
    path.join(NodeOS.homedir(), '.config'),
  );
  return path.join(configHome, 'agentdock', 'credentials.json');
});

const readCredentials: Effect.Effect<Credentials, CliError, FileServices> = Effect.gen(function* () {
  const file = yield* credentialsFile;
  return Option.getOrElse(yield* readJsonFile(Credentials, file), (): Credentials => ({}));
});

export const readToken = (baseUrl: string): Effect.Effect<string | undefined, CliError, FileServices> =>
  Effect.map(readCredentials, (credentials) => credentials[baseUrl]?.accessToken);

export const writeToken = (baseUrl: string, accessToken: string): Effect.Effect<void, CliError, FileServices> =>
  Effect.gen(function* () {
    const file = yield* credentialsFile;
    const credentials = yield* readCredentials;
    yield* writeJsonFile(Credentials, file, { ...credentials, [baseUrl]: { accessToken } });
    const fs = yield* FileSystem.FileSystem;
    yield* fs.chmod(file, 0o600).pipe(Effect.ignore);
  });

export const removeToken = (baseUrl: string): Effect.Effect<boolean, CliError, FileServices> =>
  Effect.gen(function* () {
    const file = yield* credentialsFile;
    const credentials = yield* readCredentials;
    if (!(baseUrl in credentials)) return false;
    const { [baseUrl]: _removed, ...rest } = credentials;
    yield* writeJsonFile(Credentials, file, rest);
    return true;
  });
