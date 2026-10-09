import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import * as Schema from 'effect/Schema';
import * as SchemaGetter from 'effect/SchemaGetter';
import { type CliError, cliError, messageOf } from './errors';

const JsonText = Schema.String.pipe(
  Schema.decodeTo(Schema.Unknown, {
    decode: SchemaGetter.parseJson(),
    encode: SchemaGetter.stringifyJson({ space: 2 }),
  }),
);

const encodeJsonText = Schema.encodeEffect(JsonText);

export type FileServices = FileSystem.FileSystem | Path.Path;

export const readJsonFile = <S extends Schema.Top>(
  schema: S,
  file: string,
): Effect.Effect<Option.Option<S['Type']>, CliError, FileServices | S['DecodingServices']> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(file))) return Option.none();
    const text = yield* fs.readFileString(file);
    const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text);
    return Option.some(value);
  }).pipe(Effect.mapError((error) => cliError(`Cannot read '${file}': ${messageOf(error)}`)));

export const writeJsonFile = <S extends Schema.Top>(
  schema: S,
  file: string,
  value: S['Type'],
): Effect.Effect<void, CliError, FileServices | S['EncodingServices']> =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(schema)(value);
    const text = yield* encodeJsonText(encoded);
    yield* writeTextFile(file, `${text}\n`);
  }).pipe(Effect.mapError((error) => cliError(`Cannot write '${file}': ${messageOf(error)}`)));

export const writeTextFile = (file: string, text: string): Effect.Effect<void, CliError, FileServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, text);
  }).pipe(Effect.mapError((error) => cliError(`Cannot write '${file}': ${messageOf(error)}`)));

export const writeBytes = (file: string, bytes: Uint8Array): Effect.Effect<void, CliError, FileServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFile(file, bytes);
  }).pipe(Effect.mapError((error) => cliError(`Cannot write '${file}': ${messageOf(error)}`)));
