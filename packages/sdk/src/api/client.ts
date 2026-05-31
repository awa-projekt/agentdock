import { Effect, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { HttpApiClient } from 'effect/unstable/httpapi';
import { AgentdockApi } from './http';
import {
  AgentIdSchema,
  ExecutorSourceIdSchema,
  SkillIdSchema,
  TraceIdSchema,
  WorkflowIdSchema,
} from './schemas';
import type {
  AddMcpSourceInput,
  AddGoogleDiscoverySourceInput,
  AddGraphqlSourceInput,
  AddOpenApiSourceInput,
  AssignAgentSkillsInput,
  CreateAgentInput,
  CreateSkillInput,
  CreateWorkflowInput,
  DetectSourceInput,
  McpProbeInput,
  PreviewOpenApiInput,
  ProbeGoogleDiscoveryInput,
  PullSkillsInput,
  SetExecutorToolModesInput,
  SetPinnedExecutorToolsInput,
  StartOAuthInput,
  UpdateMcpSourceInput,
} from './schemas';

export type AgentdockClientOptions = {
  readonly baseUrl: string;
};

export const createAgentdockClient = ({ baseUrl }: AgentdockClientOptions) => {
  const makeClient = HttpApiClient.make(AgentdockApi, { baseUrl });
  const run = <A>(effect: Effect.Effect<A, unknown, never>) => Effect.runPromise(effect);
  const agentIdOf = Schema.decodeUnknownSync(AgentIdSchema);
  const skillIdOf = Schema.decodeUnknownSync(SkillIdSchema);
  const workflowIdOf = Schema.decodeUnknownSync(WorkflowIdSchema);
  const sourceIdOf = Schema.decodeUnknownSync(ExecutorSourceIdSchema);
  const traceIdOf = Schema.decodeUnknownSync(TraceIdSchema);
  const withClient = <A>(
    f: (client: Effect.Success<typeof makeClient>) => Effect.Effect<A, unknown, never>,
  ) =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      return yield* f(client);
    }).pipe(Effect.provide(FetchHttpClient.layer));

  return {
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
    removeSkill: (skillId: string) => run(withClient((client) => client.skills.removeSkill({ params: { skillId: skillIdOf(skillId) } }))),
    assignAgentSkills: (agentId: string, payload: AssignAgentSkillsInput) =>
      run(withClient((client) => client.skills.assignAgentSkills({ params: { agentId: agentIdOf(agentId) }, payload }))),
    loadAgentSkill: (agentId: string, skillId: string) =>
      run(withClient((client) => client.skills.loadAgentSkill({ params: { agentId: agentIdOf(agentId), skillId: skillIdOf(skillId) } }))),
    listWorkflows: () => run(withClient((client) => client.workflows.listWorkflows({}))),
    addWorkflow: (payload: CreateWorkflowInput) =>
      run(withClient((client) => client.workflows.addWorkflow({ payload }))),
    updateWorkflow: (workflowId: string, payload: CreateWorkflowInput) =>
      run(withClient((client) => client.workflows.updateWorkflow({ params: { workflowId: workflowIdOf(workflowId) }, payload }))),
    removeWorkflow: (workflowId: string) =>
      run(withClient((client) => client.workflows.removeWorkflow({ params: { workflowId: workflowIdOf(workflowId) } }))),
    getHealth: () => run(withClient((client) => client.general.health({}))),
    listExecutorSources: (agentId: string) =>
      run(withClient((client) => client.agentExecutor.listExecutorSources({ params: { agentId: agentIdOf(agentId) } }))),
    detectSource: (agentId: string, payload: DetectSourceInput) =>
      run(withClient((client) => client.agentExecutor.detectSource({ params: { agentId: agentIdOf(agentId) }, payload }))),
    probeMcpEndpoint: (agentId: string, payload: McpProbeInput) =>
      run(withClient((client) => client.agentExecutor.probeMcpEndpoint({ params: { agentId: agentIdOf(agentId) }, payload }))),
    addMcpSource: (agentId: string, payload: AddMcpSourceInput) =>
      run(withClient((client) => client.agentExecutor.addMcpSource({ params: { agentId: agentIdOf(agentId) }, payload }))),
    updateMcpSource: (agentId: string, sourceId: string, payload: UpdateMcpSourceInput) =>
      run(withClient((client) =>
        client.agentExecutor.updateMcpSource({ params: { agentId: agentIdOf(agentId), sourceId: sourceIdOf(sourceId) }, payload }),
      )),
    removeMcpSource: (agentId: string, sourceId: string) =>
      run(withClient((client) =>
        client.agentExecutor.removeMcpSource({ params: { agentId: agentIdOf(agentId), sourceId: sourceIdOf(sourceId) } }),
      )),
    previewOpenApiSpec: (agentId: string, payload: PreviewOpenApiInput) =>
      run(withClient((client) => client.agentExecutor.previewOpenApiSpec({ params: { agentId: agentIdOf(agentId) }, payload }))),
    addOpenApiSource: (agentId: string, payload: AddOpenApiSourceInput) =>
      run(withClient((client) => client.agentExecutor.addOpenApiSource({ params: { agentId: agentIdOf(agentId) }, payload }))),
    addGraphqlSource: (agentId: string, payload: AddGraphqlSourceInput) =>
      run(withClient((client) => client.agentExecutor.addGraphqlSource({ params: { agentId: agentIdOf(agentId) }, payload }))),
    probeGoogleDiscovery: (agentId: string, payload: ProbeGoogleDiscoveryInput) =>
      run(withClient((client) => client.agentExecutor.probeGoogleDiscovery({ params: { agentId: agentIdOf(agentId) }, payload }))),
    addGoogleDiscoverySource: (agentId: string, payload: AddGoogleDiscoverySourceInput) =>
      run(withClient((client) => client.agentExecutor.addGoogleDiscoverySource({ params: { agentId: agentIdOf(agentId) }, payload }))),
    removeExecutorSource: (agentId: string, sourceId: string) =>
      run(withClient((client) =>
        client.agentExecutor.removeExecutorSource({ params: { agentId: agentIdOf(agentId), sourceId: sourceIdOf(sourceId) } }),
      )),
    setPinnedExecutorTools: (agentId: string, payload: SetPinnedExecutorToolsInput) =>
      run(withClient((client) => client.agentExecutor.setPinnedExecutorTools({ params: { agentId: agentIdOf(agentId) }, payload }))),
    setExecutorToolModes: (agentId: string, payload: SetExecutorToolModesInput) =>
      run(withClient((client) => client.agentExecutor.setExecutorToolModes({ params: { agentId: agentIdOf(agentId) }, payload }))),
    startExecutorOAuth: (agentId: string, payload: StartOAuthInput) =>
      run(withClient((client) => client.agentExecutor.startExecutorOAuth({ params: { agentId: agentIdOf(agentId) }, payload }))),
    listSessions: (agentId: string) =>
      run(withClient((client) => client.sessions.listSessions({ params: { agentId: agentIdOf(agentId) } }))),
    deleteSession: (agentId: string, sessionId: string) =>
      run(withClient((client) => client.sessions.deleteSession({ params: { agentId: agentIdOf(agentId), sessionId } }))),
    listEvalSessions: () => run(withClient((client) => client.sessions.listEvalSessions({}))),
    getEvalSession: (targetId: string, sessionId: string) =>
      run(withClient((client) => client.sessions.getEvalSession({ params: { targetId, sessionId } }))),
    listTraces: (options: { readonly service?: string; readonly limit?: number; readonly q?: string } = {}) =>
      run(withClient((client) => client.traces.listTraces({ query: options }))),
    getTrace: (traceId: string) =>
      run(withClient((client) => client.traces.getTrace({ params: { traceId: traceIdOf(traceId) } }))),
  };
};

export type AgentdockClient = ReturnType<typeof createAgentdockClient>;
