import type { AgentIntegrations, AgentRecord } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import { IntegrationCatalog } from '../gateway/catalog';
import { AgentCommunicationPolicy, WILDCARD_TARGET } from './communication-policy';

/** Runs before an agent is stored: everything its config declares must be resolvable on this server. */
export const prepareAgentIntegrations = (input: { readonly integrations: AgentIntegrations }) =>
  IntegrationCatalog.use((catalog) => catalog.provisionAgentIntegrations(input.integrations));

/** Runs after an agent is stored: the derived tables the runtime reads follow the config. */
export const syncAgent = (agent: AgentRecord) =>
  Effect.all(
    [
      AgentCommunicationPolicy.use((policy) =>
        policy.replaceForAgent({
          sourceAgentId: agent.id,
          targetAgentIds: agent.communication.allowAll ? [WILDCARD_TARGET] : agent.communication.allowedAgentIds,
        }),
      ),
      IntegrationCatalog.use((catalog) => catalog.syncAgentGrants(agent.id)),
    ],
    { discard: true },
  );

export const forgetAgent = (agentId: string) =>
  Effect.all(
    [
      AgentCommunicationPolicy.use((policy) => policy.replaceForAgent({ sourceAgentId: agentId, targetAgentIds: [] })),
      IntegrationCatalog.use((catalog) => catalog.forgetAgent(agentId)),
    ],
    { discard: true },
  );
