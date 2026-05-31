import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { Effect, Schema, type Layer } from 'effect';
import { ManagedRuntime } from 'effect';
import { get_encoding } from 'tiktoken';
import { AgentCommunicationPolicy, WILDCARD_TARGET } from '../agents/communication-policy';
import { AgentRegistry } from '../agents/service';
import { AgentExecutorRegistry } from '../executor/service';
import { SkillRegistry } from '../skills/service';
import { AgentA2aSessionStore } from '../a2a/session-store';
import { TracesService } from '../traces/service';
import { WorkflowRegistry } from '../workflows/service';
import {
  AddGoogleDiscoverySourceInputSchema,
  AddGraphqlSourceInputSchema,
  AddMcpSourceInputSchema,
  AddMcpSourceResponseSchema,
  AddOpenApiSourceInputSchema,
  AgentIdSchema,
  AgentInternalsResponseSchema,
  AgentListSchema,
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
  ExecutorSourceIdSchema,
  ExecutorSourcesResponseSchema,
  ListTracesQuerySchema,
  LoadSkillResponseSchema,
  McpProbeInputSchema,
  McpProbeResponseSchema,
  PreviewOpenApiInputSchema,
  PreviewOpenApiResponseSchema,
  ProbeGoogleDiscoveryInputSchema,
  ProbeGoogleDiscoveryResponseSchema,
  PullSkillsInputSchema,
  PullSkillsResponseSchema,
  RemoveAgentResponseSchema,
  RemoveExecutorSourceResponseSchema,
  RemoveMcpSourceResponseSchema,
  RemoveSkillResponseSchema,
  RemoveWorkflowResponseSchema,
  SessionsResponseSchema,
  SetExecutorToolModesInputSchema,
  SetExecutorToolModesResponseSchema,
  SetPinnedExecutorToolsInputSchema,
  SetPinnedExecutorToolsResponseSchema,
  SkillListSchema,
  SkillIdSchema,
  SkillSchema,
  StartOAuthInputSchema,
  StartOAuthResponseSchema,
  TraceIdSchema,
  TraceDetailResponseSchema,
  TraceListResponseSchema,
  UpdateAgentInputSchema,
  UpdateMcpSourceInputSchema,
  UpdateMcpSourceResponseSchema,
  UpdateWorkflowInputSchema,
  WorkflowIdSchema,
  WorkflowListSchema,
  WorkflowSchema,
} from 'agentdock-sdk/api';

type AgentdockMcpLayer = Layer.Layer<any, never, never>;
type AgentdockMcpServer = Server;

export type AgentdockMcpHandle = {
  readonly handleRequest: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
};

const EmptyInputSchema = Schema.Struct({});
const AgentIdInputSchema = Schema.Struct({ agentId: AgentIdSchema });
const SkillIdInputSchema = Schema.Struct({ skillId: SkillIdSchema });
const WorkflowIdInputSchema = Schema.Struct({ workflowId: WorkflowIdSchema });
const TraceIdInputSchema = Schema.Struct({ traceId: TraceIdSchema });
const AgentSkillInputSchema = Schema.Struct({ agentId: AgentIdSchema, skillId: SkillIdSchema });
const AgentSessionInputSchema = Schema.Struct({ agentId: AgentIdSchema, sessionId: Schema.String });
const EvalSessionInputSchema = Schema.Struct({ targetId: Schema.String, sessionId: Schema.String });
const AgentSourceInputSchema = Schema.Struct({ agentId: AgentIdSchema, sourceId: ExecutorSourceIdSchema });

const mergeStruct = <A extends Schema.Struct.Fields, B extends Schema.Struct.Fields>(
  left: Schema.Struct<A>,
  right: Schema.Struct<B>,
) => Schema.Struct({ ...left.fields, ...right.fields });

const withAgentId = <A extends Schema.Struct.Fields>(schema: Schema.Struct<A>) => mergeStruct(AgentIdInputSchema, schema);
const withWorkflowId = <A extends Schema.Struct.Fields>(schema: Schema.Struct<A>) => mergeStruct(WorkflowIdInputSchema, schema);
const withSourceId = <A extends Schema.Struct.Fields>(schema: Schema.Struct<A>) => mergeStruct(AgentSourceInputSchema, schema);

