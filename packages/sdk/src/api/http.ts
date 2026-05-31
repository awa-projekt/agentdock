import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';
import { Schema } from 'effect';
import {
  AddMcpSourceInputSchema,
  AddMcpSourceResponseSchema,
  AddGoogleDiscoverySourceInputSchema,
  AddGraphqlSourceInputSchema,
  AddOpenApiSourceInputSchema,
  AgentIdSchema,
  AgentListSchema,
  AgentInternalsResponseSchema,
  AgentSchema,
  AssignAgentSkillsInputSchema,
  AssignAgentSkillsResponseSchema,
  CompleteOAuthInputSchema,
  CompleteOAuthResponseSchema,
  CreateAgentInputSchema,
  CreateSkillInputSchema,
  CreateWorkflowInputSchema,
  DeleteSessionResponseSchema,
  DetectSourceInputSchema,
  DetectSourceResponseSchema,
  EvalSessionDetailSchema,
  EvalSessionsResponseSchema,
  ExecutorMcpProbeError,
  ExecutorOperationError,
  ExecutorSourcesResponseSchema,
  ListTracesQuerySchema,
  LoadSkillResponseSchema,
  McpProbeInputSchema,
  McpProbeResponseSchema,
  PreviewOpenApiInputSchema,
  PullSkillsInputSchema,
  PullSkillsResponseSchema,
  PreviewOpenApiResponseSchema,
  ProbeGoogleDiscoveryInputSchema,
  ProbeGoogleDiscoveryResponseSchema,
  RemoveAgentResponseSchema,
  RemoveExecutorSourceResponseSchema,
  RemoveMcpSourceResponseSchema,
  RemoveSkillResponseSchema,
  RemoveWorkflowResponseSchema,
  SessionOperationError,
  SessionsResponseSchema,
  SetExecutorToolModesInputSchema,
  SetExecutorToolModesResponseSchema,
  SetPinnedExecutorToolsInputSchema,
  SetPinnedExecutorToolsResponseSchema,
  ExecutorSourceIdSchema,
  SkillIdSchema,
  SkillListSchema,
  SkillSchema,
  StartOAuthInputSchema,
  StartOAuthResponseSchema,
  TraceIdSchema,
  SourceAddResponseSchema,
  TraceDetailResponseSchema,
  TraceListResponseSchema,
  TracesOperationError,
  UpdateAgentInputSchema,
  UpdateMcpSourceInputSchema,
  UpdateMcpSourceResponseSchema,
  WorkflowIdSchema,
  UpdateWorkflowInputSchema,
  WorkflowListSchema,
  WorkflowSchema,
} from './schemas';

const AgentIdParamsSchema = Schema.Struct({ agentId: AgentIdSchema });
const SkillIdParamsSchema = Schema.Struct({ skillId: SkillIdSchema });
const WorkflowIdParamsSchema = Schema.Struct({ workflowId: WorkflowIdSchema });
const McpSourceParamsSchema = Schema.Struct({ agentId: AgentIdSchema, sourceId: ExecutorSourceIdSchema });
const ExecutorSourceParamsSchema = Schema.Struct({ agentId: AgentIdSchema, sourceId: ExecutorSourceIdSchema });
const SessionParamsSchema = Schema.Struct({ agentId: AgentIdSchema, sessionId: Schema.String });
const EvalSessionParamsSchema = Schema.Struct({ targetId: Schema.String, sessionId: Schema.String });
const TraceIdParamsSchema = Schema.Struct({ traceId: TraceIdSchema });

export const GeneralApi = HttpApiGroup.make('general').add(
  HttpApiEndpoint.get('health', '/', { success: Schema.String }),
);

export const AgentsApi = HttpApiGroup.make('agents')
  .add(HttpApiEndpoint.get('listAgents', '/', { success: AgentListSchema }))
  .add(HttpApiEndpoint.post('addAgent', '/', {
    payload: CreateAgentInputSchema,
    success: AgentSchema,
  }))
  .add(HttpApiEndpoint.put('updateAgent', '/:agentId', {
    params: AgentIdParamsSchema,
    payload: UpdateAgentInputSchema,
    success: AgentSchema,
  }))
  .add(HttpApiEndpoint.get('getAgentInternals', '/:agentId/internals', {
    params: AgentIdParamsSchema,
    success: AgentInternalsResponseSchema,
  }))
  .add(HttpApiEndpoint.delete('removeAgent', '/:agentId', {
    params: AgentIdParamsSchema,
    success: RemoveAgentResponseSchema,
  }))
  .prefix('/agents');

