import {
  createAgentdockClient,
  type AddGoogleDiscoverySourceInput,
  type AddGraphqlSourceInput,
  type AddMcpSourceInput,
  type AddOpenApiSourceInput,
  type Agent,
  type AssignAgentSkillsInput,
  type CreateSkillInput,
  type EvalSessionDetail,
  type EvalSessionsResponse,
  type ExecutorSourcesResponse,
  type DetectSourceInput,
  type McpProbeInput,
  type PreviewOpenApiInput,
  type ProbeGoogleDiscoveryInput,
  type PullSkillsInput,
  type SetExecutorToolModesInput,
  type SetPinnedExecutorToolsInput,
  type StartOAuthInput,
  type UpdateMcpSourceInput,
  type Workflow,
} from "agentdock-sdk/api";
import { buildAgentA2aPath, buildWorkflowA2aPath } from "agentdock-sdk/routes";
import type { PersistedTaskSession } from "@mokronos/a2a-chat-ui";

const apiBaseUrl = globalThis.__AGENTDOCK_API_BASE_URL__;

if (!apiBaseUrl) {
  throw new Error("AGENTDOCK_PUBLIC_API_URL was not injected into the dashboard HTML.");
}

const client = createAgentdockClient({ baseUrl: apiBaseUrl });

export const apiOrigin = new URL(apiBaseUrl).origin;

export const listAgents = client.listAgents;

export const listWorkflows = client.listWorkflows;

export const addAgent = client.addAgent;

export const updateAgent = client.updateAgent;

export const inspectAgentInternals = client.getAgentInternals;

export const removeAgent = client.removeAgent;

export const listSkills = client.listSkills;

export const addSkill = (payload: CreateSkillInput) => client.addSkill(payload);

export const pullSkills = (payload: PullSkillsInput) => client.pullSkills(payload);

export const removeSkill = (skillId: string) => client.removeSkill(skillId);

export const assignAgentSkills = (agentId: Agent["id"], payload: AssignAgentSkillsInput) =>
  client.assignAgentSkills(agentId, payload);

export const addWorkflow = client.addWorkflow;

export const updateWorkflow = client.updateWorkflow;

export const removeWorkflow = client.removeWorkflow;

export const getHealth = client.getHealth;

export const apiUrl = (path: string) => new URL(path, apiBaseUrl).toString();

export const agentA2aUrl = (agentId: string) => apiUrl(buildAgentA2aPath(agentId));

export const workflowA2aUrl = (workflowId: Workflow["id"]) => apiUrl(buildWorkflowA2aPath(workflowId));

export const listExecutorSources = (agentId: string): Promise<ExecutorSourcesResponse> =>
  client.listExecutorSources(agentId);

export const detectSource = (agentId: string, payload: DetectSourceInput) =>
  client.detectSource(agentId, payload);

export const probeMcpEndpoint = (agentId: string, payload: McpProbeInput) =>
  client.probeMcpEndpoint(agentId, payload);

export const addMcpSource = (agentId: string, payload: AddMcpSourceInput) =>
  client.addMcpSource(agentId, payload);

export const updateMcpSource = (agentId: string, sourceId: string, payload: UpdateMcpSourceInput) =>
  client.updateMcpSource(agentId, sourceId, payload);

export const removeMcpSource = (agentId: string, sourceId: string) =>
  client.removeMcpSource(agentId, sourceId);

export const previewOpenApiSpec = (agentId: string, payload: PreviewOpenApiInput) =>
  client.previewOpenApiSpec(agentId, payload);

export const addOpenApiSource = (agentId: string, payload: AddOpenApiSourceInput) =>
  client.addOpenApiSource(agentId, payload);

export const addGraphqlSource = (agentId: string, payload: AddGraphqlSourceInput) =>
  client.addGraphqlSource(agentId, payload);

export const probeGoogleDiscovery = (agentId: string, payload: ProbeGoogleDiscoveryInput) =>
  client.probeGoogleDiscovery(agentId, payload);

export const addGoogleDiscoverySource = (agentId: string, payload: AddGoogleDiscoverySourceInput) =>
  client.addGoogleDiscoverySource(agentId, payload);

export const removeExecutorSource = (agentId: string, sourceId: string) =>
  client.removeExecutorSource(agentId, sourceId);

export const setPinnedExecutorTools = (agentId: string, payload: SetPinnedExecutorToolsInput) =>
  client.setPinnedExecutorTools(agentId, payload);

export const setExecutorToolModes = (agentId: string, payload: SetExecutorToolModesInput) =>
  client.setExecutorToolModes(agentId, payload);

export const startExecutorOAuth = (agentId: string, payload: StartOAuthInput) =>
  client.startExecutorOAuth(agentId, payload);

export const listChatSessions = async (agentId: string): Promise<ReadonlyArray<PersistedTaskSession>> =>
  client.listSessions(agentId).then(({ sessions }) => sessions as ReadonlyArray<PersistedTaskSession>);

export const deleteChatSession = (agentId: string, sessionId: string): Promise<void> =>
  client.deleteSession(agentId, sessionId).then(() => undefined);

export const listEvalSessions = (): Promise<EvalSessionsResponse> => client.listEvalSessions();

export const getEvalSession = (targetId: string, sessionId: string): Promise<EvalSessionDetail> =>
  client.getEvalSession(targetId, sessionId);

export const listTraces = client.listTraces;

export const getTrace = client.getTrace;