const UpdateAgentToolInputSchema = withAgentId(UpdateAgentInputSchema);
const UpdateWorkflowToolInputSchema = withWorkflowId(UpdateWorkflowInputSchema);
const AddMcpSourceToolInputSchema = withAgentId(AddMcpSourceInputSchema);
const UpdateMcpSourceToolInputSchema = withSourceId(UpdateMcpSourceInputSchema);
const DetectSourceToolInputSchema = withAgentId(DetectSourceInputSchema);
const ProbeMcpEndpointToolInputSchema = withAgentId(McpProbeInputSchema);
const PreviewOpenApiToolInputSchema = withAgentId(PreviewOpenApiInputSchema);
const AddOpenApiSourceToolInputSchema = withAgentId(AddOpenApiSourceInputSchema);
const AddGraphqlSourceToolInputSchema = withAgentId(AddGraphqlSourceInputSchema);
const ProbeGoogleDiscoveryToolInputSchema = withAgentId(ProbeGoogleDiscoveryInputSchema);
const AddGoogleDiscoverySourceToolInputSchema = withAgentId(AddGoogleDiscoverySourceInputSchema);
const SetPinnedExecutorToolsToolInputSchema = withAgentId(SetPinnedExecutorToolsInputSchema);
const SetExecutorToolModesToolInputSchema = withAgentId(SetExecutorToolModesInputSchema);
const StartOAuthToolInputSchema = withAgentId(StartOAuthInputSchema);
const CompleteOAuthToolInputSchema = withAgentId(CompleteOAuthInputSchema);
const AssignAgentSkillsToolInputSchema = withAgentId(AssignAgentSkillsInputSchema);

class McpToolError extends Schema.TaggedErrorClass<McpToolError>()('McpToolError', {
  message: Schema.String,
}) {}

type EffectTool = {
  readonly name: string;
  readonly description: string;
  readonly input: Schema.Top;
  readonly output: Schema.Top;
  readonly handler: (input: never) => Effect.Effect<unknown, unknown, never>;
};

const toJsonSchema = (schema: Schema.Top): Tool['inputSchema'] => {
  const standard = Schema.toStandardJSONSchemaV1(schema) as any;
  const jsonSchema = standard['~standard']?.jsonSchema?.input({ target: 'draft-2020-12' });
  if (!jsonSchema || typeof jsonSchema !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: false } as Tool['inputSchema'];
  }

  if ('anyOf' in jsonSchema && !('properties' in jsonSchema)) {
    return { type: 'object', properties: {}, additionalProperties: false } as Tool['inputSchema'];
  }

  if (!('type' in jsonSchema) || jsonSchema.type !== 'object') {
    return { ...jsonSchema, type: 'object' } as Tool['inputSchema'];
  }

  return jsonSchema as Tool['inputSchema'];
};

const formatSchemaError = (error: unknown): string => error instanceof Error ? error.message : String(error);

const toStructuredToolResult = (value: unknown): CallToolResult => ({
  structuredContent: { result: value },
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

const toMcpTool = (tool: EffectTool): Tool => ({
  name: tool.name,
  description: tool.description,
  inputSchema: toJsonSchema(tool.input),
  outputSchema: toJsonSchema(Schema.Struct({ result: tool.output })),
});

const makeToolError = (message: string): CallToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

const registerEffectTool = <I, O, R>(
  tools: Map<string, EffectTool>,
  tool: {
    readonly name: string;
    readonly description: string;
    readonly input: Schema.Schema<I>;
    readonly output: Schema.Schema<O>;
    readonly handler: (input: I) => Effect.Effect<O, unknown, R>;
  },
) => {
  tools.set(tool.name, tool as unknown as EffectTool);
};

const callEffectTool = (
  run: <A, R>(effect: Effect.Effect<A, unknown, R>) => Promise<A>,
  tool: EffectTool,
  rawInput: unknown,
): Promise<CallToolResult> =>
  run(
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(tool.input)(rawInput ?? {});
      const output = yield* tool.handler(input as never);
      const encoded = yield* Schema.encodeUnknownEffect(tool.output)(output as never);
      return toStructuredToolResult(encoded);
    }).pipe(
      Effect.catch((error) => Effect.succeed(makeToolError(formatSchemaError(error)))),
    ),
  );