export const SkillsApi = HttpApiGroup.make('skills')
  .add(HttpApiEndpoint.get('listSkills', '/skills', { success: SkillListSchema }))
  .add(HttpApiEndpoint.post('addSkill', '/skills', {
    payload: CreateSkillInputSchema,
    success: SkillSchema,
  }))
  .add(HttpApiEndpoint.post('pullSkills', '/skills/pull', {
    payload: PullSkillsInputSchema,
    success: PullSkillsResponseSchema,
  }))
  .add(HttpApiEndpoint.delete('removeSkill', '/skills/:skillId', {
    params: SkillIdParamsSchema,
    success: RemoveSkillResponseSchema,
  }))
  .add(HttpApiEndpoint.put('assignAgentSkills', '/agents/:agentId/skills', {
    params: AgentIdParamsSchema,
    payload: AssignAgentSkillsInputSchema,
    success: AssignAgentSkillsResponseSchema,
  }))
  .add(HttpApiEndpoint.get('loadAgentSkill', '/agents/:agentId/skills/:skillId', {
    params: Schema.Struct({ agentId: Schema.String, skillId: Schema.String }),
    success: LoadSkillResponseSchema,
  }));

export const WorkflowsApi = HttpApiGroup.make('workflows')
  .add(HttpApiEndpoint.get('listWorkflows', '/', { success: WorkflowListSchema }))
  .add(HttpApiEndpoint.post('addWorkflow', '/', {
    payload: CreateWorkflowInputSchema,
    success: WorkflowSchema,
  }))
  .add(HttpApiEndpoint.put('updateWorkflow', '/:workflowId', {
    params: WorkflowIdParamsSchema,
    payload: UpdateWorkflowInputSchema,
    success: WorkflowSchema,
  }))
  .add(HttpApiEndpoint.delete('removeWorkflow', '/:workflowId', {
    params: WorkflowIdParamsSchema,
    success: RemoveWorkflowResponseSchema,
  }))
  .prefix('/workflows');

