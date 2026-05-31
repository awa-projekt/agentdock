import { Schema } from 'effect';

export const AgentIdSchema = Schema.String.pipe(Schema.brand('AgentId'));
export const SkillIdSchema = Schema.String.pipe(Schema.brand('SkillId'));
export const WorkflowIdSchema = Schema.String.pipe(Schema.brand('WorkflowId'));
export const ExecutorSourceIdSchema = Schema.String.pipe(Schema.brand('ExecutorSourceId'));
export const ExecutorToolIdSchema = Schema.String.pipe(Schema.brand('ExecutorToolId'));
export const TraceIdSchema = Schema.String.pipe(Schema.brand('TraceId'));

export const AgentCapabilitiesSchema = Schema.Struct({
  pushNotifications: Schema.Boolean,
  streaming: Schema.Boolean,
});

export const AgentCommunicationToolConfigSchema = Schema.Struct({
  allowAll: Schema.Boolean,
  allowedAgentIds: Schema.Array(Schema.String),
});

export const CreateAgentInputSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  tools: Schema.Array(Schema.String),
  skillIds: Schema.Array(Schema.String),
  communication: AgentCommunicationToolConfigSchema,
  instructions: Schema.String,
  model: Schema.String,
  version: Schema.String,
  capabilities: AgentCapabilitiesSchema,
  defaultInputModes: Schema.Array(Schema.String),
  defaultOutputModes: Schema.Array(Schema.String),
});

export const AgentVisibilitySchema = Schema.Literals(['public', 'internal']);

export const AgentSchema = Schema.Struct({
  id: AgentIdSchema,
  visibility: AgentVisibilitySchema,
  name: Schema.String,
  description: Schema.String,
  tools: Schema.Array(Schema.String),
  skillIds: Schema.Array(Schema.String),
  communication: AgentCommunicationToolConfigSchema,
  instructions: Schema.String,
  model: Schema.String,
  version: Schema.String,
  capabilities: AgentCapabilitiesSchema,
  defaultInputModes: Schema.Array(Schema.String),
  defaultOutputModes: Schema.Array(Schema.String),
});

export const AgentPathSchema = Schema.Struct({
  agentId: AgentIdSchema,
});

export const UpdateAgentInputSchema = CreateAgentInputSchema;
export const AgentListSchema = Schema.Array(AgentSchema);

export const AgentModelInfoSchema = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  name: Schema.String,
  contextWindow: Schema.optional(Schema.Number),
  maxOutputTokens: Schema.optional(Schema.Number),
  inputCostPerMillion: Schema.optional(Schema.Number),
  outputCostPerMillion: Schema.optional(Schema.Number),
});

export const AgentInternalsToolSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  source: Schema.Literals(['internal', 'executor']),
  description: Schema.String,
  active: Schema.Boolean,
  mode: Schema.optional(Schema.Literals(['native', 'discoverable', 'disabled'])),
});

export const AgentInternalsPromptSchema = Schema.Struct({
  editableInstructions: Schema.String,
  finalInstructions: Schema.String,
  tokenCount: Schema.Number,
});

export const AgentInternalsResponseSchema = Schema.Struct({
  agentId: AgentIdSchema,
  model: AgentModelInfoSchema,
  tools: Schema.Array(AgentInternalsToolSchema),
  prompt: AgentInternalsPromptSchema,
});

export const WorkflowPositionSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});

export const WorkflowNodeTypeSchema = Schema.Literals(['input', 'template', 'condition', 'agent', 'output']);

export const WorkflowNodeDataSchema = Schema.Struct({
  label: Schema.String,
  template: Schema.optional(Schema.String),
  conditionExpression: Schema.optional(Schema.String),
  agentId: Schema.optional(Schema.String),
});

export const WorkflowNodeSchema = Schema.Struct({
  id: Schema.String,
  type: WorkflowNodeTypeSchema,
  position: WorkflowPositionSchema,
  data: WorkflowNodeDataSchema,
});

export const WorkflowEdgeSchema = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  target: Schema.String,
  condition: Schema.optional(Schema.Literals(['true', 'false'])),
});

export const WorkflowGraphSchema = Schema.Struct({
  nodes: Schema.Array(WorkflowNodeSchema),
  edges: Schema.Array(WorkflowEdgeSchema),
});

