export type WorkflowMode = 'registry' | 'runs';
export type EvalsTab = 'runs' | 'datasets' | 'graders' | 'gates' | 'sessions';

export const routePatterns = {
  setup: '/setup',
  oauthConsent: '/oauth/consent',
  agents: '/agents/:agentId?',
  createAgent: '/agents/new',
  editAgent: '/agents/:agentId/edit',
  chat: '/chat/:agentId?',
  tools: '/tools/:agentId?',
  integrations: '/integrations',
  approvals: '/approvals',
  userIntegrations: '/connections',
  userIntegrationsAlias: '/user-integrations',
  skills: '/skills',
  communication: '/communication',
  communicationAlias: '/graph',
  workflows: '/workflows',
  workflowRuns: '/workflows/runs/:runId?',
  triggers: '/triggers',
  channels: '/channels',
  evals: '/evals/:tab?/:itemId?',
  traces: '/traces',
  providers: '/providers',
  device: '/device',
} as const;

/** Sidebar highlight for the workflows section, which spans the registry and run routes. */
export const workflowsSectionPattern = /^\/workflows(\/|$)/;
export const agentsSectionPattern = /^\/agents(\/|$)/;
/** Routes that render the agent form; the draft survives while the location stays inside them. */
export const agentEditorPattern = /^\/agents\/(new|[^/]+\/edit)$/;

/** wouter decodes a matched path with `decodeURI`, which leaves reserved characters escaped. */
export const decodeRouteParam = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

export const setupPath = (): string => routePatterns.setup;

export const agentsPath = (agentId?: string | null): string =>
  agentId ? `/agents/${encodeURIComponent(agentId)}` : '/agents';
export const createAgentPath = (): string => routePatterns.createAgent;
export const editAgentPath = (agentId: string): string => `/agents/${encodeURIComponent(agentId)}/edit`;
export const chatPath = (agentId?: string | null): string =>
  agentId ? `/chat/${encodeURIComponent(agentId)}` : '/chat';
export const toolsPath = (agentId?: string | null): string =>
  agentId ? `/tools/${encodeURIComponent(agentId)}` : '/tools';
export const integrationsPath = (): string => routePatterns.integrations;
export const approvalsPath = (): string => routePatterns.approvals;
export const userIntegrationsPath = (): string => routePatterns.userIntegrations;
export const skillsPath = (): string => routePatterns.skills;
export const communicationPath = (): string => routePatterns.communication;
export const triggersPath = (): string => routePatterns.triggers;
export const channelsPath = (): string => routePatterns.channels;
export const evalsPath = (tab: EvalsTab = 'runs', itemId: string | null = null): string =>
  itemId ? `/evals/${tab}/${encodeURIComponent(itemId)}` : `/evals/${tab}`;
export const tracesPath = (): string => routePatterns.traces;
export const providersPath = (): string => routePatterns.providers;

export const workflowsPath = (mode: WorkflowMode = 'registry', runId: string | null = null): string => {
  if (mode !== 'runs') return routePatterns.workflows;
  return runId ? `/workflows/runs/${encodeURIComponent(runId)}` : '/workflows/runs';
};