export const AgentExecutorApi = HttpApiGroup.make('agentExecutor')
  .add(HttpApiEndpoint.get('listExecutorSources', '/agents/:agentId/executor/sources', {
    params: AgentIdParamsSchema,
    success: ExecutorSourcesResponseSchema,
    error: ExecutorOperationError,
  }))
  .add(HttpApiEndpoint.post('detectSource', '/agents/:agentId/executor/sources/detect', {
    params: AgentIdParamsSchema,
    payload: DetectSourceInputSchema,
    success: DetectSourceResponseSchema,
    error: ExecutorOperationError,
  }))
  .add(HttpApiEndpoint.post('probeMcpEndpoint', '/agents/:agentId/executor/mcp/probe', {
    params: AgentIdParamsSchema,
    payload: McpProbeInputSchema,
    success: McpProbeResponseSchema,
    error: ExecutorMcpProbeError,
  }))
  .add(HttpApiEndpoint.post('addMcpSource', '/agents/:agentId/executor/mcp/sources', {
    params: AgentIdParamsSchema,
    payload: AddMcpSourceInputSchema,
    success: AddMcpSourceResponseSchema,
    error: ExecutorOperationError,
  }))
  .add(HttpApiEndpoint.put('updateMcpSource', '/agents/:agentId/executor/mcp/sources/:sourceId', {
    params: McpSourceParamsSchema,
    payload: UpdateMcpSourceInputSchema,
    success: UpdateMcpSourceResponseSchema,
    error: ExecutorOperationError,
  }))
  .add(HttpApiEndpoint.delete('removeMcpSource', '/agents/:agentId/executor/mcp/sources/:sourceId', {
    params: McpSourceParamsSchema,
    success: RemoveMcpSourceResponseSchema,
    error: ExecutorOperationError,
  }))
  .add(HttpApiEndpoint.post('previewOpenApiSpec', '/agents/:agentId/executor/openapi/preview', {
    params: AgentIdParamsSchema,
    payload: PreviewOpenApiInputSchema,
    success: PreviewOpenApiResponseSchema,
    error: ExecutorOperationError,
  }))
  .add(HttpApiEndpoint.post('addOpenApiSource', '/agents/:agentId/executor/openapi/sources', {
    params: AgentIdParamsSchema,
    payload: AddOpenApiSourceInputSchema,
    success: SourceAddResponseSchema,
    error: ExecutorOperationError,
  }))
  .add(HttpApiEndpoint.post('addGraphqlSource', '/agents/:agentId/executor/graphql/sources', {
    params: AgentIdParamsSchema,
    payload: AddGraphqlSourceInputSchema,
    success: SourceAddResponseSchema,
    error: ExecutorOperationError,
  }))
  .add(HttpApiEndpoint.post('probeGoogleDiscovery', '/agents/:agentId/executor/google-discovery/probe', {
    params: AgentIdParamsSchema,
    payload: ProbeGoogleDiscoveryInputSchema,
    success: ProbeGoogleDiscoveryResponseSchema,
    error: ExecutorOperationError,
  }))
  .add(HttpApiEndpoint.post('addGoogleDiscoverySource', '/agents/:agentId/executor/google-discovery/sources', {
    params: AgentIdParamsSchema,
    payload: AddGoogleDiscoverySourceInputSchema,
    success: SourceAddResponseSchema,
    error: ExecutorOperationError,
  }))
  .add(HttpApiEndpoint.delete('removeExecutorSource', '/agents/:agentId/executor/sources/:sourceId', {
    params: ExecutorSourceParamsSchema,
    success: RemoveExecutorSourceResponseSchema,
    error: ExecutorOperationError,
  }))
  .add(HttpApiEndpoint.put('setPinnedExecutorTools', '/agents/:agentId/executor/pinned-tools', {
    params: AgentIdParamsSchema,
    payload: SetPinnedExecutorToolsInputSchema,
    success: SetPinnedExecutorToolsResponseSchema,
    error: ExecutorOperationError,
  }))
  .add(HttpApiEndpoint.put('setExecutorToolModes', '/agents/:agentId/executor/tool-modes', {
    params: AgentIdParamsSchema,
    payload: SetExecutorToolModesInputSchema,
    success: SetExecutorToolModesResponseSchema,
    error: ExecutorOperationError,
  }))
  .add(HttpApiEndpoint.post('startExecutorOAuth', '/agents/:agentId/executor/oauth/start', {
    params: AgentIdParamsSchema,
    payload: StartOAuthInputSchema,
    success: StartOAuthResponseSchema,
    error: ExecutorOperationError,
  }))
  .add(HttpApiEndpoint.post('completeExecutorOAuth', '/agents/:agentId/executor/oauth/complete', {
    params: AgentIdParamsSchema,
    payload: CompleteOAuthInputSchema,
    success: CompleteOAuthResponseSchema,
    error: ExecutorOperationError,
  }));

export const SessionsApi = HttpApiGroup.make('sessions')
  .add(HttpApiEndpoint.get('listEvalSessions', '/evals/sessions', {
    success: EvalSessionsResponseSchema,
    error: SessionOperationError,
  }))
  .add(HttpApiEndpoint.get('getEvalSession', '/evals/sessions/:targetId/:sessionId', {
    params: EvalSessionParamsSchema,
    success: EvalSessionDetailSchema,
    error: SessionOperationError,
  }))
  .add(HttpApiEndpoint.get('listSessions', '/agents/:agentId/sessions', {
    params: AgentIdParamsSchema,
    success: SessionsResponseSchema,
    error: SessionOperationError,
  }))
  .add(HttpApiEndpoint.delete('deleteSession', '/agents/:agentId/sessions/:sessionId', {
    params: SessionParamsSchema,
    success: DeleteSessionResponseSchema,
    error: SessionOperationError,
  }));

export const TracesApi = HttpApiGroup.make('traces')
  .add(HttpApiEndpoint.get('listTraces', '/', {
    query: ListTracesQuerySchema,
    success: TraceListResponseSchema,
    error: TracesOperationError,
  }))
  .add(HttpApiEndpoint.get('getTrace', '/:traceId', {
    params: TraceIdParamsSchema,
    success: TraceDetailResponseSchema,
    error: TracesOperationError,
  }))
  .prefix('/traces');

export const AgentdockApi = HttpApi.make('AgentdockApi')
  .add(GeneralApi)
  .add(AgentsApi)
  .add(SkillsApi)
  .add(WorkflowsApi)
  .add(AgentExecutorApi)
  .add(SessionsApi)
  .add(TracesApi);