const syncCommunicationPolicy = (agent: {
  readonly id: string;
  readonly communication: { readonly allowAll: boolean; readonly allowedAgentIds: ReadonlyArray<string> };
}) =>
  AgentCommunicationPolicy.use((policy) =>
    policy.replaceForAgent({
      sourceAgentId: agent.id,
      targetAgentIds: agent.communication.allowAll ? [WILDCARD_TARGET] : agent.communication.allowedAgentIds,
    }),
  );

const skillInstructionsFor = (skills: ReadonlyArray<{ readonly id: string; readonly description: string }>): string =>
  skills.length === 0
    ? ''
    : `\n\nAvailable agent skills:\n${skills.map((skill) => `- ${skill.id}: ${skill.description}`).join('\n')}\nWhen a task matches one of these skills, call load_skill with the skill id before proceeding.`;

const countTokens = (text: string): number => {
  const encoding = get_encoding('cl100k_base');
  try {
    return encoding.encode(text).length;
  } finally {
    encoding.free();
  }
};

const readNumber = (value: unknown): number | undefined => typeof value === 'number' ? value : undefined;
const readString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

const fetchModelInfo = (model: string) =>
  Effect.tryPromise({
    try: async () => {
      const parts = model.split(':', 2);
      const provider = model.includes(':') ? parts[0] ?? 'unknown' : 'unknown';
      const modelId = model.includes(':') ? parts[1] ?? model : model;
      const response = await fetch('https://models.dev/api.json');
      if (!response.ok) throw new Error(`models.dev responded ${response.status}`);
      const data = await response.json() as Record<string, unknown>;
      const providerData = data[provider] as { readonly models?: Record<string, unknown> } | undefined;
      const rawModel = providerData?.models?.[modelId] as Record<string, unknown> | undefined;
      const contextWindow = readNumber(rawModel?.context_length ?? rawModel?.contextWindow);
      const maxOutputTokens = readNumber(rawModel?.max_output_tokens ?? rawModel?.maxOutputTokens);
      const pricing = rawModel?.pricing as Record<string, unknown> | undefined;
      const inputCostPerMillion = readNumber(pricing?.input);
      const outputCostPerMillion = readNumber(pricing?.output);
      return {
        id: modelId,
        provider,
        name: readString(rawModel?.name) ?? modelId,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(inputCostPerMillion !== undefined ? { inputCostPerMillion } : {}),
        ...(outputCostPerMillion !== undefined ? { outputCostPerMillion } : {}),
      };
    },
    catch: () => undefined,
  }).pipe(Effect.map((info) => info ?? {
    id: model.includes(':') ? model.split(':', 2)[1] ?? model : model,
    provider: model.includes(':') ? model.split(':', 2)[0] ?? 'unknown' : 'unknown',
    name: model,
  }));

