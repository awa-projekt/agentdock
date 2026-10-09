// @effect-diagnostics processEnv:off nodeBuiltinImport:off -- vitest bootstrap runs before the Effect runtime and must set the env the db module reads
import * as NodeFS from 'node:fs';
import * as NodeOS from 'node:os';
import * as NodePath from 'node:path';

// Give every test file its own freshly-migrated SQLite database. The `db`
// package creates its libsql client from DB_FILE_NAME at import time, so this
// must run (and set the env var) before any test imports a db-backed module.
// Vitest isolates the module registry per test file, so each file gets an
// independent database and db-backed tests cannot see each other's writes or
// touch the dev database.
const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'agentdock-test-'));
process.env.DB_FILE_NAME = `file:${NodePath.join(dir, 'test.db')}`;

const { ensureDatabaseTables } = await import('./packages/db/src/init.ts');
const { Effect } = await import('effect');
await Effect.runPromise(ensureDatabaseTables());

process.on('exit', () => {
  try {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup of the temp database directory
  }
});
