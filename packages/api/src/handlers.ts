import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import { DatabaseLive, SecretCipherLive } from 'db';
import * as Layer from 'effect/Layer';
import { AgentA2aHandlersLive } from './a2a/handlers';
import { AgentCommunicationPolicyLive } from './agents/communication-policy';
import { RuntimeHostLayer } from './agents/runtime-layers';
import { AgentRegistryLive } from './agents/service';
import { ChannelDispatcherLive } from './channels/dispatch';
import { ChannelGatewayLive } from './channels/gateway';
import { ChannelRegistryLive } from './channels/service';
import { AuthConfigLive, ProviderEnvConfigLive, ServerConfigLive, TempoConfigLive, TriggerConfigLive } from './config';
import { EvalGatesLive } from './evals/gates';
import { EvalJudgeLive } from './evals/judge';
import { EvalServiceLive } from './evals/service';
import { EvalStoreLive } from './evals/store';
import { EvalTargetsLive } from './evals/targets';
import { ChangeFeedLive } from './events/service';
import { ToolApprovalDeciderLive } from './gateway/approvals';
import { IntegrationCatalogLive } from './gateway/catalog';
import { GatewayLive } from './gateway/layer';
import { AgentToolSetFactoryLive } from './gateway/tools';
import { agentRunsHandler } from './handlers/agent-runs';
import { agentsHandler } from './handlers/agents';
import { channelsHandler } from './handlers/channels';
import { evalsHandler } from './handlers/evals';
import { eventsHandler } from './handlers/events';
import { generalHandler } from './handlers/general';
import { agentToolsHandler, approvalsHandler, integrationsHandler } from './handlers/integrations';
import { mcpAccessHandler } from './handlers/mcp-access';
import { providerKeysHandler } from './handlers/provider-keys';
import { sessionsHandler } from './handlers/sessions';
import { skillsHandler } from './handlers/skills';
import { tracesHandler } from './handlers/traces';
import { triggersHandler } from './handlers/triggers';
import { workflowsHandler } from './handlers/workflows';
import { McpOAuthLive } from './mcp/oauth';
import { ModelCatalogLive } from './models/catalog';
import { ProviderKeyRegistryLive } from './providers/service';
import { GraphRuntimeLive } from './runtime/service';
import { SessionsServiceLive } from './sessions/service';
import { SkillRegistryLive } from './skills/service';
import { TracesServiceLive } from './traces/service';
import { TriggerDispatcherLive } from './triggers/dispatch';
import { EmailSourceLive } from './triggers/email/graph';
import { TriggerSchedulerLive } from './triggers/scheduler';
import { TriggerRegistryLive } from './triggers/service';
import { WorkflowA2aHandlersLive } from './workflows/a2a';
import { WorkflowRunStoreLive } from './workflows/runs';
import { WorkflowRegistryLive } from './workflows/service';
import { WorkflowToolInvokerLive } from './workflows/tool-invoker';

/**
 * Platform bookkeeping: agent/workflow registries, communication policy,
 * executor integrations, skills, provider-key storage, sessions, traces, and
 * the workflow run store — everything that isn't running an agent turn.
 */
const PlatformServicesLive = Layer.mergeAll(
  AgentRegistryLive,
  WorkflowRegistryLive,
  AgentCommunicationPolicyLive,
  AgentToolSetFactoryLive,
  SkillRegistryLive,
  ProviderKeyRegistryLive,
  SessionsServiceLive,
  TracesServiceLive,
  WorkflowRunStoreLive,
  McpOAuthLive.pipe(Layer.provide(Layer.orDie(AuthConfigLive))),
  // Under the platform bundle rather than beside it: `TracesServiceLive`
  // prices model-call spans from the catalog's rates.
).pipe(
  Layer.provideMerge(ToolApprovalDeciderLive),
  Layer.provideMerge(IntegrationCatalogLive),
  Layer.provideMerge(GatewayLive),
  Layer.provide(Layer.orDie(ServerConfigLive)),
  Layer.provideMerge(ModelCatalogLive),
);

// Trigger services: the dispatcher needs the registry, the registry needs the
// workflow registry (for create-time template validation). Wire those internal
// deps here, then satisfy WorkflowRegistry from PlatformServicesLive below.
const TriggerBaseServicesLive = Layer.merge(TriggerDispatcherLive, EmailSourceLive).pipe(
  Layer.provideMerge(TriggerRegistryLive),
);

const TriggerServicesLive = TriggerSchedulerLive.pipe(Layer.provideMerge(TriggerBaseServicesLive));

// Channel services: the gateway owns the platform connections and needs the
// dispatcher, which needs the registry plus the a2a handlers it runs turns
// through. Those handlers come from the core bundle below.
const ChannelServicesLive = ChannelGatewayLive.pipe(
  Layer.provideMerge(ChannelDispatcherLive),
  Layer.provideMerge(ChannelRegistryLive),
  Layer.provide(Layer.orDie(ServerConfigLive)),
);

// Evals run agents in-process and call judge models, so they sit on top of
// the runtime host and the platform registries, like the channel services.
const EvalServicesLive = EvalGatesLive.pipe(
  Layer.provideMerge(EvalServiceLive),
  Layer.provide(Layer.mergeAll(EvalStoreLive, EvalTargetsLive, EvalJudgeLive)),
  Layer.provide(Layer.orDie(ServerConfigLive)),
);

const CoreServicesLayer = Layer.mergeAll(ChannelServicesLive, EvalServicesLive).pipe(
  Layer.provideMerge(Layer.mergeAll(AgentA2aHandlersLive, WorkflowA2aHandlersLive, ModelCatalogLive)),
  Layer.provideMerge(GraphRuntimeLive),
  Layer.provideMerge(Layer.mergeAll(RuntimeHostLayer, WorkflowToolInvokerLive)),
  Layer.provideMerge(TriggerServicesLive),
  Layer.provideMerge(PlatformServicesLive),
  Layer.provideMerge(ChangeFeedLive),
  Layer.provideMerge(Layer.orDie(ProviderEnvConfigLive)),
  Layer.provideMerge(Layer.orDie(TempoConfigLive)),
  Layer.provideMerge(Layer.orDie(TriggerConfigLive)),
  Layer.provideMerge(Layer.orDie(DatabaseLive)),
  Layer.provideMerge(Layer.orDie(SecretCipherLive)),
  // Single outbound HTTP client for all api services (traces, models catalog,
  // email/graph, mcp). Exposed so the HttpApi handlers and the MCP runtime
  // (built from CoreServices) can satisfy their HttpClient requirement.
  // Undici rather than `FetchHttpClient`: node's `fetch` rejects the
  // `content-length` header `HttpClientRequest` sets on a body, so POSTs fail.
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provideMerge(NodeCrypto.layer),
);

export const CoreServices = Layer.orDie(CoreServicesLayer);

export const CoreHandlers = Layer.mergeAll(
  generalHandler,
  eventsHandler,
  providerKeysHandler,
  agentsHandler,
  agentRunsHandler,
  skillsHandler,
  workflowsHandler,
  triggersHandler,
  channelsHandler,
  integrationsHandler,
  agentToolsHandler,
  approvalsHandler,
  sessionsHandler,
  evalsHandler,
  tracesHandler,
  mcpAccessHandler,
).pipe(Layer.provide(CoreServices));
