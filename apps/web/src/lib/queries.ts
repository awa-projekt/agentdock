import { type QueryKey, queryOptions, skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddEvalCasesInput,
  AgentToolsResponse,
  ApprovalStatus,
  CatalogTool,
  ChangedResource,
  ConnectIntegrationInput,
  CreateAgentInput,
  CreateChannelAccountInput,
  CreateChannelBindingInput,
  CreateEvalDatasetInput,
  CreateEvalRunInput,
  CreateSkillInput,
  CreateTriggerInput,
  DiscoverIntegrationInput,
  EvalCaseInput,
  EvalDatasetInput,
  EvalGateInput,
  EvalGraderInput,
  InstallableIntegrationRegistryKind,
  IntegrationsResponse,
  IntegrationToolId,
  PullSkillsInput,
  RegisterWorkflowInput,
  RegradeEvalRunInput,
  SetEvalReviewInput,
  SetProviderKeyInput,
  StartOAuthConnectionInput,
  ToolDecision,
  UpdateChannelAccountInput,
  UpdateChannelBindingInput,
  UpdateTriggerInput,
} from 'agentdock-sdk/schemas';
import { INTERNAL_INTEGRATION_SLUG } from 'agentdock-sdk/schemas';
import { useEffect } from 'react';
import * as api from '@/lib/api';

export const queryKeys = {
  agents: ['agents'] as const,
  allAgentInternals: ['agent-internals'] as const,
  agentInternals: (agentId: string) => ['agent-internals', agentId] as const,
  workflows: ['workflows'] as const,
  workflowRuns: ['workflow-runs'] as const,
  allWorkflowRunDetails: ['workflow-run'] as const,
  workflowRun: (runId: string) => ['workflow-run', runId] as const,
  allWorkflowRunEvents: ['workflow-run-events'] as const,
  workflowRunEvents: (runId: string) => ['workflow-run-events', runId] as const,
  skills: ['skills'] as const,
  mcpAccess: ['mcp-access'] as const,
  mcpAuthorizationRequest: (requestId: string) => ['mcp-authorization-request', requestId] as const,
  triggers: ['triggers'] as const,
  health: ['health'] as const,
  models: ['models'] as const,
  providerKeys: ['provider-keys'] as const,
  integrations: ['integrations'] as const,
  integrationRegistry: ['integration-registry'] as const,
  integrationRegistrySearch: (query: string, kind: InstallableIntegrationRegistryKind | undefined) =>
    ['integration-registry', query, kind] as const,
  allAgentTools: ['agent-tools'] as const,
  agentTools: (agentId: string | null) => ['agent-tools', agentId] as const,
  userConnections: ['user-connections'] as const,
  approvals: ['approvals'] as const,
  audit: ['audit'] as const,
  traces: ['traces'] as const,
  trace: (traceId: string | null, all: boolean) => ['trace', traceId, all] as const,
  allChatSessions: ['chat-sessions'] as const,
  chatSessions: (url: string) => ['chat-sessions', url] as const,
  evalSessions: ['eval-sessions'] as const,
  allEvalSessionDetails: ['eval-session'] as const,
  evalSession: (target: { readonly targetId: string; readonly sessionId: string } | null) =>
    ['eval-session', target?.targetId, target?.sessionId] as const,
  evalDatasets: ['eval-datasets'] as const,
  allEvalDatasetDetails: ['eval-dataset'] as const,
  evalDataset: (datasetId: string | null) => ['eval-dataset', datasetId] as const,
  evalGraders: ['eval-graders'] as const,
  evalGates: ['eval-gates'] as const,
  evalRuns: ['eval-runs'] as const,
  allEvalRunDetails: ['eval-run'] as const,
  evalRun: (runId: string | null) => ['eval-run', runId] as const,
  agentRun: (id: string | null) => ['agent-run', id] as const,
  channelAccounts: ['channel-accounts'] as const,
  channelBindings: ['channel-bindings'] as const,
  channelAccountStatuses: ['channel-account-statuses'] as const,
};

