import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpApiClient from 'effect/http-api/HttpApiClient';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import type {
  AddEvalCasesInput,
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
  ExecuteToolInput,
  McpAuthorizationDecision,
  PullSkillsInput,
  RegradeEvalRunInput,
  SearchIntegrationRegistryInput,
  ServerEvent,
  SetEvalReviewInput,
  SetProviderKeyInput,
  SetToolDecisionInput,
  StartOAuthConnectionInput,
  TestEvalGraderInput,
  UpdateChannelAccountInput,
  UpdateChannelBindingInput,
  UpdateTriggerInput,
  ValidateModelInput,
} from '../schemas';
import {
  AgentId,
  ApprovalId,
  type ApprovalStatus,
  ChannelAccountId,
  ChannelBindingId,
  ConnectionName,
  EvalCaseId,
  EvalDatasetId,
  EvalGateId,
  EvalGraderId,
  EvalRunId,
  EvalTrialId,
  IntegrationSlug,
  IntegrationToolId,
  McpAuthorizationRequestId,
  McpGrantId,
  type ProvideOAuthClientInput,
  type RegisterWorkflowInput,
  SkillId,
  TraceId,
  TriggerId,
  WorkflowId,
  WorkflowRunId,
} from '../schemas';
import { AgentdockApi } from './http';

const RECONNECT_DELAY = '2 seconds';

export type AgentdockClientOptions = {
  readonly baseUrl: string;
};

const auditQuery = (options: {
  readonly limit?: number;
  readonly offset?: number;
}): { readonly limit?: number; readonly offset?: number } => {
  const withLimit = options.limit === undefined ? {} : { limit: options.limit };
  return options.offset === undefined ? withLimit : { ...withLimit, offset: options.offset };
};

