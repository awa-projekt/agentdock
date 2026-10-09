import * as HttpApi from 'effect/http-api/HttpApi';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware';
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema';
import * as Schema from 'effect/Schema';
import {
  AddEvalCasesInput,
  AddExternalA2aAgentInput,
  AgentId,
  AgentInternalsResponse,
  AgentList,
  AgentRecord,
  AgentRunRecord,
  AgentRunsResponse,
  AgentToolsResponse,
  ApiFailure,
  ApprovalId,
  ApprovalStatus,
  ApprovalsResponse,
  AuditQuery,
  AuditResponse,
  ChannelAccount,
  ChannelAccountId,
  ChannelAccountList,
  ChannelAccountStatusList,
  ChannelBinding,
  ChannelBindingId,
  ChannelBindingList,
  ConnectIntegrationInput,
  ConnectIntegrationResponse,
  ConnectionName,
  CreateAgentInput,
  CreateChannelAccountInput,
  CreateChannelBindingInput,
  CreateEvalDatasetInput,
  CreateEvalRunInput,
  CreateSkillInput,
  CreateTriggerInput,
  DecideApprovalResponse,
  DeleteSessionResponse,
  DiscoverIntegrationInput,
  DiscoverIntegrationResponse,
  EvalCase,
  EvalCaseId,
  EvalCaseInput,
  EvalCaseList,
  EvalDataset,
  EvalDatasetDetail,
  EvalDatasetId,
  EvalDatasetInput,
  EvalDatasetList,
  EvalGate,
  EvalGateId,
  EvalGateInput,
  EvalGateList,
  EvalGrade,
  EvalGrader,
  EvalGraderId,
  EvalGraderInput,
  EvalGraderList,
  EvalNotFoundError,
  EvalOperationError,
  EvalRun,
  EvalRunDetail,
  EvalRunId,
  EvalRunList,
  EvalSessionDetail,
  EvalSessionsResponse,
  EvalTrial,
  EvalTrialId,
  EvalValidationError,
  ExecuteToolInput,
  ExternalA2aAgent,
  ExternalA2aAgentList,
  GetTraceQuery,
  IntegrationNotFoundError,
  IntegrationOperationError,
  IntegrationSlug,
  IntegrationsResponse,
  IntegrationToolId,
  IntegrationUnreachableError,
  InvocationOutcome,
  JsonObject,
  ListTracesQuery,
  McpAccessError,
  McpAccessNotFoundError,
  McpAccessResponse,
  McpAuthorizationDecision,
  McpAuthorizationRedirect,
  McpAuthorizationRequestId,
  McpAuthorizationRequestView,
  McpGrantId,
  ModelListSchema,
  OAuthSessionView,
  ProvideOAuthClientInput,
  ProviderKeyListSchema,
  ProviderKeySchema,
  PullSkillsInput,
  PullSkillsResponse,
  RefreshConnectionResponse,
  RegisteredWorkflow,
  RegisterWorkflowInput,
  RegradeEvalRunInput,
  RemoveAgentResponse,
  RemoveChannelResponse,
  RemoveConnectionResponse,
  RemoveEvalCasesInput,
  RemoveEvalCasesResponse,
  RemoveEvalResponse,
  RemoveIntegrationResponse,
  RemoveProviderKeyResponseSchema,
  RemoveSkillResponse,
  RemoveTriggerResponse,
  RemoveWorkflowResponse,
  RevokeMcpGrantResponse,
  SearchIntegrationRegistryInput,
  SearchIntegrationRegistryResponse,
  ServerEvent,
  SessionOperationError,
  SessionsResponse,
  SetEvalReviewInput,
  SetProviderKeyInputSchema,
  SetToolDecisionInput,
  Skill,
  SkillId,
  SkillList,
  StartOAuthConnectionInput,
  TestEvalGraderInput,
  TraceDetailResponse,
  TraceId,
  TraceListResponse,
  TracesOperationError,
  Trigger,
  TriggerId,
  TriggerList,
  UpdateAgentInput,
  UpdateChannelAccountInput,
  UpdateChannelBindingInput,
  UpdatedResponse,
  UpdateExternalA2aAgentInput,
  UpdateTriggerInput,
  UserConnectionsResponse,
  ValidateModelInputSchema,
  ValidateModelResultSchema,
  WorkflowArtifactDownload,
  WorkflowId,
  WorkflowList,
  WorkflowRunEventList,
  WorkflowRunId,
  WorkflowRunList,
  WorkflowRunSnapshot,
} from '../schemas';