// The assistant's own management MCP server is an integration like any other;
// it has no place in the dashboard's integration or tool lists.
const withoutInternal = <T extends { readonly integration: string }>(tools: ReadonlyArray<T>): ReadonlyArray<T> =>
  tools.filter((tool) => tool.integration !== INTERNAL_INTEGRATION_SLUG);

const agentsQuery = queryOptions({
  queryKey: queryKeys.agents,
  queryFn: api.listAgents,
});

const workflowsQuery = queryOptions({
  queryKey: queryKeys.workflows,
  queryFn: api.listWorkflows,
});

const skillsQuery = queryOptions({
  queryKey: queryKeys.skills,
  queryFn: api.listSkills,
});

const triggersQuery = queryOptions({
  queryKey: queryKeys.triggers,
  queryFn: api.listTriggers,
});

const healthQuery = queryOptions({
  queryKey: queryKeys.health,
  queryFn: api.getHealth,
  refetchInterval: (query) => (query.state.data === 'OK' ? false : 2_000),
});

const integrationsQuery = queryOptions({
  queryKey: queryKeys.integrations,
  queryFn: api.listIntegrations,
  select: (data: IntegrationsResponse) => ({
    integrations: data.integrations.filter((integration) => integration.slug !== INTERNAL_INTEGRATION_SLUG),
    tools: withoutInternal(data.tools),
  }),
});

export const useAgents = () => useQuery(agentsQuery);
export const useWorkflows = () => useQuery(workflowsQuery);
export const useSkills = () => useQuery(skillsQuery);
export const useTriggers = () => useQuery(triggersQuery);
export const useHealth = () => useQuery(healthQuery);
export const useIntegrations = () => useQuery(integrationsQuery);

export type ToolDirectory = {
  readonly tools: ReadonlyMap<string, CatalogTool>;
  readonly integrations: IntegrationsResponse['integrations'];
};

/** Every catalog tool by id, internal ones included, for naming tool calls the gateway recorded. */
export const useToolDirectory = () =>
  useQuery({
    queryKey: queryKeys.integrations,
    queryFn: api.listIntegrations,
    select: (data: IntegrationsResponse): ToolDirectory => ({
      tools: new Map(data.tools.map((tool) => [tool.id, tool])),
      integrations: data.integrations,
    }),
  });

export const useAgentInternals = (agentId: string, enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.agentInternals(agentId),
    queryFn: () => api.inspectAgentInternals(agentId),
    enabled,
  });

export const useAgentTools = (agentId: string | null) =>
  useQuery({
    queryKey: queryKeys.agentTools(agentId),
    queryFn: agentId === null ? skipToken : () => api.listAgentTools(agentId),
    select: (response: AgentToolsResponse) => ({
      tools: withoutInternal(response.tools),
      unresolved: response.unresolved,
    }),
  });

export const useUserConnections = () =>
  useQuery({ queryKey: queryKeys.userConnections, queryFn: api.listUserConnections });

export const usePendingApprovals = () => useApprovals('pending');

export const useApprovals = (status: ApprovalStatus | 'all') =>
  useQuery({
    queryKey: [...queryKeys.approvals, status],
    queryFn: () => api.listApprovals(status === 'all' ? undefined : status),
  });

export const useAudit = (page: { readonly limit: number; readonly offset: number }) =>
  useQuery({
    queryKey: [...queryKeys.audit, page.limit, page.offset],
    queryFn: () => api.listAudit(page),
    placeholderData: (previous) => previous,
  });

export const useProviderKeys = () => useQuery({ queryKey: queryKeys.providerKeys, queryFn: api.listProviderKeys });

export const useModels = () =>
  useQuery({ queryKey: queryKeys.models, queryFn: api.listModels, staleTime: 60 * 60 * 1000 });

export const useWorkflowRuns = () => useQuery({ queryKey: queryKeys.workflowRuns, queryFn: api.listWorkflowRuns });

