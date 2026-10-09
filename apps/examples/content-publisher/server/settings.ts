/**
 * Runtime-mutable settings, seeded from the environment (see `config.ts`) and
 * editable from the in-app dev settings panel. Kept in memory for the example —
 * a real app would persist these per-tenant. The two things worth changing
 * without a restart are which AgentDock to talk to and which workflow to run.
 */
import { config } from './config';

export type Settings = {
  agentdockUrl: string;
  workflowId: string;
};

const normalizeUrl = (url: string): string => url.trim().replace(/\/$/, '');

let agentdockUrl = config.agentdockUrl;
let workflowId = config.workflowId;

export const getSettings = (): Settings => ({ agentdockUrl, workflowId });

export const updateSettings = (next: Partial<Settings>): Settings => {
  if (next.agentdockUrl?.trim()) {
    agentdockUrl = normalizeUrl(next.agentdockUrl);
  }
  if (next.workflowId !== undefined) {
    workflowId = next.workflowId.trim();
  }
  return getSettings();
};

export const agentdockBaseUrl = (): string => agentdockUrl;

/** The A2A endpoint for the currently-configured workflow. */
export const workflowA2aUrl = (): string => `${agentdockUrl}/workflows/${workflowId}/a2a`;
