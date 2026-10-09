import { normalizeBaseUrl } from './url';

export { normalizeBaseUrl } from './url';

const buildAgentPath = (agentId: string): string => `/agents/${agentId}`;

export const buildAgentA2aPath = (agentId: string): string => `${buildAgentPath(agentId)}/a2a`;

const buildWorkflowPath = (workflowId: string): string => `/workflows/${workflowId}`;

export const buildWorkflowA2aPath = (workflowId: string): string => `${buildWorkflowPath(workflowId)}/a2a`;

export const buildAgentA2aUrl = (baseUrl: string, agentId: string): string =>
  `${normalizeBaseUrl(baseUrl)}${buildAgentA2aPath(agentId)}`;

export const buildWorkflowA2aUrl = (baseUrl: string, workflowId: string): string =>
  `${normalizeBaseUrl(baseUrl)}${buildWorkflowA2aPath(workflowId)}`;