export const useWorkflowRun = (runId: string) =>
  useQuery({ queryKey: queryKeys.workflowRun(runId), queryFn: () => api.getWorkflowRun(runId) });

export const useWorkflowRunEvents = (runId: string) =>
  useQuery({ queryKey: queryKeys.workflowRunEvents(runId), queryFn: () => api.listWorkflowRunEvents(runId) });

export const useTraces = () =>
  useQuery({
    queryKey: queryKeys.traces,
    queryFn: () => api.listTraces({ limit: 100 }),
    select: (response) => response.traces,
  });

export const useTrace = (traceId: string | null, all: boolean) =>
  useQuery({
    queryKey: queryKeys.trace(traceId, all),
    queryFn: traceId === null ? skipToken : () => api.getTrace(traceId, { all }),
  });

export const useEvalSessions = () =>
  useQuery({
    queryKey: queryKeys.evalSessions,
    queryFn: api.listEvalSessions,
    select: (response) => response.sessions,
  });

export const useEvalSession = (target: { readonly targetId: string; readonly sessionId: string } | null) =>
  useQuery({
    queryKey: queryKeys.evalSession(target),
    queryFn: target === null ? skipToken : () => api.getEvalSession(target.targetId, target.sessionId),
  });

export const useEvalDatasets = () => useQuery({ queryKey: queryKeys.evalDatasets, queryFn: api.listEvalDatasets });

export const useEvalDataset = (datasetId: string | null) =>
  useQuery({
    queryKey: queryKeys.evalDataset(datasetId),
    queryFn: datasetId === null ? skipToken : () => api.getEvalDataset(datasetId),
  });

export const useEvalGraders = () => useQuery({ queryKey: queryKeys.evalGraders, queryFn: api.listEvalGraders });

export const useEvalGates = () => useQuery({ queryKey: queryKeys.evalGates, queryFn: api.listEvalGates });

export const useEvalRuns = () => useQuery({ queryKey: queryKeys.evalRuns, queryFn: api.listEvalRuns });

export const useEvalRun = (runId: string | null) =>
  useQuery({
    queryKey: queryKeys.evalRun(runId),
    queryFn: runId === null ? skipToken : () => api.getEvalRun(runId),
  });

export const useAgentRun = (id: string | null) =>
  useQuery({ queryKey: queryKeys.agentRun(id), queryFn: id === null ? skipToken : () => api.getAgentRun(id) });

const evalQueryKeys = [
  queryKeys.evalDatasets,
  queryKeys.allEvalDatasetDetails,
  queryKeys.evalGraders,
  queryKeys.evalGates,
  queryKeys.evalRuns,
  queryKeys.allEvalRunDetails,
] as const;

/** Every eval mutation can touch datasets, graders and runs at once, so each refreshes the whole slice. */
const useEvalMutation = <I, O>(mutationFn: (input: I) => Promise<O>) => {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn, onSuccess: () => invalidate(...evalQueryKeys) });
};

export const useCreateEvalDataset = () =>
  useEvalMutation((input: CreateEvalDatasetInput) => api.createEvalDataset(input));

export const useUpdateEvalDataset = () =>
  useEvalMutation(({ datasetId, input }: { readonly datasetId: string; readonly input: EvalDatasetInput }) =>
    api.updateEvalDataset(datasetId, input),
  );

export const useRemoveEvalDataset = () => useEvalMutation((datasetId: string) => api.removeEvalDataset(datasetId));

export const useAddEvalCases = () =>
  useEvalMutation(({ datasetId, input }: { readonly datasetId: string; readonly input: AddEvalCasesInput }) =>
    api.addEvalCases(datasetId, input),
  );

export const useUpdateEvalCase = () =>
  useEvalMutation(
    ({
      datasetId,
      caseId,
      input,
    }: {
      readonly datasetId: string;
      readonly caseId: string;
      readonly input: EvalCaseInput;
    }) => api.updateEvalCase(datasetId, caseId, input),
  );

export const useRemoveEvalCases = () =>
  useEvalMutation(({ datasetId, caseIds }: { readonly datasetId: string; readonly caseIds: ReadonlyArray<string> }) =>
    api.removeEvalCases(datasetId, caseIds),
  );