export const CreateWorkflowInputSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  version: Schema.String,
  graph: WorkflowGraphSchema,
});

export const WorkflowSchema = Schema.Struct({
  id: WorkflowIdSchema,
  name: Schema.String,
  description: Schema.String,
  version: Schema.String,
  graph: WorkflowGraphSchema,
});

export const UpdateWorkflowInputSchema = CreateWorkflowInputSchema;
export const WorkflowListSchema = Schema.Array(WorkflowSchema);

export const RemoveResourceResponseSchema = Schema.Struct({
  removed: Schema.Boolean,
});

export const RemoveAgentResponseSchema = RemoveResourceResponseSchema;
export const RemoveWorkflowResponseSchema = RemoveResourceResponseSchema;
export const RemoveSkillResponseSchema = RemoveResourceResponseSchema;

export const SkillSchema = Schema.Struct({
  id: SkillIdSchema,
  name: Schema.String,
  description: Schema.String,
  content: Schema.String,
  license: Schema.optional(Schema.String),
  compatibility: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const SkillListSchema = Schema.Array(SkillSchema);

export const CreateSkillInputSchema = Schema.Struct({
  content: Schema.String,
  source: Schema.optional(Schema.String),
});

export const PullSkillsInputSchema = Schema.Struct({
  source: Schema.String,
  skills: Schema.Array(Schema.String),
});

export const PullSkillsResponseSchema = Schema.Struct({
  skills: SkillListSchema,
});

export const AssignAgentSkillsInputSchema = Schema.Struct({
  skillIds: Schema.Array(Schema.String),
});

export const AssignAgentSkillsResponseSchema = Schema.Struct({
  updated: Schema.Boolean,
});

export const LoadSkillResponseSchema = Schema.Struct({
  skill: SkillSchema,
});

export const ExecutorSourceSchema = Schema.Struct({
  id: Schema.String,
  scopeId: Schema.optional(Schema.String),
  kind: Schema.String,
  name: Schema.String,
  url: Schema.optional(Schema.String),
  pluginId: Schema.String,
  canRemove: Schema.Boolean,
  canRefresh: Schema.Boolean,
  canEdit: Schema.Boolean,
  runtime: Schema.Boolean,
  toolCount: Schema.Number,
});

export const ExecutorToolSchema = Schema.Struct({
  id: Schema.String,
  sourceId: Schema.String,
  pluginId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  pinned: Schema.Boolean,
  mode: Schema.Literals(['native', 'discoverable', 'disabled']),
  inputSchema: Schema.optional(Schema.Unknown),
  outputSchema: Schema.optional(Schema.Unknown),
});

export const ExecutorSourcesResponseSchema = Schema.Struct({
  sources: Schema.Array(ExecutorSourceSchema),
  tools: Schema.Array(ExecutorToolSchema),
});

export const SetPinnedExecutorToolsInputSchema = Schema.Struct({
  toolIds: Schema.Array(Schema.String),
});

export const SetPinnedExecutorToolsResponseSchema = Schema.Struct({
  updated: Schema.Boolean,
});

export const ExecutorToolModeSchema = Schema.Literals(['native', 'discoverable', 'disabled']);

export const SetExecutorToolModesInputSchema = Schema.Struct({
  modes: Schema.Array(Schema.Struct({
    toolId: Schema.String,
    mode: ExecutorToolModeSchema,
  })),
});

export const SetExecutorToolModesResponseSchema = Schema.Struct({
  updated: Schema.Boolean,
});

export const SourceDetectionResultSchema = Schema.Struct({
  kind: Schema.String,
  confidence: Schema.Literals(['high', 'medium', 'low']),
  endpoint: Schema.String,
  name: Schema.String,
  namespace: Schema.String,
});

export const DetectSourceInputSchema = Schema.Struct({
  url: Schema.String,
});

export const DetectSourceResponseSchema = Schema.Struct({
  results: Schema.Array(SourceDetectionResultSchema),
});

export const McpProbeInputSchema = Schema.Struct({
  endpoint: Schema.String,
});

export const McpProbeResponseSchema = Schema.Struct({
  connected: Schema.Boolean,
  requiresOAuth: Schema.Boolean,
  supportsDynamicRegistration: Schema.Boolean,
  name: Schema.String,
  namespace: Schema.String,
  toolCount: Schema.NullOr(Schema.Number),
  serverName: Schema.NullOr(Schema.String),
});

export class ExecutorMcpProbeError extends Schema.TaggedErrorClass<ExecutorMcpProbeError>()(
  'ExecutorMcpProbeError',
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class ExecutorOperationError extends Schema.TaggedErrorClass<ExecutorOperationError>()(
  'ExecutorOperationError',
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

export const McpSourceAuthInputSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('none') }),
  Schema.Struct({
    kind: Schema.Literal('oauth2'),
    connectionId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('header'),
    headerName: Schema.String,
    token: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal('queryParam'),
    paramName: Schema.String,
    token: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
]);

export const AddMcpSourceInputSchema = Schema.Struct({
  name: Schema.String,
  endpoint: Schema.String,
  namespace: Schema.optional(Schema.String),
  auth: Schema.optional(McpSourceAuthInputSchema),
});

export const AddMcpSourceResponseSchema = Schema.Struct({
  namespace: Schema.String,
  toolCount: Schema.Number,
});

export const UpdateMcpSourceInputSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  endpoint: Schema.optional(Schema.String),
  auth: Schema.optional(Schema.Union([
    Schema.Struct({ kind: Schema.Literal('none') }),
    Schema.Struct({
      kind: Schema.Literal('header'),
      headerName: Schema.String,
      token: Schema.String,
      prefix: Schema.optional(Schema.String),
    }),
    Schema.Struct({
      kind: Schema.Literal('queryParam'),
      paramName: Schema.String,
      token: Schema.String,
      prefix: Schema.optional(Schema.String),
    }),
  ])),
});

