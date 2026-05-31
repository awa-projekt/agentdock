import {
  AgentCapabilitiesSchema,
  AgentCommunicationToolConfigSchema,
  AgentSchema,
  type Agent as ApiAgent,
  type AgentCapabilities as ApiAgentCapabilities,
  type AgentCommunicationToolConfig as ApiAgentCommunicationToolConfig,
} from './api/schemas';

export const AgentCapabilities = AgentCapabilitiesSchema;
export const AgentCommunicationToolConfig = AgentCommunicationToolConfigSchema;
export const Agent = AgentSchema;

export type Agent = ApiAgent;
export type AgentCapabilities = ApiAgentCapabilities;
export type AgentCommunicationToolConfig = ApiAgentCommunicationToolConfig;