export const useCreateEvalGrader = () => useEvalMutation((input: EvalGraderInput) => api.createEvalGrader(input));

export const useUpdateEvalGrader = () =>
  useEvalMutation(({ graderId, input }: { readonly graderId: string; readonly input: EvalGraderInput }) =>
    api.updateEvalGrader(graderId, input),
  );

export const useRemoveEvalGrader = () => useEvalMutation((graderId: string) => api.removeEvalGrader(graderId));

export const useTestEvalGrader = () => useMutation({ mutationFn: api.testEvalGrader });

export const useStartEvalRun = () => useEvalMutation((input: CreateEvalRunInput) => api.startEvalRun(input));

export const useCancelEvalRun = () => useEvalMutation((runId: string) => api.cancelEvalRun(runId));

export const useRegradeEvalRun = () =>
  useEvalMutation(({ runId, input }: { readonly runId: string; readonly input: RegradeEvalRunInput }) =>
    api.regradeEvalRun(runId, input),
  );

export const useRemoveEvalRun = () => useEvalMutation((runId: string) => api.removeEvalRun(runId));

export const useSetEvalReview = () =>
  useEvalMutation(
    ({
      runId,
      trialId,
      input,
    }: {
      readonly runId: string;
      readonly trialId: string;
      readonly input: SetEvalReviewInput;
    }) => api.setEvalReview(runId, trialId, input),
  );

export const useCreateEvalGate = () => useEvalMutation((input: EvalGateInput) => api.createEvalGate(input));

export const useUpdateEvalGate = () =>
  useEvalMutation(({ gateId, input }: { readonly gateId: string; readonly input: EvalGateInput }) =>
    api.updateEvalGate(gateId, input),
  );

export const useRemoveEvalGate = () => useEvalMutation((gateId: string) => api.removeEvalGate(gateId));

export const useRunEvalGate = () => useEvalMutation((gateId: string) => api.runEvalGate(gateId));

export const useChannelAccounts = () =>
  useQuery({ queryKey: queryKeys.channelAccounts, queryFn: api.listChannelAccounts });

export const useChannelBindings = () =>
  useQuery({ queryKey: queryKeys.channelBindings, queryFn: api.listChannelBindings });

export const useChannelAccountStatuses = () =>
  useQuery({ queryKey: queryKeys.channelAccountStatuses, queryFn: api.listChannelAccountStatuses });

const changedQueryKeys = {
  agents: [queryKeys.agents, queryKeys.allAgentInternals, queryKeys.allAgentTools],
  workflows: [queryKeys.workflows],
  workflowRuns: [queryKeys.workflowRuns, queryKeys.allWorkflowRunDetails, queryKeys.allWorkflowRunEvents],
  skills: [queryKeys.skills],
  triggers: [queryKeys.triggers],
  channels: [queryKeys.channelAccounts, queryKeys.channelBindings, queryKeys.channelAccountStatuses],
  integrations: [queryKeys.integrations, queryKeys.allAgentTools, queryKeys.userConnections],
  approvals: [queryKeys.approvals],
  audit: [queryKeys.audit],
  providerKeys: [queryKeys.providerKeys, queryKeys.models],
  sessions: [queryKeys.allChatSessions, queryKeys.evalSessions, queryKeys.allEvalSessionDetails],
  evals: evalQueryKeys,
  mcpAccess: [queryKeys.mcpAccess],
} satisfies Record<ChangedResource, ReadonlyArray<QueryKey>>;

/**
 * Keeps every cached query in step with the server: the event stream names
 * each slice that changed, whoever changed it. A reconnect may have missed
 * changes, so everything fetched before it is refetched, and a dropped
 * connection is what prompts a health check.
 */
