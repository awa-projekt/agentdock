import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema as CallToolRequest,
  type CallToolResult,
  ListToolsRequestSchema as ListToolsRequest,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUIDv4 } from 'agentdock-sdk';
import {
  AddEvalCasesInput,
  AgentId,
  AgentInternalsResponse,
  AgentList,
  AgentRecord,
  AgentToolsResponse,
  ApprovalsResponse,
  ConnectIntegrationInput,
  ConnectIntegrationResponse,
  CreateAgentInput,
  CreateEvalDatasetInput,
  CreateEvalRunInput,
  CreateSkillInput,
  coerceJson,
  coerceJsonObject,
  DeleteSessionResponse,
  DiscoverIntegrationInput,
  DiscoverIntegrationResponse,
  EvalCaseList,
  EvalDataset,
  EvalDatasetDetail,
  EvalDatasetId,
  EvalDatasetList,
  EvalGate,
  EvalGateInput,
  EvalGateList,
  EvalGrader,
  EvalGraderInput,
  EvalGraderList,
  EvalRun,
  EvalRunDetail,
  EvalRunId,
  EvalRunList,
  EvalSessionDetail,
  EvalSessionsResponse,
  IntegrationSlug,
  IntegrationsResponse,
  isJsonArray,
  isJsonObject,
  isJsonString,
  type Json,
  type JsonObject,
  ListTracesQuery,
  OAuthSessionView,
  PullSkillsInput,
  PullSkillsResponse,
  RemoveAgentResponse,
  RemoveIntegrationResponse,
  RemoveSkillResponse,
  RemoveWorkflowResponse,
  SessionsResponse,
  Skill,
  SkillId,
  SkillList,
  StartOAuthConnectionInput,
  TraceDetailResponse,
  TraceId,
  TraceListResponse,
  UpdateAgentInput,
  Workflow,
  WorkflowId,
  WorkflowList,
} from 'agentdock-sdk/schemas';
import * as Clock from 'effect/Clock';
import type * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import type { AgentCommunicationPolicyService } from '../agents/communication-policy';
import { agentInternals } from '../agents/internals';
import { forgetAgent, prepareAgentIntegrations, syncAgent } from '../agents/lifecycle';
import { AgentRegistry, type AgentRegistryService } from '../agents/service';
import { EvalGates, type EvalGatesApi } from '../evals/gates';
import { EvalService, type EvalServiceApi } from '../evals/service';
import { IntegrationCatalog, type IntegrationCatalogService } from '../gateway/catalog';
import type { ModelCatalogService } from '../models/catalog';
import { SessionsService, type SessionsServiceApi } from '../sessions/service';
import { SkillRegistry, type SkillRegistryService } from '../skills/service';
import { TracesService, type TracesServiceApi } from '../traces/service';
import { bindingCandidates } from '../workflows/candidates';
import { readArtifactFiles } from '../workflows/deploy';
import { WorkflowRegistry, type WorkflowRegistryService } from '../workflows/service';

/** The services the MCP tool handlers in this module require. */
export type McpRuntimeServices =
  | AgentCommunicationPolicyService
  | AgentRegistryService
  | EvalGatesApi
  | EvalServiceApi
  | IntegrationCatalogService
  | ModelCatalogService
  | SessionsServiceApi
  | SkillRegistryService
  | TracesServiceApi
  | WorkflowRegistryService;

type AgentdockMcpServer = Server;

export type AgentdockMcpHandle = {
  readonly handleRequest: (request: Request, owner: string) => Promise<Response>;
  readonly close: () => Promise<void>;
};

/**
 * Sent to every MCP client on initialize; harnesses put it into the model's
 * context, so an agent without the skill installed still finds the guide.
 */
const AGENTDOCK_MCP_INSTRUCTIONS =
  'These tools operate an Agentdock instance: its agents, skills, integrations, workflows, chat sessions, evals and traces. Before building or changing anything, follow the `agentdock` skill. If it is not installed, list_skills returns it with its full content.';

