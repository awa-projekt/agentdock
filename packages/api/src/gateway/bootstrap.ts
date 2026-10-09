import { HOME_INTERNAL_AGENT_ID, INTERNAL_INTEGRATION_SLUG } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import { IntegrationCatalog } from './catalog';

const INTERNAL_MCP_NAME = 'Agentdock Internal MCP';
const INTERNAL_CONNECTION = 'default';

/**
 * Registers this server's own internal MCP endpoint as an integration,
 * connects it with the token this process issued at startup, and grants the
 * built-in assistant the tools its config declares on it. The token changes
 * with every start, so the connection is replaced each time. The internal
 * tools run without approval: they only touch this instance's own
 * configuration, and the assistant is meant to operate it directly. A checkout
 * that derives a different port re-registers it, because a slug can only ever
 * point at one URL.
 */
export const bootstrapInternalAgentMcpSource = Effect.fn('bootstrapInternalAgentMcpSource')(function* ({
  endpoint,
  token,
}: {
  readonly endpoint: string;
  readonly token: string;
}) {
  const catalog = yield* IntegrationCatalog;
  const known = (yield* catalog.listIntegrations()).integrations.find(
    (integration) => integration.slug === INTERNAL_INTEGRATION_SLUG,
  );
  if (known !== undefined && known.displayUrl !== endpoint) {
    yield* catalog.removeIntegration(INTERNAL_INTEGRATION_SLUG);
  }
  if (known === undefined || known.displayUrl !== endpoint) {
    yield* catalog.discoverIntegration({ url: endpoint, slug: INTERNAL_INTEGRATION_SLUG, name: INTERNAL_MCP_NAME });
  } else if (known.connections.some((connection) => connection.name === INTERNAL_CONNECTION)) {
    yield* catalog.removeConnection(INTERNAL_INTEGRATION_SLUG, INTERNAL_CONNECTION, { kind: 'org' });
  }
  yield* catalog.connect(
    INTERNAL_INTEGRATION_SLUG,
    { kind: 'org' },
    { name: INTERNAL_CONNECTION, template: 'bearer', values: { token } },
  );
  const { tools } = yield* catalog.listAgentTools(HOME_INTERNAL_AGENT_ID);
  yield* Effect.forEach(
    tools.filter((tool) => tool.integration === INTERNAL_INTEGRATION_SLUG && tool.decision !== 'allow'),
    (tool) => catalog.setToolDecision(tool.id, 'allow'),
    { discard: true },
  );
});