export const createAgentdockClient = ({ baseUrl }: AgentdockClientOptions) => {
  const makeClient = HttpApiClient.make(AgentdockApi, { baseUrl });
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  const agentIdOf = Schema.decodeUnknownSync(AgentId);
  const skillIdOf = Schema.decodeUnknownSync(SkillId);
  const workflowIdOf = Schema.decodeUnknownSync(WorkflowId);
  const workflowRunIdOf = Schema.decodeUnknownSync(WorkflowRunId);
  const slugOf = Schema.decodeUnknownSync(IntegrationSlug);
  const toolIdOf = Schema.decodeUnknownSync(IntegrationToolId);
  const approvalIdOf = Schema.decodeUnknownSync(ApprovalId);
  const nameOf = Schema.decodeUnknownSync(ConnectionName);
  const traceIdOf = Schema.decodeUnknownSync(TraceId);
  const triggerIdOf = Schema.decodeUnknownSync(TriggerId);
  const channelAccountIdOf = Schema.decodeUnknownSync(ChannelAccountId);
  const channelBindingIdOf = Schema.decodeUnknownSync(ChannelBindingId);
  const mcpGrantIdOf = Schema.decodeUnknownSync(McpGrantId);
  const mcpRequestIdOf = Schema.decodeUnknownSync(McpAuthorizationRequestId);
  const datasetIdOf = Schema.decodeUnknownSync(EvalDatasetId);
  const caseIdOf = Schema.decodeUnknownSync(EvalCaseId);
  const graderIdOf = Schema.decodeUnknownSync(EvalGraderId);
  const runIdOf = Schema.decodeUnknownSync(EvalRunId);
  const trialIdOf = Schema.decodeUnknownSync(EvalTrialId);
  const gateIdOf = Schema.decodeUnknownSync(EvalGateId);
  const withClient = <A, E>(f: (client: Effect.Success<typeof makeClient>) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      return yield* f(client);
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { credentials: 'include' }),
    );

  return {
    /** Streams `GET /events` until the returned function is called, reconnecting whenever the connection drops. */
    subscribeEvents: (handlers: {
      readonly onEvent: (event: ServerEvent) => void;
      readonly onDisconnect: () => void;
    }): (() => void) => {
      const controller = new AbortController();
      Effect.runFork(
        withClient((client) => client.events.events({})).pipe(
          Effect.flatMap(Stream.runForEach((event) => Effect.sync(() => handlers.onEvent(event)))),
          Effect.ignoreCause,
          Effect.andThen(Effect.sync(handlers.onDisconnect)),
          Effect.repeat(Schedule.spaced(RECONNECT_DELAY)),
        ),
        { signal: controller.signal },
      );
      return () => controller.abort();
    },
    listAgents: () => run(withClient((client) => client.agents.listAgents({}))),
    addAgent: (payload: CreateAgentInput) => run(withClient((client) => client.agents.addAgent({ payload }))),
    updateAgent: (agentId: string, payload: CreateAgentInput) =>
      run(withClient((client) => client.agents.updateAgent({ params: { agentId: agentIdOf(agentId) }, payload }))),
    getAgentInternals: (agentId: string) =>
      run(withClient((client) => client.agents.getAgentInternals({ params: { agentId: agentIdOf(agentId) } }))),
    removeAgent: (agentId: string) =>
      run(withClient((client) => client.agents.removeAgent({ params: { agentId: agentIdOf(agentId) } }))),
    listSkills: () => run(withClient((client) => client.skills.listSkills({}))),
    addSkill: (payload: CreateSkillInput) => run(withClient((client) => client.skills.addSkill({ payload }))),
    pullSkills: (payload: PullSkillsInput) => run(withClient((client) => client.skills.pullSkills({ payload }))),
    removeSkill: (skillId: string) =>
      run(withClient((client) => client.skills.removeSkill({ params: { skillId: skillIdOf(skillId) } }))),
    listWorkflows: () => run(withClient((client) => client.workflows.listWorkflows({}))),
    /** Uploading an artifact with an already registered name bumps its revision rather than duplicating. */
    registerWorkflow: (payload: RegisterWorkflowInput) =>
      run(withClient((client) => client.workflows.registerWorkflow({ payload }))),
    downloadWorkflowArtifact: (workflowId: string) =>
      run(
        withClient((client) =>
          client.workflows.downloadWorkflowArtifact({ params: { workflowId: workflowIdOf(workflowId) } }),
        ),
      ),
    removeWorkflow: (workflowId: string) =>
      run(
        withClient((client) => client.workflows.removeWorkflow({ params: { workflowId: workflowIdOf(workflowId) } })),
      ),
    listWorkflowRuns: () => run(withClient((client) => client.workflows.listWorkflowRuns({}))),
    getWorkflowRun: (runId: string) =>
      run(withClient((client) => client.workflows.getWorkflowRun({ params: { runId: workflowRunIdOf(runId) } }))),
    listWorkflowRunEvents: (runId: string) =>
      run(
        withClient((client) => client.workflows.listWorkflowRunEvents({ params: { runId: workflowRunIdOf(runId) } })),
      ),
    getHealth: () => run(withClient((client) => client.general.health({}))),
    listIntegrations: () => run(withClient((client) => client.integrations.listIntegrations({}))),
    searchIntegrationRegistry: (payload: SearchIntegrationRegistryInput) =>
      run(withClient((client) => client.integrations.searchIntegrationRegistry({ payload }))),
    discoverIntegration: (payload: DiscoverIntegrationInput) =>
      run(withClient((client) => client.integrations.discoverIntegration({ payload }))),
    removeIntegration: (slug: string) =>
      run(withClient((client) => client.integrations.removeIntegration({ params: { slug: slugOf(slug) } }))),
    connectIntegration: (slug: string, payload: ConnectIntegrationInput) =>
      run(withClient((client) => client.integrations.connectIntegration({ params: { slug: slugOf(slug) }, payload }))),
    startOAuthConnection: (slug: string, payload: StartOAuthConnectionInput) =>
      run(
        withClient((client) => client.integrations.startOAuthConnection({ params: { slug: slugOf(slug) }, payload })),
      ),
    removeConnection: (slug: string, name: string) =>
      run(
        withClient((client) =>
          client.integrations.removeConnection({ params: { slug: slugOf(slug), name: nameOf(name) } }),
        ),
      ),
    refreshConnection: (slug: string, name: string) =>
      run(
        withClient((client) =>
          client.integrations.refreshConnection({ params: { slug: slugOf(slug), name: nameOf(name) } }),
        ),
      ),
    getOAuthSession: (sessionId: string) =>
      run(withClient((client) => client.integrations.getOAuthSession({ params: { sessionId } }))),
    provideOAuthClient: (sessionId: string, payload: ProvideOAuthClientInput) =>
      run(withClient((client) => client.integrations.provideOAuthClient({ params: { sessionId }, payload }))),
    listUserConnections: () => run(withClient((client) => client.integrations.listUserConnections({}))),
    connectUserIntegration: (slug: string, payload: ConnectIntegrationInput) =>
      run(
        withClient((client) => client.integrations.connectUserIntegration({ params: { slug: slugOf(slug) }, payload })),
      ),
    startUserOAuthConnection: (slug: string, payload: StartOAuthConnectionInput) =>
      run(
        withClient((client) =>
          client.integrations.startUserOAuthConnection({ params: { slug: slugOf(slug) }, payload }),
        ),
      ),
    removeUserConnection: (slug: string, name: string) =>
      run(
        withClient((client) =>
          client.integrations.removeUserConnection({ params: { slug: slugOf(slug), name: nameOf(name) } }),
        ),
      ),
    executeTool: (payload: ExecuteToolInput) =>
      run(withClient((client) => client.integrations.executeTool({ payload }))),
    setToolDecision: (toolId: string, payload: SetToolDecisionInput) =>
      run(
        withClient((client) => client.integrations.setToolDecision({ params: { toolId: toolIdOf(toolId) }, payload })),
      ),
    listAgentTools: (agentId: string) =>
      run(withClient((client) => client.agentTools.listAgentTools({ params: { agentId: agentIdOf(agentId) } }))),
    listApprovals: (status?: ApprovalStatus) =>
      run(withClient((client) => client.approvals.listApprovals({ query: status === undefined ? {} : { status } }))),
    approveApproval: (approvalId: string) =>
      run(
        withClient((client) => client.approvals.approveApproval({ params: { approvalId: approvalIdOf(approvalId) } })),
      ),
    denyApproval: (approvalId: string) =>
      run(withClient((client) => client.approvals.denyApproval({ params: { approvalId: approvalIdOf(approvalId) } }))),
    listAudit: (options: { readonly limit?: number; readonly offset?: number } = {}) =>
      run(withClient((client) => client.approvals.listAudit({ query: auditQuery(options) }))),
    listModels: () => run(withClient((client) => client.general.listModels({}))),
    listProviderKeys: () => run(withClient((client) => client.providerKeys.listProviderKeys({}))),
    setProviderKey: (provider: string, payload: SetProviderKeyInput) =>
      run(withClient((client) => client.providerKeys.setProviderKey({ params: { provider }, payload }))),
    removeProviderKey: (provider: string) =>
      run(withClient((client) => client.providerKeys.removeProviderKey({ params: { provider } }))),
    validateModel: (payload: ValidateModelInput) =>
      run(withClient((client) => client.providerKeys.validateModel({ payload }))),
    listSessions: (agentId: string) =>
      run(withClient((client) => client.sessions.listSessions({ params: { agentId: agentIdOf(agentId) } }))),
    deleteSession: (agentId: string, sessionId: string) =>
      run(
        withClient((client) => client.sessions.deleteSession({ params: { agentId: agentIdOf(agentId), sessionId } })),
      ),
    listEvalSessions: () => run(withClient((client) => client.sessions.listEvalSessions({}))),
    getEvalSession: (targetId: string, sessionId: string) =>
      run(withClient((client) => client.sessions.getEvalSession({ params: { targetId, sessionId } }))),
    getAgentRun: (id: string) => run(withClient((client) => client.agentRuns.getAgentRun({ params: { id } }))),
    listEvalDatasets: () => run(withClient((client) => client.evals.listEvalDatasets({}))),
    createEvalDataset: (payload: CreateEvalDatasetInput) =>
      run(withClient((client) => client.evals.createEvalDataset({ payload }))),
    getEvalDataset: (datasetId: string) =>
      run(withClient((client) => client.evals.getEvalDataset({ params: { datasetId: datasetIdOf(datasetId) } }))),
    updateEvalDataset: (datasetId: string, payload: EvalDatasetInput) =>
      run(
        withClient((client) =>
          client.evals.updateEvalDataset({ params: { datasetId: datasetIdOf(datasetId) }, payload }),
        ),
      ),
    removeEvalDataset: (datasetId: string) =>
      run(withClient((client) => client.evals.removeEvalDataset({ params: { datasetId: datasetIdOf(datasetId) } }))),
    addEvalCases: (datasetId: string, payload: AddEvalCasesInput) =>
      run(
        withClient((client) => client.evals.addEvalCases({ params: { datasetId: datasetIdOf(datasetId) }, payload })),
      ),
    updateEvalCase: (datasetId: string, caseId: string, payload: EvalCaseInput) =>
      run(
        withClient((client) =>
          client.evals.updateEvalCase({
            params: { datasetId: datasetIdOf(datasetId), caseId: caseIdOf(caseId) },
            payload,
          }),
        ),
      ),
    removeEvalCases: (datasetId: string, caseIds: ReadonlyArray<string>) =>
      run(
        withClient((client) =>
          client.evals.removeEvalCases({
            params: { datasetId: datasetIdOf(datasetId) },
            payload: { caseIds: caseIds.map((caseId) => caseIdOf(caseId)) },
          }),
        ),
      ),
    listEvalGraders: () => run(withClient((client) => client.evals.listEvalGraders({}))),
    createEvalGrader: (payload: EvalGraderInput) =>
      run(withClient((client) => client.evals.createEvalGrader({ payload }))),
    updateEvalGrader: (graderId: string, payload: EvalGraderInput) =>
      run(
        withClient((client) => client.evals.updateEvalGrader({ params: { graderId: graderIdOf(graderId) }, payload })),
      ),
    removeEvalGrader: (graderId: string) =>
      run(withClient((client) => client.evals.removeEvalGrader({ params: { graderId: graderIdOf(graderId) } }))),
    testEvalGrader: (payload: TestEvalGraderInput) =>
      run(withClient((client) => client.evals.testEvalGrader({ payload }))),
    listEvalRuns: () => run(withClient((client) => client.evals.listEvalRuns({}))),
    startEvalRun: (payload: CreateEvalRunInput) => run(withClient((client) => client.evals.startEvalRun({ payload }))),
    getEvalRun: (runId: string) =>
      run(withClient((client) => client.evals.getEvalRun({ params: { runId: runIdOf(runId) } }))),
    cancelEvalRun: (runId: string) =>
      run(withClient((client) => client.evals.cancelEvalRun({ params: { runId: runIdOf(runId) } }))),
    regradeEvalRun: (runId: string, payload: RegradeEvalRunInput) =>
      run(withClient((client) => client.evals.regradeEvalRun({ params: { runId: runIdOf(runId) }, payload }))),
    removeEvalRun: (runId: string) =>
      run(withClient((client) => client.evals.removeEvalRun({ params: { runId: runIdOf(runId) } }))),
    setEvalReview: (runId: string, trialId: string, payload: SetEvalReviewInput) =>
      run(
        withClient((client) =>
          client.evals.setEvalReview({ params: { runId: runIdOf(runId), trialId: trialIdOf(trialId) }, payload }),
        ),
      ),
    listEvalGates: () => run(withClient((client) => client.evals.listEvalGates({}))),
    createEvalGate: (payload: EvalGateInput) => run(withClient((client) => client.evals.createEvalGate({ payload }))),
    updateEvalGate: (gateId: string, payload: EvalGateInput) =>
      run(withClient((client) => client.evals.updateEvalGate({ params: { gateId: gateIdOf(gateId) }, payload }))),
    removeEvalGate: (gateId: string) =>
      run(withClient((client) => client.evals.removeEvalGate({ params: { gateId: gateIdOf(gateId) } }))),
    runEvalGate: (gateId: string) =>
      run(withClient((client) => client.evals.runEvalGate({ params: { gateId: gateIdOf(gateId) } }))),
    listTraces: (options: { readonly service?: string; readonly limit?: number; readonly q?: string } = {}) =>
      run(withClient((client) => client.traces.listTraces({ query: options }))),
    getTrace: (traceId: string, options: { readonly all?: boolean } = {}) =>
      run(withClient((client) => client.traces.getTrace({ params: { traceId: traceIdOf(traceId) }, query: options }))),
    listTriggers: () => run(withClient((client) => client.triggers.listTriggers({}))),
    addTrigger: (payload: CreateTriggerInput) => run(withClient((client) => client.triggers.addTrigger({ payload }))),
    updateTrigger: (triggerId: string, payload: UpdateTriggerInput) =>
      run(
        withClient((client) =>
          client.triggers.updateTrigger({ params: { triggerId: triggerIdOf(triggerId) }, payload }),
        ),
      ),
    removeTrigger: (triggerId: string) =>
      run(withClient((client) => client.triggers.removeTrigger({ params: { triggerId: triggerIdOf(triggerId) } }))),
    listChannelAccounts: () => run(withClient((client) => client.channels.listChannelAccounts({}))),
    addChannelAccount: (payload: CreateChannelAccountInput) =>
      run(
        withClient((client) =>
          payload.platform === 'discord'
            ? client.channels.addChannelAccount({ payload })
            : client.channels.addChannelAccount({ payload }),
        ),
      ),
    updateChannelAccount: (accountId: string, payload: UpdateChannelAccountInput) =>
      run(
        withClient((client) =>
          payload.platform === 'discord'
            ? client.channels.updateChannelAccount({ params: { accountId: channelAccountIdOf(accountId) }, payload })
            : client.channels.updateChannelAccount({ params: { accountId: channelAccountIdOf(accountId) }, payload }),
        ),
      ),
    removeChannelAccount: (accountId: string) =>
      run(
        withClient((client) =>
          client.channels.removeChannelAccount({ params: { accountId: channelAccountIdOf(accountId) } }),
        ),
      ),
    listChannelAccountStatuses: () => run(withClient((client) => client.channels.listChannelAccountStatuses({}))),
    listChannelBindings: () => run(withClient((client) => client.channels.listChannelBindings({}))),
    addChannelBinding: (payload: CreateChannelBindingInput) =>
      run(withClient((client) => client.channels.addChannelBinding({ payload }))),
    updateChannelBinding: (bindingId: string, payload: UpdateChannelBindingInput) =>
      run(
        withClient((client) =>
          client.channels.updateChannelBinding({ params: { bindingId: channelBindingIdOf(bindingId) }, payload }),
        ),
      ),
    removeChannelBinding: (bindingId: string) =>
      run(
        withClient((client) =>
          client.channels.removeChannelBinding({ params: { bindingId: channelBindingIdOf(bindingId) } }),
        ),
      ),
    getMcpAccess: () => run(withClient((client) => client.mcpAccess.getMcpAccess({}))),
    revokeMcpGrant: (grantId: string) =>
      run(withClient((client) => client.mcpAccess.revokeMcpGrant({ params: { grantId: mcpGrantIdOf(grantId) } }))),
    getMcpAuthorizationRequest: (requestId: string) =>
      run(
        withClient((client) =>
          client.mcpAccess.getMcpAuthorizationRequest({ params: { requestId: mcpRequestIdOf(requestId) } }),
        ),
      ),
    decideMcpAuthorizationRequest: (requestId: string, payload: McpAuthorizationDecision) =>
      run(
        withClient((client) =>
          client.mcpAccess.decideMcpAuthorizationRequest({ params: { requestId: mcpRequestIdOf(requestId) }, payload }),
        ),
      ),
  };
};

export type AgentdockClient = ReturnType<typeof createAgentdockClient>;