const EmptyInput = Schema.Struct({});
const AgentIdInput = Schema.Struct({ agentId: AgentId });
const SkillIdInput = Schema.Struct({ skillId: SkillId });
const WorkflowIdInput = Schema.Struct({ workflowId: WorkflowId });
const TraceIdInput = Schema.Struct({ traceId: TraceId });
const AgentSessionInput = Schema.Struct({ agentId: AgentId, sessionId: Schema.String });
const EvalSessionInput = Schema.Struct({ targetId: Schema.String, sessionId: Schema.String });
const IntegrationSlugInput = Schema.Struct({ slug: IntegrationSlug });
const EvalDatasetIdInput = Schema.Struct({ datasetId: EvalDatasetId });
const EvalRunIdInput = Schema.Struct({ runId: EvalRunId });

const mergeStruct = <A extends Schema.Struct.Fields, B extends Schema.Struct.Fields>(
  left: Schema.Struct<A>,
  right: Schema.Struct<B>,
) => Schema.Struct({ ...left.fields, ...right.fields });

const withAgentId = <A extends Schema.Struct.Fields>(schema: Schema.Struct<A>) => mergeStruct(AgentIdInput, schema);
const UpdateAgentToolInput = withAgentId(UpdateAgentInput);
const ConnectIntegrationToolInput = mergeStruct(IntegrationSlugInput, ConnectIntegrationInput);
const StartOAuthConnectionToolInput = mergeStruct(IntegrationSlugInput, StartOAuthConnectionInput);
const AddEvalCasesToolInput = mergeStruct(EvalDatasetIdInput, AddEvalCasesInput);

export class McpToolError extends Schema.TaggedError<McpToolError>()('McpToolError', {
  message: Schema.String,
}) {}

type EffectTool = {
  readonly name: string;
  readonly description: string;
  readonly input: Schema.Top;
  readonly output: Schema.Top;
  // Prepared at registration: decodes the raw input, runs the typed handler,
  // encodes the result, and converts every failure into an MCP tool error. Each
  // handler carries its own requirements; the server context running the call
  // provides them, so they are left open here.
  readonly call: (rawInput: Json) => Effect.Effect<CallToolResult, never, McpRuntimeServices>;
};

const emptyInputSchema = (): Tool['inputSchema'] => ({ type: 'object', properties: {}, additionalProperties: false });

const schemaProperties = (value: Json | undefined): Record<string, JsonObject> | undefined => {
  if (!isJsonObject(value)) return undefined;
  const properties: Record<string, JsonObject> = {};
  for (const [key, property] of Object.entries(value)) {
    if (isJsonObject(property)) properties[key] = property;
  }
  return properties;
};

/**
 * MCP advertises a tool as a draft-2020-12 object schema, so the schema Effect
 * generates is read through the JSON domain and reprojected onto that shape. A
 * schema that does not describe an object — `Schema.Struct({})` renders as an
 * `anyOf` — is advertised as taking no arguments.
 */
export const toJsonSchema = (schema: Schema.Top): Tool['inputSchema'] => {
  const generated = coerceJsonObject(
    Schema.toStandardJSONSchemaV1(schema)['~standard'].jsonSchema.input({ target: 'draft-2020-12' }),
  );
  const properties = schemaProperties(generated.properties);
  if (!properties) return emptyInputSchema();

  const inputSchema: Tool['inputSchema'] = { type: 'object', properties };
  const required = generated.required;
  if (isJsonArray(required)) inputSchema.required = required.filter(isJsonString);
  if (generated.additionalProperties === false) inputSchema.additionalProperties = false;
  return inputSchema;
};