const createAgentdockMcpServer = (
  run: <A, R>(effect: Effect.Effect<A, unknown, R>) => Promise<A>,
): AgentdockMcpServer => {
  const server = new Server({
    name: 'agentdock-app-control',
    version: '0.1.0',
  }, {
    capabilities: { tools: { listChanged: true } },
  });
  const tools = new Map<string, EffectTool>();

  registerEffectTool(tools, {
    name: 'list_agents',
    description: 'List the agents currently configured in Agentdock.',
    input: EmptyInputSchema,
    output: AgentListSchema,
    handler: () => AgentRegistry.use((registry) => registry.list()),
  });

  registerEffectTool(tools, {
    name: 'add_agent',
    description: 'Create a new Agentdock agent and sync its communication policy.',
    input: CreateAgentInputSchema,
    output: AgentSchema,
    handler: (input) => AgentRegistry.use((registry) => registry.add(input)).pipe(Effect.tap(syncCommunicationPolicy)),
  });

  registerEffectTool(tools, {
    name: 'update_agent',
    description: 'Update an existing Agentdock agent and sync its communication policy.',
    input: UpdateAgentToolInputSchema,
    output: AgentSchema,
    handler: ({ agentId, ...input }) => Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const agent = yield* registry.update(agentId, input);
      if (!agent) return yield* new McpToolError({ message: 'Agent not found' });
      yield* syncCommunicationPolicy(agent);
      return agent;
    }),
  });

  registerEffectTool(tools, {
    name: 'remove_agent',
    description: 'Remove an Agentdock agent and clear its communication policy.',
    input: AgentIdInputSchema,
    output: RemoveAgentResponseSchema,
    handler: ({ agentId }) => AgentRegistry.use((registry) => registry.remove(agentId)).pipe(
      Effect.tap((removed) =>
        removed
          ? AgentCommunicationPolicy.use((policy) => policy.replaceForAgent({ sourceAgentId: agentId, targetAgentIds: [] }))
          : Effect.void,
      ),
      Effect.map((removed) => ({ removed })),
    ),
  });

  registerEffectTool(tools, {
    name: 'get_agent_internals',
    description: 'Inspect an agent model, active tools, and final prompt.',
    input: AgentIdInputSchema,
    output: AgentInternalsResponseSchema,
    handler: ({ agentId }) => Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const agent = yield* registry.getById(agentId);
      if (!agent) return yield* new McpToolError({ message: 'Agent not found' });
      const skillRegistry = yield* SkillRegistry;
      const executorRegistry = yield* AgentExecutorRegistry;
      const [skills, executorSources, model] = yield* Effect.all([
        skillRegistry.list(),
        executorRegistry.listSources(agent.id),
        fetchModelInfo(agent.model),
      ]);
      const assignedSkills = skills.filter((skill) => agent.skillIds.includes(skill.id));
      const finalInstructions = `${agent.instructions}${skillInstructionsFor(assignedSkills)}`;
      return {
        agentId: agent.id,
        model,
        tools: [
          { id: 'list_agents', name: 'list_agents', source: 'internal' as const, active: true, description: 'List the available A2A agents and their A2A endpoint URLs.' },
          { id: 'send_task', name: 'send_task', source: 'internal' as const, active: true, description: 'Send a blocking task to an A2A agent and return its final text message.' },
          { id: 'load_skill', name: 'load_skill', source: 'internal' as const, active: true, description: 'Load the full SKILL.md instructions for a skill assigned to this agent. Use when the user task matches an available skill.' },
          ...executorSources.tools.map((tool) => ({
            id: tool.id,
            name: tool.name,
            source: 'executor' as const,
            description: tool.description,
            active: tool.mode !== 'disabled',
            mode: tool.mode,
          })),
        ],
        prompt: { editableInstructions: agent.instructions, finalInstructions, tokenCount: countTokens(finalInstructions) },
      };
    }),
  });

  registerEffectTool(tools, {
    name: 'list_workflows',
    description: 'List the workflows currently configured in Agentdock.',
    input: EmptyInputSchema,
    output: WorkflowListSchema,
    handler: () => WorkflowRegistry.use((registry) => registry.list()),
  });

  registerEffectTool(tools, {
    name: 'add_workflow',
    description: 'Create a new Agentdock workflow.',
    input: CreateWorkflowInputSchema,
    output: WorkflowSchema,
    handler: (input) => WorkflowRegistry.use((registry) => registry.add(input)),
  });

  registerEffectTool(tools, {
    name: 'update_workflow',
    description: 'Update an existing Agentdock workflow.',
    input: UpdateWorkflowToolInputSchema,
    output: WorkflowSchema,
    handler: ({ workflowId, ...input }) => WorkflowRegistry.use((registry) => registry.update(workflowId, input)).pipe(
      Effect.flatMap((workflow) => workflow ? Effect.succeed(workflow) : Effect.fail(new McpToolError({ message: 'Workflow not found' }))),
    ),
  });

  registerEffectTool(tools, {
    name: 'remove_workflow',
    description: 'Remove an Agentdock workflow.',
    input: WorkflowIdInputSchema,
    output: RemoveWorkflowResponseSchema,
    handler: ({ workflowId }) => WorkflowRegistry.use((registry) => registry.remove(workflowId)).pipe(
      Effect.map((removed) => ({ removed })),
    ),
  });

  registerEffectTool(tools, { name: 'list_skills', description: 'List available Agentdock skills.', input: EmptyInputSchema, output: SkillListSchema, handler: () => SkillRegistry.use((registry) => registry.list()) });
  registerEffectTool(tools, { name: 'add_skill', description: 'Add a skill from SKILL.md content.', input: CreateSkillInputSchema, output: SkillSchema, handler: (input) => SkillRegistry.use((registry) => registry.add(input)) });
  registerEffectTool(tools, { name: 'pull_skills', description: 'Pull skills from a source repository or package.', input: PullSkillsInputSchema, output: PullSkillsResponseSchema, handler: (input) => SkillRegistry.use((registry) => registry.pull(input)).pipe(Effect.map((skills) => ({ skills }))) });
  registerEffectTool(tools, { name: 'remove_skill', description: 'Remove a skill.', input: SkillIdInputSchema, output: RemoveSkillResponseSchema, handler: ({ skillId }) => SkillRegistry.use((registry) => registry.remove(skillId)).pipe(Effect.map((removed) => ({ removed }))) });
  registerEffectTool(tools, { name: 'assign_agent_skills', description: 'Replace the skills assigned to an agent.', input: AssignAgentSkillsToolInputSchema, output: AssignAgentSkillsResponseSchema, handler: ({ agentId, skillIds }) => SkillRegistry.use((registry) => registry.assignToAgent(agentId, skillIds)).pipe(Effect.map((updated) => ({ updated }))) });
  registerEffectTool(tools, { name: 'load_agent_skill', description: 'Load a skill assigned to an agent.', input: AgentSkillInputSchema, output: LoadSkillResponseSchema, handler: ({ agentId, skillId }) => SkillRegistry.use((registry) => registry.loadForAgent(agentId, skillId)).pipe(Effect.flatMap((skill) => skill ? Effect.succeed({ skill }) : Effect.fail(new McpToolError({ message: 'Skill not found for agent' })))) });

  registerEffectTool(tools, { name: 'list_executor_sources', description: 'List the sources and tools available to an Agentdock agent.', input: AgentIdInputSchema, output: ExecutorSourcesResponseSchema, handler: ({ agentId }) => AgentExecutorRegistry.use((registry) => registry.listSources(agentId)) });
  registerEffectTool(tools, { name: 'detect_source', description: 'Detect source type and metadata for a URL.', input: DetectSourceToolInputSchema, output: DetectSourceResponseSchema, handler: ({ agentId, ...input }) => AgentExecutorRegistry.use((registry) => registry.detectSource(agentId, input)) });
  registerEffectTool(tools, { name: 'probe_mcp_endpoint', description: 'Probe a remote MCP endpoint before adding it as a source.', input: ProbeMcpEndpointToolInputSchema, output: McpProbeResponseSchema, handler: ({ agentId, ...input }) => AgentExecutorRegistry.use((registry) => registry.probeMcpEndpoint(agentId, input)) });
  registerEffectTool(tools, { name: 'add_mcp_source', description: 'Add a remote MCP source to an Agentdock agent.', input: AddMcpSourceToolInputSchema, output: AddMcpSourceResponseSchema, handler: ({ agentId, ...input }) => AgentExecutorRegistry.use((registry) => registry.addMcpSource(agentId, input)) });
  registerEffectTool(tools, { name: 'update_mcp_source', description: 'Update a remote MCP source configured on an Agentdock agent.', input: UpdateMcpSourceToolInputSchema, output: UpdateMcpSourceResponseSchema, handler: ({ agentId, sourceId, ...input }) => AgentExecutorRegistry.use((registry) => registry.updateMcpSource(agentId, sourceId, input)) });
  registerEffectTool(tools, { name: 'remove_mcp_source', description: 'Remove a remote MCP source from an Agentdock agent.', input: AgentSourceInputSchema, output: RemoveMcpSourceResponseSchema, handler: ({ agentId, sourceId }) => AgentExecutorRegistry.use((registry) => registry.removeMcpSource(agentId, sourceId)) });
  registerEffectTool(tools, { name: 'preview_openapi_spec', description: 'Preview tools discovered from an OpenAPI spec.', input: PreviewOpenApiToolInputSchema, output: PreviewOpenApiResponseSchema, handler: ({ agentId, ...input }) => AgentExecutorRegistry.use((registry) => registry.previewOpenApiSpec(agentId, input)) });
  registerEffectTool(tools, { name: 'add_openapi_source', description: 'Add an OpenAPI source to an Agentdock agent.', input: AddOpenApiSourceToolInputSchema, output: AddMcpSourceResponseSchema, handler: ({ agentId, ...input }) => AgentExecutorRegistry.use((registry) => registry.addOpenApiSource(agentId, input)) });
  registerEffectTool(tools, { name: 'add_graphql_source', description: 'Add a GraphQL source to an Agentdock agent.', input: AddGraphqlSourceToolInputSchema, output: AddMcpSourceResponseSchema, handler: ({ agentId, ...input }) => AgentExecutorRegistry.use((registry) => registry.addGraphqlSource(agentId, input)) });
  registerEffectTool(tools, { name: 'probe_google_discovery', description: 'Probe a Google Discovery source.', input: ProbeGoogleDiscoveryToolInputSchema, output: ProbeGoogleDiscoveryResponseSchema, handler: ({ agentId, ...input }) => AgentExecutorRegistry.use((registry) => registry.probeGoogleDiscovery(agentId, input)) });
  registerEffectTool(tools, { name: 'add_google_discovery_source', description: 'Add a Google Discovery source to an Agentdock agent.', input: AddGoogleDiscoverySourceToolInputSchema, output: AddMcpSourceResponseSchema, handler: ({ agentId, ...input }) => AgentExecutorRegistry.use((registry) => registry.addGoogleDiscoverySource(agentId, input)) });
  registerEffectTool(tools, { name: 'remove_executor_source', description: 'Remove an executor source from an Agentdock agent.', input: AgentSourceInputSchema, output: RemoveExecutorSourceResponseSchema, handler: ({ agentId, sourceId }) => AgentExecutorRegistry.use((registry) => registry.removeExecutorSource(agentId, sourceId)) });
  registerEffectTool(tools, { name: 'set_pinned_executor_tools', description: 'Set the pinned executor tools for an agent.', input: SetPinnedExecutorToolsToolInputSchema, output: SetPinnedExecutorToolsResponseSchema, handler: ({ agentId, ...input }) => AgentExecutorRegistry.use((registry) => registry.setPinnedTools(agentId, input)) });
  registerEffectTool(tools, { name: 'set_executor_tool_modes', description: 'Set executor tool modes for an agent.', input: SetExecutorToolModesToolInputSchema, output: SetExecutorToolModesResponseSchema, handler: ({ agentId, ...input }) => AgentExecutorRegistry.use((registry) => registry.setToolModes(agentId, input)) });
  registerEffectTool(tools, { name: 'start_executor_oauth', description: 'Start OAuth for an executor source.', input: StartOAuthToolInputSchema, output: StartOAuthResponseSchema, handler: ({ agentId, ...input }) => AgentExecutorRegistry.use((registry) => registry.startOAuth(agentId, input)) });
  registerEffectTool(tools, { name: 'complete_executor_oauth', description: 'Complete OAuth for an executor source.', input: CompleteOAuthToolInputSchema, output: CompleteOAuthResponseSchema, handler: ({ agentId, ...input }) => AgentExecutorRegistry.use((registry) => registry.completeOAuth(agentId, input)) });

  registerEffectTool(tools, { name: 'list_sessions', description: 'List chat sessions for an agent.', input: AgentIdInputSchema, output: SessionsResponseSchema, handler: ({ agentId }) => AgentA2aSessionStore.use((store) => store.listSessions(agentId)).pipe(Effect.map((sessions) => ({ sessions }))) });
  registerEffectTool(tools, { name: 'delete_session', description: 'Delete a chat session for an agent.', input: AgentSessionInputSchema, output: DeleteSessionResponseSchema, handler: ({ agentId, sessionId }) => AgentA2aSessionStore.use((store) => store.deleteSession({ agentId, sessionId })).pipe(Effect.as({ deleted: true })) });
  registerEffectTool(tools, { name: 'list_eval_sessions', description: 'List evaluation sessions across agents and workflows.', input: EmptyInputSchema, output: EvalSessionsResponseSchema, handler: () => AgentA2aSessionStore.use((store) => store.listEvalSessions()).pipe(Effect.map((sessions) => ({ sessions }))) });
  registerEffectTool(tools, { name: 'get_eval_session', description: 'Get evaluation session details.', input: EvalSessionInputSchema, output: EvalSessionDetailSchema, handler: (input) => AgentA2aSessionStore.use((store) => store.getEvalSession(input)) });

  registerEffectTool(tools, { name: 'list_traces', description: 'List observed traces.', input: ListTracesQuerySchema, output: TraceListResponseSchema, handler: (input) => TracesService.use((service) => service.listTraces(input)) });
  registerEffectTool(tools, { name: 'get_trace', description: 'Get trace span details.', input: TraceIdInputSchema, output: TraceDetailResponseSchema, handler: ({ traceId }) => TracesService.use((service) => service.getTrace(traceId)) });

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: Array.from(tools.values()).map(toMcpTool) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.get(request.params.name);
    if (!tool) return makeToolError(`Tool ${request.params.name} not found`);
    return callEffectTool(run, tool, request.params.arguments);
  });

  return server;
};

