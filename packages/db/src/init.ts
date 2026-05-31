import { Effect } from 'effect';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './index';

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '../drizzle');

export const ensureDatabaseTables = Effect.fn('ensureDatabaseTables')(function* () {
  yield* Effect.tryPromise(() => migrate(db, { migrationsFolder }));
});