const formatToolFailure = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const toStructuredToolResult = (value: Json): CallToolResult => ({
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

const registerEffectTool = <I, IE, O, OE, E, R extends McpRuntimeServices>(
  tools: Map<string, EffectTool>,
  tool: {
    readonly name: string;
    readonly description: string;
    readonly input: Schema.Codec<I, IE>;
    readonly output: Schema.Codec<O, OE>;
    readonly handler: (input: I) => Effect.Effect<O, E, R>;
  },
) => {
  const decodeInput = Schema.decodeUnknownEffect(tool.input);
  const encodeOutput = Schema.encodeUnknownEffect(tool.output);
  const call = (rawInput: Json) =>
    Effect.gen(function* () {
      const input = yield* decodeInput(rawInput);
      const output = yield* tool.handler(input);
      const encoded = yield* encodeOutput(output);
      return toStructuredToolResult(coerceJson(encoded));
    }).pipe(Effect.catch((error) => Effect.succeed(makeToolError(formatToolFailure(error)))));

  tools.set(tool.name, {
    name: tool.name,
    description: tool.description,
    input: tool.input,
    output: tool.output,
    call,
  });
};

const createAgentdockMcpServer = (
  run: <A>(effect: Effect.Effect<A, never, McpRuntimeServices>) => Promise<A>,
): AgentdockMcpServer => {
  const server = new Server(
    {
      name: 'agentdock-app-control',
      version: '0.1.0',
    },
    {
      capabilities: { tools: { listChanged: true } },
      instructions: AGENTDOCK_MCP_INSTRUCTIONS,
    },
  );
  const tools = new Map<string, EffectTool>();

  registerEffectTool(tools, {
    name: 'list_agents',
    description: 'List the agents currently configured in Agentdock.',
    input: EmptyInput,
    output: AgentList,
    handler: () => AgentRegistry.use((registry) => registry.list()),
  });

  registerEffectTool(tools, {
    name: 'add_agent',
    description: 'Create a new Agentdock agent; provisions the integrations it declares and syncs its grants.',
    input: CreateAgentInput,
    output: AgentRecord,
    handler: (input) =>
      prepareAgentIntegrations(input).pipe(
        Effect.andThen(AgentRegistry.use((registry) => registry.add(input))),
        Effect.tap(syncAgent),
      ),
  });

  registerEffectTool(tools, {
    name: 'update_agent',
    description: 'Update an existing Agentdock agent; provisions the integrations it declares and syncs its grants.',
    input: UpdateAgentToolInput,
    output: AgentRecord,
    handler: Effect.fn('AgentdockMcp.update_agent')(function* ({ agentId, ...input }) {
      const registry = yield* AgentRegistry;
      yield* prepareAgentIntegrations(input);
      const agent = yield* registry.update(agentId, input);
      if (!agent) return yield* new McpToolError({ message: 'Agent not found' });
      yield* syncAgent(agent);
      return agent;
    }),
  });

  registerEffectTool(tools, {
    name: 'remove_agent',
    description: 'Remove an Agentdock agent and clear its communication policy and tool grants.',
    input: AgentIdInput,
    output: RemoveAgentResponse,
    handler: ({ agentId }) =>
      AgentRegistry.use((registry) => registry.remove(agentId)).pipe(
        Effect.tap((removed) => (removed ? forgetAgent(agentId) : Effect.void)),
        Effect.map((removed) => ({ removed })),
      ),
  });

  registerEffectTool(tools, {
    name: 'get_agent_internals',
    description: 'Inspect an agent model, active tools, and final prompt.',
    input: AgentIdInput,
    output: AgentInternalsResponse,
    handler: Effect.fn('AgentdockMcp.get_agent_internals')(function* ({ agentId }) {
      const agent = yield* AgentRegistry.use((registry) => registry.getById(agentId));
      if (!agent) return yield* new McpToolError({ message: 'Agent not found' });
      return yield* agentInternals(agent);
    }),
  });

  registerEffectTool(tools, {
    name: 'list_workflows',
    description: 'List the workflows currently configured in Agentdock.',
    input: EmptyInput,
    output: WorkflowList,
    handler: () => WorkflowRegistry.use((registry) => registry.list()),
  });

  registerEffectTool(tools, {
    name: 'register_workflow',
    description:
      'Deploy a workflow artifact folder on this machine as an immutable revision. Pushing a folder whose manifest name is already registered updates that workflow.',
    input: Schema.Struct({ source: Schema.String }),
    output: Workflow,
    handler: ({ source }) =>
      Effect.gen(function* () {
        const registry = yield* WorkflowRegistry;
        const files = yield* Effect.orDie(readArtifactFiles(source));
        return yield* registry.register({ files }, yield* bindingCandidates);
      }),
  });

  registerEffectTool(tools, {
    name: 'remove_workflow',
    description: 'Remove an Agentdock workflow.',
    input: WorkflowIdInput,
    output: RemoveWorkflowResponse,
    handler: ({ workflowId }) =>
      WorkflowRegistry.use((registry) => registry.remove(workflowId)).pipe(Effect.map((removed) => ({ removed }))),
  });

  registerEffectTool(tools, {
    name: 'list_skills',
    description:
      'List the Agentdock skills with their full SKILL.md content. The built-in `agentdock` skill is the guide to operating Agentdock through these tools.',
    input: EmptyInput,
    output: SkillList,
    handler: () => SkillRegistry.use((registry) => registry.list()),
  });
  registerEffectTool(tools, {
    name: 'add_skill',
    description: 'Add a skill from SKILL.md content.',
    input: CreateSkillInput,
    output: Skill,
    handler: (input) => SkillRegistry.use((registry) => registry.add(input)),
  });
  registerEffectTool(tools, {
    name: 'pull_skills',
    description: 'Pull skills from a source repository or package.',
    input: PullSkillsInput,
    output: PullSkillsResponse,
    handler: (input) =>
      SkillRegistry.use((registry) => registry.pull(input)).pipe(Effect.map((skills) => ({ skills }))),
  });
  registerEffectTool(tools, {
    name: 'remove_skill',
    description: 'Remove a skill.',
    input: SkillIdInput,
    output: RemoveSkillResponse,
    handler: ({ skillId }) =>
      SkillRegistry.use((registry) => registry.remove(skillId)).pipe(Effect.map((removed) => ({ removed }))),
  });

  registerEffectTool(tools, {
    name: 'list_integrations',
    description: 'List the integrations, their connections, and every tool the platform can reach.',
    input: EmptyInput,
    output: IntegrationsResponse,
    handler: () => IntegrationCatalog.use((catalog) => catalog.listIntegrations()),
  });
  registerEffectTool(tools, {
    name: 'discover_integration',
    description: 'Add an integration from a URL: an MCP endpoint, an OpenAPI document, or a Google Discovery document.',
    input: DiscoverIntegrationInput,
    output: DiscoverIntegrationResponse,
    handler: (input) =>
      IntegrationCatalog.use((catalog) => catalog.discoverIntegration(input)).pipe(
        Effect.map((integration) => ({ integration })),
      ),
  });
  registerEffectTool(tools, {
    name: 'connect_integration',
    description: 'Connect an integration with a static credential (API key, header token) or with no auth.',
    input: ConnectIntegrationToolInput,
    output: ConnectIntegrationResponse,
    handler: ({ slug, ...input }) => IntegrationCatalog.use((catalog) => catalog.connect(slug, { kind: 'org' }, input)),
  });
  registerEffectTool(tools, {
    name: 'start_integration_oauth',
    description: 'Start an OAuth connection for an integration; returns the authorization URL a human must open.',
    input: StartOAuthConnectionToolInput,
    output: OAuthSessionView,
    handler: ({ slug, ...input }) =>
      IntegrationCatalog.use((catalog) => catalog.startOAuth(slug, { kind: 'org' }, input)),
  });
  registerEffectTool(tools, {
    name: 'remove_integration',
    description: 'Remove an integration, its connections, and every grant that named them.',
    input: IntegrationSlugInput,
    output: RemoveIntegrationResponse,
    handler: ({ slug }) =>
      IntegrationCatalog.use((catalog) => catalog.removeIntegration(slug)).pipe(Effect.as({ removed: true })),
  });
  registerEffectTool(tools, {
    name: 'list_agent_tools',
    description:
      "List every tool with the mode an agent's config gives it (native, codemode, disabled), plus declarations the server cannot resolve. Change tools with update_agent.",
    input: AgentIdInput,
    output: AgentToolsResponse,
    handler: ({ agentId }) => IntegrationCatalog.use((catalog) => catalog.listAgentTools(agentId)),
  });
  registerEffectTool(tools, {
    name: 'list_pending_approvals',
    description: 'List tool calls frozen until a human approves them.',
    input: EmptyInput,
    output: ApprovalsResponse,
    handler: () =>
      IntegrationCatalog.use((catalog) => catalog.listApprovals('pending')).pipe(
        Effect.map((approvals) => ({ approvals })),
      ),
  });

  registerEffectTool(tools, {
    name: 'list_sessions',
    description: 'List chat sessions for an agent.',
    input: AgentIdInput,
    output: SessionsResponse,
    handler: ({ agentId }) =>
      SessionsService.use((store) => store.listChatSessions(agentId)).pipe(Effect.map((sessions) => ({ sessions }))),
  });
  registerEffectTool(tools, {
    name: 'delete_session',
    description: 'Delete a chat session for an agent.',
    input: AgentSessionInput,
    output: DeleteSessionResponse,
    handler: ({ agentId, sessionId }) =>
      SessionsService.use((store) => store.deleteSession({ targetId: agentId, sessionId })).pipe(
        Effect.as({ deleted: true }),
      ),
  });
  registerEffectTool(tools, {
    name: 'list_eval_sessions',
    description: 'List evaluation sessions across agents and workflows.',
    input: EmptyInput,
    output: EvalSessionsResponse,
    handler: () =>
      SessionsService.use((store) => store.listEvalSessions()).pipe(Effect.map((sessions) => ({ sessions }))),
  });
  registerEffectTool(tools, {
    name: 'get_eval_session',
    description: 'Get evaluation session details.',
    input: EvalSessionInput,
    output: EvalSessionDetail,
    handler: (input) => SessionsService.use((store) => store.getEvalSession(input)),
  });

  registerEffectTool(tools, {
    name: 'list_eval_datasets',
    description: 'List eval datasets: sets of cases (an input plus an optional reference answer) to test agents on.',
    input: EmptyInput,
    output: EvalDatasetList,
    handler: () => EvalService.use((evals) => evals.listDatasets()),
  });
  registerEffectTool(tools, {
    name: 'get_eval_dataset',
    description: 'Get an eval dataset with all of its cases.',
    input: EvalDatasetIdInput,
    output: EvalDatasetDetail,
    handler: ({ datasetId }) => EvalService.use((evals) => evals.getDataset(datasetId)),
  });
  registerEffectTool(tools, {
    name: 'create_eval_dataset',
    description:
      'Create an eval dataset, optionally with cases. Draw cases from real failures, cover both cases where a behavior should and should not happen, and write each so two experts would agree on the verdict.',
    input: CreateEvalDatasetInput,
    output: EvalDataset,
    handler: (input) => EvalService.use((evals) => evals.createDataset(input)),
  });
  registerEffectTool(tools, {
    name: 'add_eval_cases',
    description: 'Append cases to an eval dataset.',
    input: AddEvalCasesToolInput,
    output: EvalCaseList,
    handler: ({ datasetId, cases }) => EvalService.use((evals) => evals.addCases(datasetId, { cases })),
  });
  registerEffectTool(tools, {
    name: 'list_eval_graders',
    description: 'List eval graders: code checks (match, regex, JSON, tool calls, latency) and LLM judges.',
    input: EmptyInput,
    output: EvalGraderList,
    handler: () => EvalService.use((evals) => evals.listGraders()),
  });
  registerEffectTool(tools, {
    name: 'create_eval_grader',
    description:
      'Create an eval grader. Prefer code checks; use an llm-judge for what code cannot check, one dimension per judge, with specific checkable criteria in the prompt.',
    input: EvalGraderInput,
    output: EvalGrader,
    handler: (input) => EvalService.use((evals) => evals.createGrader(input)),
  });
  registerEffectTool(tools, {
    name: 'start_eval_run',
    description:
      'Run a dataset against an agent or workflow and grade every trial. This calls the target (and every LLM judge) once per case and trial, which costs tokens: try a few cases with `limit` first. Returns at once; poll get_eval_run for results.',
    input: CreateEvalRunInput,
    output: EvalRun,
    handler: (input) => EvalService.use((evals) => evals.startRun(input)),
  });
  registerEffectTool(tools, {
    name: 'list_eval_runs',
    description: 'List eval runs with their pass rates, standard errors and grader summaries.',
    input: EmptyInput,
    output: EvalRunList,
    handler: () => EvalService.use((evals) => evals.listRuns()),
  });
  registerEffectTool(tools, {
    name: 'get_eval_run',
    description:
      "Get an eval run with every trial's output, tool calls and grades. Read the transcripts, not just the score.",
    input: EvalRunIdInput,
    output: EvalRunDetail,
    handler: ({ runId }) => EvalService.use((evals) => evals.getRun(runId)),
  });

  registerEffectTool(tools, {
    name: 'list_eval_gates',
    description: 'List regression gates: datasets that rerun against an agent whenever it changes.',
    input: EmptyInput,
    output: EvalGateList,
    handler: () => EvalGates.use((gates) => gates.list()),
  });
  registerEffectTool(tools, {
    name: 'create_eval_gate',
    description:
      "Guard an agent with a dataset: every later change to the agent's instructions, model, reasoning effort or skills reruns the dataset (narrowed by tags and limit) and compares it with the previous run. Each change spends a full run's model calls.",
    input: EvalGateInput,
    output: EvalGate,
    handler: (input) => EvalGates.use((gates) => gates.create(input)),
  });

  registerEffectTool(tools, {
    name: 'list_traces',
    description: 'List observed traces.',
    input: ListTracesQuery,
    output: TraceListResponse,
    handler: (input) => TracesService.use((service) => service.listTraces(input)),
  });
  registerEffectTool(tools, {
    name: 'get_trace',
    description: 'Get trace span details.',
    input: TraceIdInput,
    output: TraceDetailResponse,
    handler: ({ traceId }) => TracesService.use((service) => service.getTrace(traceId)),
  });

  server.setRequestHandler(ListToolsRequest, () => ({ tools: Array.from(tools.values()).map(toMcpTool) }));
  server.setRequestHandler(CallToolRequest, async (request) => {
    const tool = tools.get(request.params.name);
    if (!tool) return makeToolError(`Tool ${request.params.name} not found`);
    return run(tool.call(coerceJson(request.params.arguments ?? {})));
  });

  return server;
};

const jsonRpcError = (status: number, code: number, message: string): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;

/**
 * Serves the MCP tools over streamable HTTP. Callers authenticate each request
 * before handing it in and name its `owner`; a session answers only the owner
 * that opened it. Clients rarely close their sessions, so idle ones are
 * evicted on the next request.
 */
export const createAgentdockMcpRequestHandler = (services: Context.Context<McpRuntimeServices>): AgentdockMcpHandle => {
  const runPromise = Effect.runPromiseWith(services);
  const sessions = new Map<
    string,
    {
      readonly transport: WebStandardStreamableHTTPServerTransport;
      readonly server: AgentdockMcpServer;
      readonly owner: string;
      lastSeen: number;
    }
  >();

  const dispose = async (id: string) => {
    const session = sessions.get(id);
    sessions.delete(id);
    await session?.transport.close();
    await session?.server.close();
  };

  const evictIdle = async (at: number) => {
    const idle = [...sessions].filter(([, session]) => at - session.lastSeen > SESSION_IDLE_TTL_MS);
    await Promise.all(idle.map(([id]) => dispose(id)));
  };

  const run = <A>(effect: Effect.Effect<A, never, McpRuntimeServices>) => runPromise(effect);

  return {
    handleRequest: async (request, owner) => {
      const at = await runPromise(Clock.currentTimeMillis);
      await evictIdle(at);
      const sessionId = request.headers.get('mcp-session-id');

      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return jsonRpcError(404, -32001, 'Session not found');
        if (session.owner !== owner) return jsonRpcError(403, -32003, 'The session belongs to another caller');
        session.lastSeen = at;
        return session.transport.handleRequest(request);
      }

      const server = createAgentdockMcpServer(run);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => Effect.runSync(randomUUIDv4),
        enableJsonResponse: true,
        onsessioninitialized: (id: string) => {
          sessions.set(id, { transport, server, owner, lastSeen: at });
        },
        onsessionclosed: (id: string) => void dispose(id),
      });

      try {
        await server.connect(transport);
        const response = await transport.handleRequest(request);
        if (!transport.sessionId) {
          await transport.close();
          await server.close();
        }
        return response;
      } catch (error) {
        await runPromise(Effect.logError('[agentdock-mcp] request failed', error));
        if (!transport.sessionId) {
          await transport.close();
          await server.close();
        }
        return jsonRpcError(500, -32603, 'Internal server error');
      }
    },
    close: async () => {
      await Promise.all([...sessions.keys()].map(dispose));
    },
  };
};
