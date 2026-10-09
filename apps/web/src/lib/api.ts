import { createAgentdockClient } from 'agentdock-sdk/api';
import { buildAgentA2aPath, buildWorkflowA2aPath } from 'agentdock-sdk/routes';
import type { ChatPersistence } from '@/lib/chat/persistence';
import { toChatSession } from '@/lib/chat/persistence';

const apiBaseUrl = globalThis.__AGENTDOCK_API_BASE_URL__;

if (!apiBaseUrl) {
  throw new Error('AGENTDOCK_PUBLIC_API_URL was not injected into the dashboard HTML.');
}

const client = createAgentdockClient({ baseUrl: apiBaseUrl });

export const apiOrigin = new URL(apiBaseUrl).origin;

export const subscribeEvents = client.subscribeEvents;

export const listAgents = client.listAgents;

export const listWorkflows = client.listWorkflows;

export const addAgent = client.addAgent;

export const updateAgent = client.updateAgent;

export const inspectAgentInternals = client.getAgentInternals;

export const removeAgent = client.removeAgent;

export const listSkills = client.listSkills;

export const getMcpAccess = client.getMcpAccess;

export const revokeMcpGrant = client.revokeMcpGrant;

export const getMcpAuthorizationRequest = client.getMcpAuthorizationRequest;

export const decideMcpAuthorizationRequest = (requestId: string, approve: boolean) =>
  client.decideMcpAuthorizationRequest(requestId, { approve });

export const addSkill = client.addSkill;

export const pullSkills = client.pullSkills;

export const removeSkill = client.removeSkill;

export const registerWorkflow = client.registerWorkflow;

export const removeWorkflow = client.removeWorkflow;

export const listWorkflowRuns = client.listWorkflowRuns;

export const getWorkflowRun = client.getWorkflowRun;

export const listWorkflowRunEvents = client.listWorkflowRunEvents;

export const getHealth = client.getHealth;

export const listModels = client.listModels;

export const listProviderKeys = client.listProviderKeys;

export const setProviderKey = client.setProviderKey;

export const removeProviderKey = client.removeProviderKey;

export const validateModel = (model: string) => client.validateModel({ model });

export const apiUrl = (path: string) => new URL(path, apiBaseUrl).toString();

export const agentA2aUrl = (agentId: string) => apiUrl(buildAgentA2aPath(agentId));

export const workflowA2aUrl = (workflowId: string) => apiUrl(buildWorkflowA2aPath(workflowId));

export const listIntegrations = client.listIntegrations;

export const searchIntegrationRegistry = client.searchIntegrationRegistry;

export const discoverIntegration = client.discoverIntegration;

export const removeIntegration = client.removeIntegration;

export const connectIntegration = client.connectIntegration;

export const startOAuthConnection = client.startOAuthConnection;

export const removeConnection = client.removeConnection;

export const refreshConnection = client.refreshConnection;

export const getOAuthSession = client.getOAuthSession;

export const provideOAuthClient = client.provideOAuthClient;

export const listUserConnections = client.listUserConnections;

export const startUserOAuthConnection = client.startUserOAuthConnection;

export const removeUserConnection = client.removeUserConnection;

export const executeTool = client.executeTool;

export const setToolDecision = client.setToolDecision;

export const listAgentTools = client.listAgentTools;

export const listApprovals = client.listApprovals;

export const approveApproval = client.approveApproval;

export const denyApproval = client.denyApproval;

export const listAudit = client.listAudit;

export const chatPersistence = (agentId: string): ChatPersistence => ({
  load: () => client.listSessions(agentId).then(({ sessions }) => sessions.map(toChatSession)),
  remove: (sessionId) => client.deleteSession(agentId, sessionId).then(() => undefined),
});

export const listEvalSessions = client.listEvalSessions;

export const getEvalSession = client.getEvalSession;

export const listEvalDatasets = client.listEvalDatasets;

export const createEvalDataset = client.createEvalDataset;

export const getEvalDataset = client.getEvalDataset;

export const updateEvalDataset = client.updateEvalDataset;

export const removeEvalDataset = client.removeEvalDataset;

export const addEvalCases = client.addEvalCases;

export const updateEvalCase = client.updateEvalCase;

export const removeEvalCases = client.removeEvalCases;

export const listEvalGraders = client.listEvalGraders;

export const createEvalGrader = client.createEvalGrader;

export const updateEvalGrader = client.updateEvalGrader;

export const removeEvalGrader = client.removeEvalGrader;

export const testEvalGrader = client.testEvalGrader;

export const listEvalRuns = client.listEvalRuns;

export const startEvalRun = client.startEvalRun;

export const getEvalRun = client.getEvalRun;

export const cancelEvalRun = client.cancelEvalRun;

export const regradeEvalRun = client.regradeEvalRun;

export const removeEvalRun = client.removeEvalRun;

export const setEvalReview = client.setEvalReview;

export const getAgentRun = client.getAgentRun;

export const listEvalGates = client.listEvalGates;

export const createEvalGate = client.createEvalGate;

export const updateEvalGate = client.updateEvalGate;

export const removeEvalGate = client.removeEvalGate;

export const runEvalGate = client.runEvalGate;

export const listTraces = client.listTraces;

export const getTrace = client.getTrace;

export const listTriggers = client.listTriggers;

export const addTrigger = client.addTrigger;

export const updateTrigger = client.updateTrigger;

export const removeTrigger = client.removeTrigger;

export const triggerWebhookUrl = (triggerId: string) => apiUrl(`/triggers/${encodeURIComponent(triggerId)}/webhook`);

export const listChannelAccounts = client.listChannelAccounts;

export const addChannelAccount = client.addChannelAccount;

export const updateChannelAccount = client.updateChannelAccount;

export const removeChannelAccount = client.removeChannelAccount;

export const listChannelAccountStatuses = client.listChannelAccountStatuses;

export const listChannelBindings = client.listChannelBindings;

export const addChannelBinding = client.addChannelBinding;

export const updateChannelBinding = client.updateChannelBinding;

export const removeChannelBinding = client.removeChannelBinding;