export const useServerEvents = () => {
  const queryClient = useQueryClient();
  useEffect(() => {
    let connected = false;
    return api.subscribeEvents({
      onEvent: (event) => {
        if (event._tag === 'Subscribed') {
          if (connected) void queryClient.invalidateQueries();
          connected = true;
          return;
        }
        for (const resource of event.resources) {
          for (const queryKey of changedQueryKeys[resource]) void queryClient.invalidateQueries({ queryKey });
        }
      },
      onDisconnect: () => void queryClient.invalidateQueries({ queryKey: queryKeys.health }),
    });
  }, [queryClient]);
};

/** Invalidate a set of query keys and resolve once every refetch settles. */
export const useInvalidate = () => {
  const queryClient = useQueryClient();
  return (...keys: ReadonlyArray<ReadonlyArray<string | boolean>>) =>
    Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey }))).then(() => undefined);
};

export const useCreateAgent = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateAgentInput) => api.addAgent(input),
    onSuccess: () => invalidate(queryKeys.agents),
  });
};

export const useUpdateAgent = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ agentId, input }: { readonly agentId: string; readonly input: CreateAgentInput }) =>
      api.updateAgent(agentId, input),
    onSuccess: () => invalidate(queryKeys.agents, queryKeys.allAgentTools, queryKeys.integrations),
  });
};

export const useRemoveAgent = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (agentId: string) => api.removeAgent(agentId),
    onSuccess: () => invalidate(queryKeys.agents),
  });
};

export const useAddSkill = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateSkillInput) => api.addSkill(input),
    onSuccess: () => invalidate(queryKeys.skills),
  });
};

export const usePullSkills = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: PullSkillsInput) => api.pullSkills(input),
    onSuccess: () => invalidate(queryKeys.skills),
  });
};

export const useMcpAccess = () => useQuery({ queryKey: queryKeys.mcpAccess, queryFn: api.getMcpAccess });

export const useRevokeMcpGrant = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (grantId: string) => api.revokeMcpGrant(grantId),
    onSuccess: () => invalidate(queryKeys.mcpAccess),
  });
};

export const useMcpAuthorizationRequest = (requestId: string) =>
  useQuery({
    queryKey: queryKeys.mcpAuthorizationRequest(requestId),
    queryFn: () => api.getMcpAuthorizationRequest(requestId),
    retry: false,
  });

export const useDecideMcpAuthorizationRequest = (requestId: string) =>
  useMutation({ mutationFn: (approve: boolean) => api.decideMcpAuthorizationRequest(requestId, approve) });

export const useRemoveSkill = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (skillId: string) => api.removeSkill(skillId),
    onSuccess: () => invalidate(queryKeys.skills, queryKeys.agents),
  });
};

export const useAddTrigger = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateTriggerInput) => api.addTrigger(input),
    onSuccess: () => invalidate(queryKeys.triggers),
  });
};

export const useUpdateTrigger = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ triggerId, input }: { readonly triggerId: string; readonly input: UpdateTriggerInput }) =>
      api.updateTrigger(triggerId, input),
    onSuccess: () => invalidate(queryKeys.triggers),
  });
};

export const useRemoveTrigger = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (triggerId: string) => api.removeTrigger(triggerId),
    onSuccess: () => invalidate(queryKeys.triggers),
  });
};

export const useRegisterWorkflow = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: RegisterWorkflowInput) => api.registerWorkflow(input),
    onSuccess: () => invalidate(queryKeys.workflows),
  });
};

export const useRemoveWorkflow = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (workflowId: string) => api.removeWorkflow(workflowId),
    onSuccess: () => invalidate(queryKeys.workflows),
  });
};

export const useSetProviderKey = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ provider, input }: { readonly provider: string; readonly input: SetProviderKeyInput }) =>
      api.setProviderKey(provider, input),
    onSuccess: () => invalidate(queryKeys.providerKeys, queryKeys.models),
  });
};

export const useRemoveProviderKey = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (provider: string) => api.removeProviderKey(provider),
    onSuccess: () => invalidate(queryKeys.providerKeys, queryKeys.models),
  });
};