export const UpdateMcpSourceResponseSchema = Schema.Struct({
  updated: Schema.Boolean,
});

export const RemoveMcpSourceResponseSchema = RemoveResourceResponseSchema;

export const SourceStaticAuthInputSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('none') }),
  Schema.Struct({
    kind: Schema.Literal('header'),
    headerName: Schema.String,
    token: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal('queryParam'),
    paramName: Schema.String,
    token: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
]);

export const SourceAddResponseSchema = Schema.Struct({
  namespace: Schema.String,
  toolCount: Schema.Number,
  authorizationUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

export const SourceUpdateResponseSchema = UpdateMcpSourceResponseSchema;
export const RemoveExecutorSourceResponseSchema = RemoveResourceResponseSchema;

export const OpenApiSpecInputSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('url'), url: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('blob'), value: Schema.String }),
]);

export const PreviewOpenApiInputSchema = Schema.Struct({
  spec: OpenApiSpecInputSchema,
});

export const PreviewOpenApiResponseSchema = Schema.Unknown;

export const OpenApiOAuthInputSchema = Schema.Struct({
  flow: Schema.Literals(['authorizationCode', 'clientCredentials']),
  securitySchemeName: Schema.String,
  tokenUrl: Schema.String,
  authorizationUrl: Schema.optional(Schema.NullOr(Schema.String)),
  scopes: Schema.Array(Schema.String),
  clientId: Schema.String,
  clientSecret: Schema.optional(Schema.String),
  clientAuth: Schema.optional(Schema.Literals(['body', 'basic'])),
});

export const AddOpenApiSourceInputSchema = Schema.Struct({
  spec: OpenApiSpecInputSchema,
  name: Schema.String,
  baseUrl: Schema.String,
  namespace: Schema.String,
  auth: Schema.optional(SourceStaticAuthInputSchema),
  oauth2: Schema.optional(OpenApiOAuthInputSchema),
});

export const AddGraphqlSourceInputSchema = Schema.Struct({
  endpoint: Schema.String,
  name: Schema.String,
  namespace: Schema.String,
  introspectionJson: Schema.optional(Schema.String),
  auth: Schema.optional(SourceStaticAuthInputSchema),
});

export const ProbeGoogleDiscoveryInputSchema = Schema.Struct({
  discoveryUrl: Schema.String,
});

export const ProbeGoogleDiscoveryResponseSchema = Schema.Unknown;

export const GoogleDiscoveryOAuthInputSchema = Schema.Struct({
  clientId: Schema.String,
  clientSecret: Schema.optional(Schema.String),
  scopes: Schema.Array(Schema.String),
});

