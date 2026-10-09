import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import * as Schema from 'effect/Schema';
import type * as Scope from 'effect/Scope';
import { JsonObject } from '../schemas/json';

/** Serializes a fixture's `package.json` / `agentdock.workflow.json` contents. */
export const artifactJson = Schema.encodeSync(Schema.fromJsonString(JsonObject));

/**
 * Fixture folders live under the package rather than the OS temp dir so a
 * fixture module can resolve bare specifiers like `@langchain/langgraph`
 * through the repo's node_modules.
 */
const makeArtifactFolder = (prefix: string, files: Readonly<Record<string, string>>): Effect.Effect<string> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = yield* fs.makeTempDirectory({ directory: import.meta.dirname, prefix });
    for (const [name, contents] of Object.entries(files)) {
      yield* fs.writeFileString(path.join(folder, name), contents);
    }
    return folder;
  }).pipe(Effect.orDie, Effect.provide(NodeServices.layer));

export const writeArtifactFile = (folder: string, name: string, contents: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(folder, name), contents);
  }).pipe(Effect.orDie, Effect.provide(NodeServices.layer));

const removeArtifactFolder = (folder: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(folder, { recursive: true, force: true });
  }).pipe(Effect.orDie, Effect.provide(NodeServices.layer));

export const artifactFixture = (
  prefix: string,
  files: Readonly<Record<string, string>>,
): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(makeArtifactFolder(prefix, files), removeArtifactFolder);