const jsonRpcError = (status: number, code: number, message: string): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const createAgentdockMcpRequestHandler = (
  layer: AgentdockMcpLayer,
): AgentdockMcpHandle => {
  const runtime = ManagedRuntime.make(layer);
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const servers = new Map<string, AgentdockMcpServer>();

  const dispose = async (id: string, options: { readonly transport?: boolean; readonly server?: boolean } = {}) => {
    const transport = transports.get(id);
    const server = servers.get(id);
    transports.delete(id);
    servers.delete(id);
    if (options.transport) await transport?.close();
    if (options.server) await server?.close();
  };

  const run = <A, R>(effect: Effect.Effect<A, unknown, R>) =>
    runtime.runPromise(effect as Effect.Effect<A, unknown, never>);

  return {
    handleRequest: async (request) => {
      const sessionId = request.headers.get('mcp-session-id');

      if (sessionId) {
        const transport = transports.get(sessionId);
        if (!transport) return jsonRpcError(404, -32001, 'Session not found');
        return transport.handleRequest(request);
      }

      let created: AgentdockMcpServer | undefined;
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid: string) => {
          transports.set(sid, transport);
          if (created) servers.set(sid, created);
        },
        onsessionclosed: (sid: string) => void dispose(sid, { server: true }),
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) void dispose(sid, { server: true });
      };

      try {
        created = createAgentdockMcpServer(run);
        await created.connect(transport);
        const response = await transport.handleRequest(request);

        if (!transport.sessionId) {
          await transport.close();
          await created.close();
        }

        return response;
      } catch (error) {
        console.error('[agentdock-mcp] request failed', error);
        if (!transport.sessionId) {
          await transport.close();
          await created?.close();
        }
        return jsonRpcError(500, -32603, 'Internal server error');
      }
    },
    close: async () => {
      const ids = new Set([...transports.keys(), ...servers.keys()]);
      await Promise.all([...ids].map((id) => dispose(id, { transport: true, server: true })));
      await runtime.dispose();
    },
  };
};