export const AddGoogleDiscoverySourceInputSchema = Schema.Struct({
  discoveryUrl: Schema.String,
  name: Schema.String,
  namespace: Schema.optional(Schema.String),
  auth: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('none') }),
    Schema.Struct({ kind: Schema.Literal('oauth2'), oauth2: GoogleDiscoveryOAuthInputSchema }),
  ]),
});

export const StartOAuthInputSchema = Schema.Struct({
  endpoint: Schema.String,
  name: Schema.String,
  namespace: Schema.String,
  redirectUrl: Schema.String,
});

export const StartOAuthResponseSchema = Schema.Struct({
  connectionId: Schema.String,
  sessionId: Schema.String,
  authorizationUrl: Schema.NullOr(Schema.String),
});

export const CompleteOAuthInputSchema = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

export const CompleteOAuthResponseSchema = Schema.Struct({
  connectionId: Schema.String,
  expiresAt: Schema.NullOr(Schema.Number),
  scope: Schema.NullOr(Schema.String),
});

export const SessionMessageEventSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  summary: Schema.String,
  details: Schema.optional(Schema.String),
  rawEvent: Schema.optional(Schema.Unknown),
  at: Schema.Number,
});

export const SessionMessageSchema = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(['user', 'assistant']),
  text: Schema.String,
  events: Schema.optional(Schema.Array(SessionMessageEventSchema)),
});

export const SessionSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  messages: Schema.Array(SessionMessageSchema),
  conversationState: Schema.Struct({
    contextId: Schema.String,
    taskId: Schema.optional(Schema.String),
  }),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const SessionsResponseSchema = Schema.Struct({
  sessions: Schema.Array(SessionSchema),
});

export const EvalTargetSchema = Schema.Struct({
  kind: Schema.Literals(['agent', 'workflow', 'unknown']),
  id: Schema.String,
  name: Schema.String,
});

export const EvalToolActionSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  toolName: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});

export const EvalMessageSchema = Schema.Struct({
  id: Schema.String,
  role: Schema.String,
  text: Schema.String,
  parts: Schema.Array(Schema.Unknown),
  createdAt: Schema.optional(Schema.Number),
});

export const EvalOutcomeSchema = Schema.Struct({
  state: Schema.optional(Schema.String),
  text: Schema.String,
  actions: Schema.Array(EvalToolActionSchema),
});

