import { Layer } from 'effect';
import { generalHandler } from './handlers/general';
import { agentsHandler } from './handlers/agents';
import { executorHandler } from './handlers/executor';
import { sessionsHandler } from './handlers/sessions';
import { tracesHandler } from './handlers/traces';
import { workflowsHandler } from './handlers/workflows';
import { skillsHandler } from './handlers/skills';
import { AgentRegistryLive } from './agents/service';
import { WorkflowRegistryLive } from './workflows/service';
import { AgentCommunicationPolicyLive } from './agents/communication-policy';
import { AgentA2aHandlersLive } from './a2a/handlers';
import { WorkflowA2aHandlersLive } from './workflows/a2a';
import { AgentA2aStateLive } from './a2a/state';
import { AgentA2aSessionStoreLive } from './a2a/session-store';
import { AgentExecutorRegistryLive } from './executor/service';
import { TracesServiceLive } from './traces/service';
import { SkillRegistryLive } from './skills/service';

const AgentServicesLive = Layer.mergeAll(AgentRegistryLive, WorkflowRegistryLive, AgentCommunicationPolicyLive, AgentExecutorRegistryLive, SkillRegistryLive);

const BaseServicesLive = Layer.mergeAll(
  AgentServicesLive,
  AgentA2aStateLive.pipe(Layer.provideMerge(AgentA2aSessionStoreLive)),
  TracesServiceLive,
);

export const CoreServices = Layer.merge(AgentA2aHandlersLive, WorkflowA2aHandlersLive).pipe(
  Layer.provideMerge(BaseServicesLive),
);

export const CoreHandlers = Layer.mergeAll(
  generalHandler,
  agentsHandler,
  skillsHandler,
  workflowsHandler,
  executorHandler,
  sessionsHandler,
  tracesHandler,
).pipe(Layer.provide(CoreServices));
