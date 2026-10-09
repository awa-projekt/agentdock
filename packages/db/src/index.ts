import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as schema from './schema';
import { withSerialQueue } from './serial-client';

const DEFAULT_DATABASE_FILE_NAME = 'agentdock.db';
const defaultDatabaseUrl = `file:${DEFAULT_DATABASE_FILE_NAME}`;

// Another process (a script, drizzle-kit) can hold the write lock, so wait for
// it instead of failing immediately. In-process contention cannot happen: the
// serial client keeps one statement in flight at a time.
const BUSY_TIMEOUT_MS = 5000;

const makeDatabase = (url: string) => {
  const client = withSerialQueue(createClient({ url }));
  const ready = client.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  void ready.catch(() => {});
  return { client, db: drizzle({ client, schema }), ready };
};

const databases = new Map<string, ReturnType<typeof makeDatabase>>();

const getDatabase = (url: string) => {
  const existing = databases.get(url);
  if (existing) return existing;
  const database = makeDatabase(url);
  databases.set(url, database);
  return database;
};

export type DatabaseConfigService = { readonly url: string };
const DatabaseConfig = Context.Service<DatabaseConfigService>('@agentdock/db/DatabaseConfig');
const DatabaseConfigLive = Layer.effect(
  DatabaseConfig,
  Effect.gen(function* () {
    const url = yield* Config.String('DB_FILE_NAME').pipe(Config.orElse(() => Config.succeed(defaultDatabaseUrl)));
    return DatabaseConfig.of({ url });
  }),
);

// @effect-diagnostics-next-line processEnv:off -- db package boundary: the module-level client is created before any Effect runtime exists
const databaseFileNameFromEnv = (): string => process.env.DB_FILE_NAME ?? defaultDatabaseUrl;

const globalDatabase = getDatabase(databaseFileNameFromEnv());

export const client = globalDatabase.client;
export const db = globalDatabase.db;

export type DatabaseClient = typeof db;

export type DatabaseService = { readonly db: DatabaseClient; readonly client: Client };
export const Database = Context.Service<DatabaseService>('@agentdock/db/Database');
export const DatabaseLive = Layer.effect(
  Database,
  Effect.gen(function* () {
    const config = yield* DatabaseConfig;
    const database = getDatabase(config.url);
    yield* Effect.promise(() => database.ready);
    return Database.of({ db: database.db, client: database.client });
  }),
).pipe(Layer.provide(DatabaseConfigLive));

export * from './schema';
export * from './secret-cipher';
export * from './serial-client';
export * from './try-db';
