import * as Effect from 'effect/Effect';
import { AgentRegistry } from '../agents/service';
import { IntegrationCatalog } from '../gateway/catalog';
import { type BindingCandidates, WorkflowRegistry } from './service';

/** Everything a registration may bind manifest names to, read once per push. */
export const bindingCandidates = Effect.gen(function* () {
  const agents = yield* AgentRegistry;
  const workflows = yield* WorkflowRegistry;
  const catalog = yield* IntegrationCatalog;
  const candidates: BindingCandidates = {
    agents: yield* agents.list(),
    externalAgents: yield* agents.listExternal(),
    workflows: yield* workflows.list(),
    tools: (yield* catalog.listIntegrations()).tools,
  };
  return candidates;
});
