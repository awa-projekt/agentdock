// @effect-diagnostics processEnv:off -- drizzle-kit executes this config file itself, outside our Effect runtime
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: './src/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DB_FILE_NAME ?? 'agentdock.db',
  },
});
