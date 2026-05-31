import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema';

const DB_FILE_NAME = 'agent-registry.db';

export const client = createClient({ url: process.env.DB_FILE_NAME ?? `file:${DB_FILE_NAME}` });
export const db = drizzle({ client, schema });

export * from './schema';