export const EvalSessionSummarySchema = Schema.Struct({
  id: Schema.String,
  target: EvalTargetSchema,
  title: Schema.String,
  initialMessage: Schema.String,
  outcome: EvalOutcomeSchema,
  messageCount: Schema.Number,
  actionCount: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const EvalSessionDetailSchema = Schema.Struct({
  id: Schema.String,
  target: EvalTargetSchema,
  title: Schema.String,
  initialMessage: Schema.String,
  messages: Schema.Array(EvalMessageSchema),
  outcome: EvalOutcomeSchema,
  task: Schema.optional(Schema.Unknown),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const EvalSessionsResponseSchema = Schema.Struct({
  sessions: Schema.Array(EvalSessionSummarySchema),
});

export const DeleteSessionResponseSchema = Schema.Struct({
  deleted: Schema.Boolean,
});

export class SessionOperationError extends Schema.TaggedErrorClass<SessionOperationError>()(
  'SessionOperationError',
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

export const TraceSummarySchema = Schema.Struct({
  traceId: Schema.String,
  rootServiceName: Schema.String,
  rootTraceName: Schema.String,
  startTimeUnixNano: Schema.String,
  durationMs: Schema.Number,
});

export const TraceListResponseSchema = Schema.Struct({
  traces: Schema.Array(TraceSummarySchema),
});

export const TraceEventSchema = Schema.Struct({
  name: Schema.String,
  timeUnixNano: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.Unknown),
});

export const TraceSpanSchema = Schema.Struct({
  spanId: Schema.String,
  parentSpanId: Schema.NullOr(Schema.String),
  traceId: Schema.String,
  name: Schema.String,
  serviceName: Schema.String,
  scopeName: Schema.String,
  kind: Schema.Number,
  startTimeUnixNano: Schema.String,
  endTimeUnixNano: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.Unknown),
  events: Schema.Array(TraceEventSchema),
  statusCode: Schema.Number,
  statusMessage: Schema.NullOr(Schema.String),
});

export const TraceDetailResponseSchema = Schema.Struct({
  traceId: Schema.String,
  spans: Schema.Array(TraceSpanSchema),
});

export const ListTracesQuerySchema = Schema.Struct({
  service: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  q: Schema.optional(Schema.String),
});

export class TracesOperationError extends Schema.TaggedErrorClass<TracesOperationError>()(
  'TracesOperationError',
  {
    message: Schema.String,
  },
  { httpApiStatus: 502 },
) {}

export type AgentId = Schema.Schema.Type<typeof AgentIdSchema>;
export type SkillId = Schema.Schema.Type<typeof SkillIdSchema>;
export type WorkflowId = Schema.Schema.Type<typeof WorkflowIdSchema>;
export type ExecutorSourceId = Schema.Schema.Type<typeof ExecutorSourceIdSchema>;
export type ExecutorToolId = Schema.Schema.Type<typeof ExecutorToolIdSchema>;
export type TraceId = Schema.Schema.Type<typeof TraceIdSchema>;
export type AgentCapabilities = Schema.Schema.Type<typeof AgentCapabilitiesSchema>;
export type AgentCommunicationToolConfig = Schema.Schema.Type<typeof AgentCommunicationToolConfigSchema>;
export type AgentVisibility = Schema.Schema.Type<typeof AgentVisibilitySchema>;
export type CreateAgentInput = Schema.Schema.Type<typeof CreateAgentInputSchema>;
export type UpdateAgentInput = Schema.Schema.Type<typeof UpdateAgentInputSchema>;
export type Agent = Schema.Schema.Type<typeof AgentSchema>;
export type AgentInternalsResponse = Schema.Schema.Type<typeof AgentInternalsResponseSchema>;
export type RemoveAgentResponse = Schema.Schema.Type<typeof RemoveAgentResponseSchema>;
export type RemoveSkillResponse = Schema.Schema.Type<typeof RemoveSkillResponseSchema>;
export type Skill = Schema.Schema.Type<typeof SkillSchema>;
export type CreateSkillInput = Schema.Schema.Type<typeof CreateSkillInputSchema>;
export type PullSkillsInput = Schema.Schema.Type<typeof PullSkillsInputSchema>;
export type PullSkillsResponse = Schema.Schema.Type<typeof PullSkillsResponseSchema>;
export type AssignAgentSkillsInput = Schema.Schema.Type<typeof AssignAgentSkillsInputSchema>;
export type AssignAgentSkillsResponse = Schema.Schema.Type<typeof AssignAgentSkillsResponseSchema>;
export type LoadSkillResponse = Schema.Schema.Type<typeof LoadSkillResponseSchema>;
export type WorkflowNodeType = Schema.Schema.Type<typeof WorkflowNodeTypeSchema>;
export type WorkflowNode = Schema.Schema.Type<typeof WorkflowNodeSchema>;
export type WorkflowEdge = Schema.Schema.Type<typeof WorkflowEdgeSchema>;
export type WorkflowGraph = Schema.Schema.Type<typeof WorkflowGraphSchema>;
export type CreateWorkflowInput = Schema.Schema.Type<typeof CreateWorkflowInputSchema>;
export type UpdateWorkflowInput = Schema.Schema.Type<typeof UpdateWorkflowInputSchema>;
export type Workflow = Schema.Schema.Type<typeof WorkflowSchema>;
export type RemoveWorkflowResponse = Schema.Schema.Type<typeof RemoveWorkflowResponseSchema>;
export type ExecutorSourcesResponse = Schema.Schema.Type<typeof ExecutorSourcesResponseSchema>;
export type SetPinnedExecutorToolsInput = Schema.Schema.Type<typeof SetPinnedExecutorToolsInputSchema>;
export type SetPinnedExecutorToolsResponse = Schema.Schema.Type<typeof SetPinnedExecutorToolsResponseSchema>;
export type ExecutorToolMode = Schema.Schema.Type<typeof ExecutorToolModeSchema>;
export type SetExecutorToolModesInput = Schema.Schema.Type<typeof SetExecutorToolModesInputSchema>;
export type SetExecutorToolModesResponse = Schema.Schema.Type<typeof SetExecutorToolModesResponseSchema>;
export type SourceDetectionResult = Schema.Schema.Type<typeof SourceDetectionResultSchema>;
export type DetectSourceInput = Schema.Schema.Type<typeof DetectSourceInputSchema>;
export type DetectSourceResponse = Schema.Schema.Type<typeof DetectSourceResponseSchema>;
export type McpProbeInput = Schema.Schema.Type<typeof McpProbeInputSchema>;
export type McpProbeResponse = Schema.Schema.Type<typeof McpProbeResponseSchema>;
export type AddMcpSourceInput = Schema.Schema.Type<typeof AddMcpSourceInputSchema>;
export type AddMcpSourceResponse = Schema.Schema.Type<typeof AddMcpSourceResponseSchema>;
export type UpdateMcpSourceInput = Schema.Schema.Type<typeof UpdateMcpSourceInputSchema>;
export type UpdateMcpSourceResponse = Schema.Schema.Type<typeof UpdateMcpSourceResponseSchema>;
export type RemoveMcpSourceResponse = Schema.Schema.Type<typeof RemoveMcpSourceResponseSchema>;
export type SourceStaticAuthInput = Schema.Schema.Type<typeof SourceStaticAuthInputSchema>;
export type SourceAddResponse = Schema.Schema.Type<typeof SourceAddResponseSchema>;
export type SourceUpdateResponse = Schema.Schema.Type<typeof SourceUpdateResponseSchema>;
export type RemoveExecutorSourceResponse = Schema.Schema.Type<typeof RemoveExecutorSourceResponseSchema>;
export type OpenApiSpecInput = Schema.Schema.Type<typeof OpenApiSpecInputSchema>;
export type PreviewOpenApiInput = Schema.Schema.Type<typeof PreviewOpenApiInputSchema>;
export type PreviewOpenApiResponse = Schema.Schema.Type<typeof PreviewOpenApiResponseSchema>;
export type OpenApiOAuthInput = Schema.Schema.Type<typeof OpenApiOAuthInputSchema>;
export type AddOpenApiSourceInput = Schema.Schema.Type<typeof AddOpenApiSourceInputSchema>;
export type AddGraphqlSourceInput = Schema.Schema.Type<typeof AddGraphqlSourceInputSchema>;
export type ProbeGoogleDiscoveryInput = Schema.Schema.Type<typeof ProbeGoogleDiscoveryInputSchema>;
export type ProbeGoogleDiscoveryResponse = Schema.Schema.Type<typeof ProbeGoogleDiscoveryResponseSchema>;
export type GoogleDiscoveryOAuthInput = Schema.Schema.Type<typeof GoogleDiscoveryOAuthInputSchema>;
export type AddGoogleDiscoverySourceInput = Schema.Schema.Type<typeof AddGoogleDiscoverySourceInputSchema>;
export type StartOAuthInput = Schema.Schema.Type<typeof StartOAuthInputSchema>;
export type StartOAuthResponse = Schema.Schema.Type<typeof StartOAuthResponseSchema>;
export type CompleteOAuthInput = Schema.Schema.Type<typeof CompleteOAuthInputSchema>;
export type CompleteOAuthResponse = Schema.Schema.Type<typeof CompleteOAuthResponseSchema>;
export type Session = Schema.Schema.Type<typeof SessionSchema>;
export type SessionsResponse = Schema.Schema.Type<typeof SessionsResponseSchema>;
export type DeleteSessionResponse = Schema.Schema.Type<typeof DeleteSessionResponseSchema>;
export type EvalSessionSummary = Schema.Schema.Type<typeof EvalSessionSummarySchema>;
export type EvalSessionDetail = Schema.Schema.Type<typeof EvalSessionDetailSchema>;
export type EvalSessionsResponse = Schema.Schema.Type<typeof EvalSessionsResponseSchema>;
export type TraceSummary = Schema.Schema.Type<typeof TraceSummarySchema>;
export type TraceListResponse = Schema.Schema.Type<typeof TraceListResponseSchema>;
export type TraceEvent = Schema.Schema.Type<typeof TraceEventSchema>;
export type TraceSpan = Schema.Schema.Type<typeof TraceSpanSchema>;
export type TraceDetailResponse = Schema.Schema.Type<typeof TraceDetailResponseSchema>;
