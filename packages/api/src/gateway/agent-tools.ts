import { aliasForConnection, ConnectionName, type ConnectionRef, IntegrationSlug } from '@integragents/contracts';
import {
  AGENTDOCK_URL_PLACEHOLDER,
  type AgentIntegration,
  type AgentIntegrations,
  type AgentToolMode,
  type AgentToolView,
  ALL_TOOLS,
  type AuthMethod,
  type CatalogTool,
  type IntegrationView,
  integrationToolId,
  type UnresolvedAgentTool,
} from 'agentdock-sdk/schemas';

export type AgentToolResolution = {
  readonly tools: ReadonlyArray<AgentToolView>;
  readonly unresolved: ReadonlyArray<UnresolvedAgentTool>;
};

export type CatalogSnapshot = {
  readonly integrations: ReadonlyArray<IntegrationView>;
  readonly tools: ReadonlyArray<CatalogTool>;
};

export const resolveEndpoint = (endpoint: string, agentdockUrl: string): string =>
  endpoint.replaceAll(AGENTDOCK_URL_PLACEHOLDER, agentdockUrl);

export const findIntegrationByEndpoint = <I extends { readonly displayUrl?: string | undefined }>(
  integrations: ReadonlyArray<I>,
  endpoint: string,
): I | undefined => integrations.find((integration) => integration.displayUrl === endpoint);

type NoAuth = { readonly id: 'none'; readonly template: 'none'; readonly kind: 'none' };

/** The auth method a connection is made with: the named template, or the integration's only or OAuth one. */
export const selectAuthMethod = <M extends Pick<AuthMethod, 'id' | 'template' | 'kind'>>(
  methods: ReadonlyArray<M>,
  template: string | undefined,
): M | NoAuth | undefined => {
  if (template !== undefined) return methods.find((method) => method.template === template || method.id === template);
  if (methods.length === 0) return { id: 'none', template: 'none', kind: 'none' };
  if (methods.length === 1) return methods[0];
  return methods.find((method) => method.kind === 'oauth') ?? methods[0];
};

const connectionRefOfBlock = (slug: string, block: AgentIntegration): ConnectionRef => ({
  owner: block.connection.owner,
  integration: IntegrationSlug.make(slug),
  name: ConnectionName.make(block.connection.name),
});

const modeOf = (block: AgentIntegration, tool: string): AgentToolMode | undefined =>
  block.tools[tool] ?? block.tools[ALL_TOOLS];

const hasConnection = (integration: IntegrationView, block: AgentIntegration): boolean =>
  block.connection.owner === 'user' ||
  integration.connections.some(
    (connection) => connection.owner.kind === 'org' && connection.name === block.connection.name,
  );

/**
 * Matches an agent's declared integrations against what the catalog serves
 * right now. Every catalog tool comes back with the mode the agent gives it,
 * `disabled` when it gives none; declarations the catalog cannot honour are
 * listed separately so a push or the UI can say exactly what is missing.
 */
export const resolveAgentTools = (input: {
  readonly integrations: AgentIntegrations;
  readonly catalog: CatalogSnapshot;
  readonly agentdockUrl: string;
}): AgentToolResolution => {
  const granted = new Map<string, AgentToolMode>();
  const unresolved: Array<UnresolvedAgentTool> = [];
  const byId = new Map(input.catalog.tools.map((tool) => [tool.id, tool]));

  for (const [key, block] of Object.entries(input.integrations)) {
    const endpoint = resolveEndpoint(block.endpoint, input.agentdockUrl);
    const integration = findIntegrationByEndpoint(input.catalog.integrations, endpoint);
    if (integration === undefined) {
      unresolved.push({
        integration: key,
        reason: 'unknown-endpoint',
        message: `${key}: no integration is registered for ${endpoint}`,
      });
      continue;
    }
    if (!hasConnection(integration, block)) {
      const method = selectAuthMethod(integration.authMethods, block.auth?.template);
      const oauth = method?.kind === 'oauth';
      unresolved.push({
        integration: key,
        reason: oauth ? 'oauth-required' : 'no-connection',
        slug: integration.slug,
        message: oauth
          ? `${key}: ${integration.name} needs a person to authorise the ${block.connection.name} connection`
          : `${key}: ${integration.name} has no ${block.connection.name} connection`,
      });
      continue;
    }
    const alias = aliasForConnection(connectionRefOfBlock(integration.slug, block));
    for (const name of Object.keys(block.tools)) {
      if (name === ALL_TOOLS) continue;
      if (!byId.has(integrationToolId(alias, name))) {
        unresolved.push({
          integration: key,
          tool: name,
          reason: 'unknown-tool',
          slug: integration.slug,
          message: `${key}: ${integration.name} has no tool ${name}`,
        });
      }
    }
    for (const tool of input.catalog.tools) {
      if (tool.alias !== alias) continue;
      const mode = modeOf(block, tool.name);
      if (mode !== undefined) granted.set(tool.id, mode);
    }
  }

  return {
    tools: input.catalog.tools.map((tool) => ({ ...tool, mode: granted.get(tool.id) ?? 'disabled' })),
    unresolved,
  };
};
