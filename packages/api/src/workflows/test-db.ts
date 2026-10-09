import * as NodeURL from 'node:url';
import { createClient } from '@libsql/client';
import { Database, type DatabaseClient, withSerialQueue } from 'db';
import * as schema from 'db/schema';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

const migrationsFolder = NodeURL.fileURLToPath(new URL('../../../db/drizzle', import.meta.url));

/**
 * Build a fresh in-memory libsql database with the full Drizzle schema applied.
 * Each call is an isolated database, so persistence tests can write real rows
 * without touching the on-disk dev database or colliding with other tests.
 */
export const makeTestDb = async (): Promise<DatabaseClient> => {
  const client = withSerialQueue(createClient({ url: ':memory:' }));
  const db: DatabaseClient = drizzle({ client, schema });
  await migrate(db, { migrationsFolder });
  return db;
};

/**
 * The same fresh database as a `Database` layer, so `it.effect` tests can
 * provide it alongside the service under test instead of awaiting a fixture.
 */
export const TestDatabaseLive: Layer.Layer<typeof Database.Service> = Layer.effect(
  Database,
  Effect.map(Effect.promise(makeTestDb), (db) => Database.of({ db, client: db.$client })),
);