export const useAddChannelAccount = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateChannelAccountInput) => api.addChannelAccount(input),
    onSuccess: () => invalidate(queryKeys.channelAccounts, queryKeys.channelAccountStatuses),
  });
};

export const useUpdateChannelAccount = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ accountId, input }: { readonly accountId: string; readonly input: UpdateChannelAccountInput }) =>
      api.updateChannelAccount(accountId, input),
    onSuccess: () => invalidate(queryKeys.channelAccounts, queryKeys.channelAccountStatuses),
  });
};

export const useRemoveChannelAccount = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (accountId: string) => api.removeChannelAccount(accountId),
    onSuccess: () => invalidate(queryKeys.channelAccounts, queryKeys.channelAccountStatuses, queryKeys.channelBindings),
  });
};

export const useAddChannelBinding = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateChannelBindingInput) => api.addChannelBinding(input),
    onSuccess: () => invalidate(queryKeys.channelBindings),
  });
};

export const useUpdateChannelBinding = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ bindingId, input }: { readonly bindingId: string; readonly input: UpdateChannelBindingInput }) =>
      api.updateChannelBinding(bindingId, input),
    onSuccess: () => invalidate(queryKeys.channelBindings),
  });
};

export const useRemoveChannelBinding = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (bindingId: string) => api.removeChannelBinding(bindingId),
    onSuccess: () => invalidate(queryKeys.channelBindings),
  });
};

export const useDiscoverIntegration = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: DiscoverIntegrationInput) => api.discoverIntegration(input),
    onSuccess: () => invalidate(queryKeys.integrations),
  });
};

export const useIntegrationRegistry = (enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.integrationRegistry,
    queryFn: () => api.searchIntegrationRegistry({ query: '', limit: 100 }),
    enabled,
    staleTime: 60 * 60 * 1000,
  });

export const useIntegrationRegistrySearch = (query: string, kind: InstallableIntegrationRegistryKind | undefined) =>
  useQuery({
    queryKey: queryKeys.integrationRegistrySearch(query, kind),
    queryFn: query.length === 0 ? skipToken : () => api.searchIntegrationRegistry({ query, kind, limit: 100 }),
    staleTime: 5 * 60 * 1000,
  });

export const useRemoveIntegration = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (slug: string) => api.removeIntegration(slug),
    onSuccess: () => invalidate(queryKeys.integrations),
  });
};

export const useConnectIntegration = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ slug, input }: { readonly slug: string; readonly input: ConnectIntegrationInput }) =>
      api.connectIntegration(slug, input),
    onSuccess: () => invalidate(queryKeys.integrations),
  });
};

export const useStartOAuthConnection = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ slug, input }: { readonly slug: string; readonly input: StartOAuthConnectionInput }) =>
      api.startOAuthConnection(slug, input),
    onSuccess: () => invalidate(queryKeys.integrations),
  });
};

export const useRemoveConnection = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ slug, name }: { readonly slug: string; readonly name: string }) => api.removeConnection(slug, name),
    onSuccess: () => invalidate(queryKeys.integrations),
  });
};

export const useRefreshConnection = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ slug, name }: { readonly slug: string; readonly name: string }) => api.refreshConnection(slug, name),
    onSuccess: () => invalidate(queryKeys.integrations),
  });
};

export const useSetToolDecision = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ toolId, decision }: { readonly toolId: IntegrationToolId; readonly decision: ToolDecision }) =>
      api.setToolDecision(toolId, { decision }),
    onSuccess: () => invalidate(queryKeys.integrations),
  });
};

export const useRemoveUserConnection = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ slug, name }: { readonly slug: string; readonly name: string }) =>
      api.removeUserConnection(slug, name),
    onSuccess: () => invalidate(queryKeys.userConnections),
  });
};

export const useDecideApproval = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ approvalId, action }: { readonly approvalId: string; readonly action: 'approve' | 'deny' }) =>
      action === 'approve' ? api.approveApproval(approvalId) : api.denyApproval(approvalId),
    onSuccess: () => invalidate(queryKeys.approvals, queryKeys.audit),
  });
};
