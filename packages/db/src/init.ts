import * as NodeURL from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { db } from './index';

const migrationsFolder = NodeURL.fileURLToPath(new URL('../drizzle', import.meta.url));

export class DbMigrationError extends Schema.TaggedError<DbMigrationError>()('DbMigrationError', {
  cause: Schema.Defect(),
}) {}

export const ensureDatabaseTables = Effect.fn('ensureDatabaseTables')(function* () {
  yield* Effect.tryPromise({
    try: () => migrate(db, { migrationsFolder }),
    catch: (cause) => new DbMigrationError({ cause }),
  });
});
