import { Effect } from 'effect';
import { AgentExecutorRegistry } from '../executor/service';
import { HOME_INTERNAL_AGENT_ID } from './internal-agents.config';

const INTERNAL_MCP_NAMESPACE = 'agentdock_internal';
const INTERNAL_MCP_NAME = 'Agentdock Internal MCP';

export const bootstrapInternalAgentMcpSource = Effect.fn('bootstrapInternalAgentMcpSource')(function* ({
  endpoint,
}: {
  readonly endpoint: string;
}) {
  const registry = yield* AgentExecutorRegistry;
  const sources = yield* registry.listSources(HOME_INTERNAL_AGENT_ID);
  const existing = sources.sources.some(
    (source) => source.id === INTERNAL_MCP_NAMESPACE || source.name === INTERNAL_MCP_NAME || source.url === endpoint,
  );

  if (existing) {
    return;
  }

  yield* registry.addMcpSource(HOME_INTERNAL_AGENT_ID, {
    name: INTERNAL_MCP_NAME,
    endpoint,
    namespace: INTERNAL_MCP_NAMESPACE,
    auth: { kind: 'none' },
  });
});