const AgentIdParams = Schema.Struct({ agentId: AgentId });
const SkillIdParams = Schema.Struct({ skillId: SkillId });
const WorkflowIdParams = Schema.Struct({ workflowId: WorkflowId });
const WorkflowRunIdParams = Schema.Struct({ runId: WorkflowRunId });
const AgentRunIdParams = Schema.Struct({ id: Schema.String });
const IntegrationSlugParams = Schema.Struct({ slug: IntegrationSlug });
const ConnectionParams = Schema.Struct({ slug: IntegrationSlug, name: ConnectionName });
const OAuthSessionParams = Schema.Struct({ sessionId: Schema.String });
const ToolIdParams = Schema.Struct({ toolId: IntegrationToolId });
const ApprovalIdParams = Schema.Struct({ approvalId: ApprovalId });
const SessionParams = Schema.Struct({ agentId: AgentId, sessionId: Schema.String });
const EvalSessionParams = Schema.Struct({ targetId: Schema.String, sessionId: Schema.String });
const TraceIdParams = Schema.Struct({ traceId: TraceId });
const EvalDatasetParams = Schema.Struct({ datasetId: EvalDatasetId });
const EvalCaseParams = Schema.Struct({ datasetId: EvalDatasetId, caseId: EvalCaseId });
const EvalGraderParams = Schema.Struct({ graderId: EvalGraderId });
const EvalRunParams = Schema.Struct({ runId: EvalRunId });
const EvalTrialParams = Schema.Struct({ runId: EvalRunId, trialId: EvalTrialId });
const EvalGateParams = Schema.Struct({ gateId: EvalGateId });
const EvalErrors = [EvalNotFoundError, EvalValidationError, EvalOperationError] as const;
const TriggerIdParams = Schema.Struct({ triggerId: TriggerId });
const ChannelAccountIdParams = Schema.Struct({ accountId: ChannelAccountId });
const ChannelBindingIdParams = Schema.Struct({ bindingId: ChannelBindingId });

const GeneralApi = HttpApiGroup.make('general')
  .add(HttpApiEndpoint.get('health', '/', { success: Schema.String }))
  .add(HttpApiEndpoint.get('listModels', '/models', { success: ModelListSchema }))
  .add(HttpApiEndpoint.get('workflowManifestSchema', '/schemas/workflow-manifest.json', { success: JsonObject }));

const EventsApi = HttpApiGroup.make('events').add(
  HttpApiEndpoint.get('events', '/events', { success: HttpApiSchema.StreamSse({ data: ServerEvent }) }),
);

const ProviderParamsSchema = Schema.Struct({ provider: Schema.String });

