import { client, db } from '../packages/db/src/index.ts';
import { ensureDatabaseTables } from '../packages/db/src/init.ts';
import { seedAgents } from './seed-agents.ts';
import { Effect } from 'effect';
import { pathToFileURL } from 'node:url';

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

export const resetDatabase = async (): Promise<void> => {
  const tables = await client.execute({
    sql: `select name from sqlite_schema where type = 'table' and name not like 'sqlite_%'`,
    args: [],
  });

  await db.run('pragma foreign_keys = off');
  for (const row of tables.rows) {
    if (typeof row.name === 'string') {
      await db.run(`drop table if exists ${quoteIdentifier(row.name)}`);
    }
  }
  await db.run('pragma foreign_keys = on');

  await Effect.runPromise(ensureDatabaseTables());
  await Effect.runPromise(seedAgents);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await resetDatabase();
}
