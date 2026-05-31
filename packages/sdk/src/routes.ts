import { AGENT_CARD_PATH } from '@a2a-js/sdk';

export const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/$/, '');

export const buildAgentPath = (agentId: string): string => `/agents/${agentId}`;

export const buildAgentA2aPath = (agentId: string): string => `${buildAgentPath(agentId)}/a2a`;

export const buildAgentCardPath = (agentId: string): string => `${buildAgentA2aPath(agentId)}/${AGENT_CARD_PATH}`;

export const buildWorkflowPath = (workflowId: string): string => `/workflows/${workflowId}`;

export const buildWorkflowA2aPath = (workflowId: string): string => `${buildWorkflowPath(workflowId)}/a2a`;

export const buildWorkflowCardPath = (workflowId: string): string =>
  `${buildWorkflowA2aPath(workflowId)}/${AGENT_CARD_PATH}`;

export const buildAgentUrl = (baseUrl: string, agentId: string): string =>
  `${normalizeBaseUrl(baseUrl)}${buildAgentPath(agentId)}`;

export const buildAgentA2aUrl = (baseUrl: string, agentId: string): string =>
  `${normalizeBaseUrl(baseUrl)}${buildAgentA2aPath(agentId)}`;

export const buildAgentCardUrl = (baseUrl: string, agentId: string): string =>
  `${normalizeBaseUrl(baseUrl)}${buildAgentCardPath(agentId)}`;

export const buildWorkflowUrl = (baseUrl: string, workflowId: string): string =>
  `${normalizeBaseUrl(baseUrl)}${buildWorkflowPath(workflowId)}`;

export const buildWorkflowA2aUrl = (baseUrl: string, workflowId: string): string =>
  `${normalizeBaseUrl(baseUrl)}${buildWorkflowA2aPath(workflowId)}`;

export const buildWorkflowCardUrl = (baseUrl: string, workflowId: string): string =>
  `${normalizeBaseUrl(baseUrl)}${buildWorkflowCardPath(workflowId)}`;