const ProviderKeysApi = HttpApiGroup.make('providerKeys')
  .add(HttpApiEndpoint.get('listProviderKeys', '/', { success: ProviderKeyListSchema }))
  .add(
    HttpApiEndpoint.put('setProviderKey', '/:provider', {
      params: ProviderParamsSchema,
      payload: SetProviderKeyInputSchema,
      success: ProviderKeySchema,
    }),
  )
  .add(
    HttpApiEndpoint.delete('removeProviderKey', '/:provider', {
      params: ProviderParamsSchema,
      success: RemoveProviderKeyResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('validateModel', '/validate-model', {
      payload: ValidateModelInputSchema,
      success: ValidateModelResultSchema,
    }),
  )
  .prefix('/provider-keys');

const AgentsApi = HttpApiGroup.make('agents')
  .add(HttpApiEndpoint.get('listAgents', '/', { success: AgentList }))
  .add(HttpApiEndpoint.get('listExternalAgents', '/external', { success: ExternalA2aAgentList }))
  .add(
    HttpApiEndpoint.post('addAgent', '/', {
      payload: CreateAgentInput,
      success: AgentRecord,
    }),
  )
  .add(
    HttpApiEndpoint.post('addExternalAgent', '/external', {
      payload: AddExternalA2aAgentInput,
      success: ExternalA2aAgent,
    }),
  )
  .add(
    HttpApiEndpoint.put('updateExternalAgent', '/external/:agentId', {
      params: AgentIdParams,
      payload: UpdateExternalA2aAgentInput,
      success: ExternalA2aAgent,
    }),
  )
  .add(
    HttpApiEndpoint.delete('removeExternalAgent', '/external/:agentId', {
      params: AgentIdParams,
      success: RemoveAgentResponse,
    }),
  )
  .add(
    HttpApiEndpoint.put('updateAgent', '/:agentId', {
      params: AgentIdParams,
      payload: UpdateAgentInput,
      success: AgentRecord,
    }),
  )
  .add(
    HttpApiEndpoint.get('getAgentInternals', '/:agentId/internals', {
      params: AgentIdParams,
      success: AgentInternalsResponse,
    }),
  )
  .add(
    HttpApiEndpoint.delete('removeAgent', '/:agentId', {
      params: AgentIdParams,
      success: RemoveAgentResponse,
    }),
  )
  .prefix('/agents');

const SkillsApi = HttpApiGroup.make('skills')
  .add(HttpApiEndpoint.get('listSkills', '/skills', { success: SkillList }))
  .add(
    HttpApiEndpoint.post('addSkill', '/skills', {
      payload: CreateSkillInput,
      success: Skill,
    }),
  )
  .add(
    HttpApiEndpoint.post('pullSkills', '/skills/pull', {
      payload: PullSkillsInput,
      success: PullSkillsResponse,
    }),
  )
  .add(
    HttpApiEndpoint.delete('removeSkill', '/skills/:skillId', {
      params: SkillIdParams,
      success: RemoveSkillResponse,
    }),
  );

const WorkflowsApi = HttpApiGroup.make('workflows')
  .add(HttpApiEndpoint.get('listWorkflows', '/', { success: WorkflowList }))
  .add(
    // Uploading an artifact whose manifest name is already registered bumps
    // that workflow's revision instead of creating a second one.
    HttpApiEndpoint.post('registerWorkflow', '/', {
      payload: RegisterWorkflowInput,
      success: RegisteredWorkflow,
    }),
  )
  .add(
    HttpApiEndpoint.delete('removeWorkflow', '/:workflowId', {
      params: WorkflowIdParams,
      success: RemoveWorkflowResponse,
    }),
  )
  .add(
    HttpApiEndpoint.get('downloadWorkflowArtifact', '/:workflowId/artifact', {
      params: WorkflowIdParams,
      success: WorkflowArtifactDownload,
    }),
  )
  .add(HttpApiEndpoint.get('listWorkflowRuns', '/runs', { success: WorkflowRunList }))
  .add(
    HttpApiEndpoint.get('getWorkflowRun', '/runs/:runId', {
      params: WorkflowRunIdParams,
      success: WorkflowRunSnapshot,
    }),
  )
  .add(
    HttpApiEndpoint.get('listWorkflowRunEvents', '/runs/:runId/events', {
      params: WorkflowRunIdParams,
      success: WorkflowRunEventList,
    }),
  )
  .add(
    // Every agent call this workflow run made, individually inspectable
    // (`AgentRunStore.listByWorkflowRun`).
    HttpApiEndpoint.get('listWorkflowRunAgentRuns', '/runs/:runId/agent-runs', {
      params: WorkflowRunIdParams,
      success: AgentRunsResponse,
    }),
  )
  .prefix('/workflows');

const AgentRunsApi = HttpApiGroup.make('agentRuns')
  .add(
    HttpApiEndpoint.get('getAgentRun', '/:id', {
      params: AgentRunIdParams,
      success: AgentRunRecord,
    }),
  )
  .prefix('/agent-runs');

const TriggersApi = HttpApiGroup.make('triggers')
  .add(HttpApiEndpoint.get('listTriggers', '/', { success: TriggerList }))
  .add(
    HttpApiEndpoint.post('addTrigger', '/', {
      payload: CreateTriggerInput,
      success: Trigger,
    }),
  )
  .add(
    HttpApiEndpoint.put('updateTrigger', '/:triggerId', {
      params: TriggerIdParams,
      payload: UpdateTriggerInput,
      success: Trigger,
    }),
  )
  .add(
    HttpApiEndpoint.delete('removeTrigger', '/:triggerId', {
      params: TriggerIdParams,
      success: RemoveTriggerResponse,
    }),
  )
  .prefix('/triggers');

const ChannelsApi = HttpApiGroup.make('channels')
  .add(HttpApiEndpoint.get('listChannelAccounts', '/accounts', { success: ChannelAccountList }))
  .add(
    HttpApiEndpoint.post('addChannelAccount', '/accounts', {
      payload: CreateChannelAccountInput,
      success: ChannelAccount,
    }),
  )
  .add(
    HttpApiEndpoint.put('updateChannelAccount', '/accounts/:accountId', {
      params: ChannelAccountIdParams,
      payload: UpdateChannelAccountInput,
      success: ChannelAccount,
    }),
  )
  .add(
    HttpApiEndpoint.delete('removeChannelAccount', '/accounts/:accountId', {
      params: ChannelAccountIdParams,
      success: RemoveChannelResponse,
    }),
  )
  .add(HttpApiEndpoint.get('listChannelAccountStatuses', '/accounts/status', { success: ChannelAccountStatusList }))
  .add(HttpApiEndpoint.get('listChannelBindings', '/bindings', { success: ChannelBindingList }))
  .add(
    HttpApiEndpoint.post('addChannelBinding', '/bindings', {
      payload: CreateChannelBindingInput,
      success: ChannelBinding,
    }),
  )
  .add(
    HttpApiEndpoint.put('updateChannelBinding', '/bindings/:bindingId', {
      params: ChannelBindingIdParams,
      payload: UpdateChannelBindingInput,
      success: ChannelBinding,
    }),
  )
  .add(
    HttpApiEndpoint.delete('removeChannelBinding', '/bindings/:bindingId', {
      params: ChannelBindingIdParams,
      success: RemoveChannelResponse,
    }),
  )
  .prefix('/channels');

const IntegrationsApi = HttpApiGroup.make('integrations')
  .add(
    HttpApiEndpoint.get('listIntegrations', '/integrations', {
      success: IntegrationsResponse,
      error: [IntegrationOperationError, IntegrationNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.post('searchIntegrationRegistry', '/integrations/registry/search', {
      payload: SearchIntegrationRegistryInput,
      success: SearchIntegrationRegistryResponse,
      error: IntegrationOperationError,
    }),
  )
  .add(
    HttpApiEndpoint.post('discoverIntegration', '/integrations/discover', {
      payload: DiscoverIntegrationInput,
      success: DiscoverIntegrationResponse,
      error: [IntegrationOperationError, IntegrationNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.delete('removeIntegration', '/integrations/:slug', {
      params: IntegrationSlugParams,
      success: RemoveIntegrationResponse,
      error: [IntegrationOperationError, IntegrationNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.post('connectIntegration', '/integrations/:slug/connections', {
      params: IntegrationSlugParams,
      payload: ConnectIntegrationInput,
      success: ConnectIntegrationResponse,
      error: [IntegrationOperationError, IntegrationNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.post('startOAuthConnection', '/integrations/:slug/connections/oauth', {
      params: IntegrationSlugParams,
      payload: StartOAuthConnectionInput,
      success: OAuthSessionView,
      error: [IntegrationOperationError, IntegrationNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.delete('removeConnection', '/integrations/:slug/connections/:name', {
      params: ConnectionParams,
      success: RemoveConnectionResponse,
      error: [IntegrationOperationError, IntegrationNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.post('refreshConnection', '/integrations/:slug/connections/:name/refresh', {
      params: ConnectionParams,
      success: RefreshConnectionResponse,
      error: [IntegrationOperationError, IntegrationNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.get('getOAuthSession', '/oauth-sessions/:sessionId', {
      params: OAuthSessionParams,
      success: OAuthSessionView,
      error: [IntegrationOperationError, IntegrationNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.post('provideOAuthClient', '/oauth-sessions/:sessionId/client', {
      params: OAuthSessionParams,
      payload: ProvideOAuthClientInput,
      success: OAuthSessionView,
      error: [IntegrationOperationError, IntegrationNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.get('listUserConnections', '/me/connections', {
      success: UserConnectionsResponse,
      error: [IntegrationOperationError, IntegrationNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.post('connectUserIntegration', '/me/connections/:slug', {
      params: IntegrationSlugParams,
      payload: ConnectIntegrationInput,
      success: ConnectIntegrationResponse,
      error: [IntegrationOperationError, IntegrationNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.post('startUserOAuthConnection', '/me/connections/:slug/oauth', {
      params: IntegrationSlugParams,
      payload: StartOAuthConnectionInput,
      success: OAuthSessionView,
      error: [IntegrationOperationError, IntegrationNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.delete('removeUserConnection', '/me/connections/:slug/:name', {
      params: ConnectionParams,
      success: RemoveConnectionResponse,
      error: [IntegrationOperationError, IntegrationNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.post('executeTool', '/tools/execute', {
      payload: ExecuteToolInput,
      success: InvocationOutcome,
      error: [IntegrationOperationError, IntegrationNotFoundError, IntegrationUnreachableError],
    }),
  )
  .add(
    HttpApiEndpoint.put('setToolDecision', '/tools/:toolId/decision', {
      params: ToolIdParams,
      payload: SetToolDecisionInput,
      success: UpdatedResponse,
      error: [IntegrationOperationError, IntegrationNotFoundError],
    }),
  );

const AgentToolsApi = HttpApiGroup.make('agentTools').add(
  HttpApiEndpoint.get('listAgentTools', '/agents/:agentId/tools', {
    params: AgentIdParams,
    success: AgentToolsResponse,
    error: [IntegrationOperationError, IntegrationNotFoundError],
  }),
);

const ApprovalsApi = HttpApiGroup.make('approvals')
  .add(
    HttpApiEndpoint.get('listApprovals', '/approvals', {
      query: Schema.Struct({ status: Schema.optional(ApprovalStatus) }),
      success: ApprovalsResponse,
      error: [IntegrationOperationError, IntegrationNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.post('approveApproval', '/approvals/:approvalId/approve', {
      params: ApprovalIdParams,
      success: DecideApprovalResponse,
      error: [IntegrationOperationError, IntegrationNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.post('denyApproval', '/approvals/:approvalId/deny', {
      params: ApprovalIdParams,
      success: DecideApprovalResponse,
      error: [IntegrationOperationError, IntegrationNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.get('listAudit', '/audit', {
      query: AuditQuery,
      success: AuditResponse,
      error: [IntegrationOperationError, IntegrationNotFoundError],
    }),
  );

const SessionsApi = HttpApiGroup.make('sessions')
  .add(
    HttpApiEndpoint.get('listEvalSessions', '/evals/sessions', {
      success: EvalSessionsResponse,
      error: SessionOperationError,
    }),
  )
  .add(
    HttpApiEndpoint.get('getEvalSession', '/evals/sessions/:targetId/:sessionId', {
      params: EvalSessionParams,
      success: EvalSessionDetail,
      error: SessionOperationError,
    }),
  )
  .add(
    HttpApiEndpoint.get('listSessions', '/agents/:agentId/sessions', {
      params: AgentIdParams,
      success: SessionsResponse,
      error: SessionOperationError,
    }),
  )
  .add(
    HttpApiEndpoint.delete('deleteSession', '/agents/:agentId/sessions/:sessionId', {
      params: SessionParams,
      success: DeleteSessionResponse,
      error: SessionOperationError,
    }),
  );

/**
 * Datasets of cases, graders that score a target's answers, and runs that
 * send every case to an agent or workflow. Runs execute in the background;
 * `getEvalRun` reports their progress.
 */
const EvalsApi = HttpApiGroup.make('evals')
  .add(HttpApiEndpoint.get('listEvalDatasets', '/datasets', { success: EvalDatasetList, error: EvalErrors }))
  .add(
    HttpApiEndpoint.post('createEvalDataset', '/datasets', {
      payload: CreateEvalDatasetInput,
      success: EvalDataset,
      error: EvalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get('getEvalDataset', '/datasets/:datasetId', {
      params: EvalDatasetParams,
      success: EvalDatasetDetail,
      error: EvalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.put('updateEvalDataset', '/datasets/:datasetId', {
      params: EvalDatasetParams,
      payload: EvalDatasetInput,
      success: EvalDataset,
      error: EvalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete('removeEvalDataset', '/datasets/:datasetId', {
      params: EvalDatasetParams,
      success: RemoveEvalResponse,
      error: EvalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post('addEvalCases', '/datasets/:datasetId/cases', {
      params: EvalDatasetParams,
      payload: AddEvalCasesInput,
      success: EvalCaseList,
      error: EvalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.put('updateEvalCase', '/datasets/:datasetId/cases/:caseId', {
      params: EvalCaseParams,
      payload: EvalCaseInput,
      success: EvalCase,
      error: EvalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post('removeEvalCases', '/datasets/:datasetId/cases/remove', {
      params: EvalDatasetParams,
      payload: RemoveEvalCasesInput,
      success: RemoveEvalCasesResponse,
      error: EvalErrors,
    }),
  )
  .add(HttpApiEndpoint.get('listEvalGraders', '/graders', { success: EvalGraderList, error: EvalErrors }))
  .add(
    HttpApiEndpoint.post('createEvalGrader', '/graders', {
      payload: EvalGraderInput,
      success: EvalGrader,
      error: EvalErrors,
    }),
  )
  .add(
    // Grades one hand-written output. An LLM judge makes a single model call.
    HttpApiEndpoint.post('testEvalGrader', '/graders/test', {
      payload: TestEvalGraderInput,
      success: EvalGrade,
      error: EvalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.put('updateEvalGrader', '/graders/:graderId', {
      params: EvalGraderParams,
      payload: EvalGraderInput,
      success: EvalGrader,
      error: EvalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete('removeEvalGrader', '/graders/:graderId', {
      params: EvalGraderParams,
      success: RemoveEvalResponse,
      error: EvalErrors,
    }),
  )
  .add(HttpApiEndpoint.get('listEvalRuns', '/runs', { success: EvalRunList, error: EvalErrors }))
  .add(
    HttpApiEndpoint.post('startEvalRun', '/runs', {
      payload: CreateEvalRunInput,
      success: EvalRun,
      error: EvalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get('getEvalRun', '/runs/:runId', {
      params: EvalRunParams,
      success: EvalRunDetail,
      error: EvalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post('cancelEvalRun', '/runs/:runId/cancel', {
      params: EvalRunParams,
      success: EvalRun,
      error: EvalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post('regradeEvalRun', '/runs/:runId/regrade', {
      params: EvalRunParams,
      payload: RegradeEvalRunInput,
      success: EvalRun,
      error: EvalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete('removeEvalRun', '/runs/:runId', {
      params: EvalRunParams,
      success: RemoveEvalResponse,
      error: EvalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.put('setEvalReview', '/runs/:runId/trials/:trialId/review', {
      params: EvalTrialParams,
      payload: SetEvalReviewInput,
      success: EvalTrial,
      error: EvalErrors,
    }),
  )
  .add(HttpApiEndpoint.get('listEvalGates', '/gates', { success: EvalGateList, error: EvalErrors }))
  .add(
    // A gate reruns its dataset against the agent whenever the agent's instructions, model,
    // reasoning effort or skills change, and each such run costs a full run's model calls.
    HttpApiEndpoint.post('createEvalGate', '/gates', {
      payload: EvalGateInput,
      success: EvalGate,
      error: EvalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.put('updateEvalGate', '/gates/:gateId', {
      params: EvalGateParams,
      payload: EvalGateInput,
      success: EvalGate,
      error: EvalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete('removeEvalGate', '/gates/:gateId', {
      params: EvalGateParams,
      success: RemoveEvalResponse,
      error: EvalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post('runEvalGate', '/gates/:gateId/run', {
      params: EvalGateParams,
      success: EvalRun,
      error: EvalErrors,
    }),
  )
  .prefix('/evals');

const TracesApi = HttpApiGroup.make('traces')
  .add(
    HttpApiEndpoint.get('listTraces', '/', {
      query: ListTracesQuery,
      success: TraceListResponse,
      error: TracesOperationError,
    }),
  )
  .add(
    HttpApiEndpoint.get('getTrace', '/:traceId', {
      params: TraceIdParams,
      query: GetTraceQuery,
      success: TraceDetailResponse,
      error: TracesOperationError,
    }),
  )
  .prefix('/traces');

const McpAccessApi = HttpApiGroup.make('mcpAccess')
  .add(
    HttpApiEndpoint.get('getMcpAccess', '/', {
      success: McpAccessResponse,
      error: [McpAccessError, McpAccessNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.delete('revokeMcpGrant', '/grants/:grantId', {
      params: Schema.Struct({ grantId: McpGrantId }),
      success: RevokeMcpGrantResponse,
      error: [McpAccessError, McpAccessNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.get('getMcpAuthorizationRequest', '/requests/:requestId', {
      params: Schema.Struct({ requestId: McpAuthorizationRequestId }),
      success: McpAuthorizationRequestView,
      error: [McpAccessError, McpAccessNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.post('decideMcpAuthorizationRequest', '/requests/:requestId', {
      params: Schema.Struct({ requestId: McpAuthorizationRequestId }),
      payload: McpAuthorizationDecision,
      success: McpAuthorizationRedirect,
      error: [McpAccessError, McpAccessNotFoundError],
    }),
  )
  .prefix('/mcp-access');

/** Every endpoint passes through here, so this is where a client learns any call can end in a 500. */
export class ServerFailures extends HttpApiMiddleware.Service<ServerFailures>()('@agentdock/sdk/ServerFailures', {
  error: ApiFailure.pipe(HttpApiSchema.status(500)),
}) {}

export const AgentdockApi = HttpApi.make('AgentdockApi')
  .add(GeneralApi)
  .add(EventsApi)
  .add(ProviderKeysApi)
  .add(AgentsApi)
  .add(SkillsApi)
  .add(WorkflowsApi)
  .add(TriggersApi)
  .add(ChannelsApi)
  .add(IntegrationsApi)
  .add(AgentToolsApi)
  .add(ApprovalsApi)
  .add(SessionsApi)
  .add(EvalsApi)
  .add(TracesApi)
  .add(AgentRunsApi)
  .add(McpAccessApi)
  .middleware(ServerFailures);
