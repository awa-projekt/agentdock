import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { client, db } from '../packages/db/src/index.ts';
import { ensureDatabaseTables } from '../packages/db/src/init.ts';
import { seedAgents } from './seed-agents.ts';

const decodeTableRows = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String })));

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const main = Effect.gen(function* () {
  const tables = yield* Effect.promise(() =>
    client.execute({
      sql: `select name from sqlite_schema where type = 'table' and name not like 'sqlite_%'`,
      args: [],
    }),
  );

  yield* Effect.promise(() => db.run('pragma foreign_keys = off'));
  for (const { name } of yield* decodeTableRows(tables.rows)) {
    yield* Effect.promise(() => db.run(`drop table if exists ${quoteIdentifier(name)}`));
  }
  yield* Effect.promise(() => db.run('pragma foreign_keys = on'));
  yield* ensureDatabaseTables();
  yield* seedAgents();
});

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
