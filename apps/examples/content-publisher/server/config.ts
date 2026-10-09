import { localUrl, normalizeBaseUrl } from '../../../../packages/sdk/src/config';
import { ports } from '../../../../packages/sdk/src/ports';

/**
 * Boot-time configuration from the environment. The `agentdockUrl` and
 * `workflowId` values here are only *seeds* — they can be changed at runtime
 * from the in-app dev settings panel (see `settings.ts`). The rest (port,
 * session secret) are fixed for the process lifetime.
 */
export const config = {
  port: Number(process.env.PORT ?? 8787),
  /** Initial base URL of the AgentDock server (overridable at runtime). */
  agentdockUrl: normalizeBaseUrl(process.env.AGENTDOCK_URL ?? localUrl(ports().api)),
  /** Initial content-publisher workflow id (overridable at runtime). */
  workflowId: process.env.WORKFLOW_ID ?? '',
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-secret-change-me',
  isProduction: process.env.NODE_ENV === 'production',
} as const;

/** Channels the UI offers; mirrors the mock MCP server's CHANNELS. */
export const CHANNELS = ['blog', 'twitter', 'linkedin', 'newsletter'] as const;
