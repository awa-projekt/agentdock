import {
  type AgentIntegration,
  type AgentIntegrations,
  type AgentToolConnection,
  type AgentToolView,
  ALL_TOOLS,
  type IntegrationToolMode,
  type IntegrationView,
} from 'agentdock-sdk/schemas';

/** Which connection an agent reaches an integration through, or none. */
export type IntegrationChoice = 'org' | 'user' | 'off';

type Catalog = {
  readonly integrations: ReadonlyArray<IntegrationView>;
  readonly tools: ReadonlyArray<AgentToolView>;
};

const sameConnection = (block: AgentIntegration, endpoint: string, connection: AgentToolConnection): boolean =>
  block.endpoint === endpoint &&
  block.connection.owner === connection.owner &&
  block.connection.name === connection.name;

const findBlock = (
  integrations: AgentIntegrations,
  endpoint: string,
  connection: AgentToolConnection,
): readonly [string, AgentIntegration] | undefined =>
  Object.entries(integrations).find(([, block]) => sameConnection(block, endpoint, connection));

const freeKey = (integrations: AgentIntegrations, slug: string, connection: AgentToolConnection): string => {
  const base =
    connection.owner === 'user' ? `${slug}-user` : connection.name === 'default' ? slug : `${slug}-${connection.name}`;
  let key = base;
  for (let suffix = 2; key in integrations; suffix += 1) key = `${base}-${suffix}`;
  return key;
};

const withoutEmpty = (integrations: AgentIntegrations): AgentIntegrations =>
  Object.fromEntries(Object.entries(integrations).filter(([, block]) => Object.keys(block.tools).length > 0));

/** `*` expanded to every tool the connection currently serves, so a single one can be taken away. */
const explicitTools = (block: AgentIntegration, alias: string, catalog: Catalog): AgentIntegration['tools'] => {
  const all = block.tools[ALL_TOOLS];
  if (all === undefined) return block.tools;
  const { [ALL_TOOLS]: _, ...explicit } = block.tools;
  const expanded = Object.fromEntries(
    catalog.tools.filter((tool) => tool.alias === alias).map((tool) => [tool.name, all] as const),
  );
  return { ...expanded, ...explicit };
};

const endpointOf = (catalog: Catalog, slug: string): string | undefined =>
  catalog.integrations.find((integration) => integration.slug === slug)?.displayUrl;

export const withToolMode = (
  integrations: AgentIntegrations,
  catalog: Catalog,
  tool: AgentToolView,
  mode: IntegrationToolMode,
): AgentIntegrations => {
  const endpoint = endpointOf(catalog, tool.integration);
  if (endpoint === undefined) return integrations;
  const connection: AgentToolConnection = { owner: tool.connection.owner, name: tool.connection.name };
  const found = findBlock(integrations, endpoint, connection);
  if (mode === 'disabled') {
    if (found === undefined) return integrations;
    const [key, block] = found;
    const { [tool.name]: _, ...rest } = explicitTools(block, tool.alias, catalog);
    return withoutEmpty({ ...integrations, [key]: { ...block, tools: rest } });
  }
  if (found === undefined) {
    const key = freeKey(integrations, tool.integration, connection);
    return { ...integrations, [key]: { endpoint, connection, tools: { [tool.name]: mode } } };
  }
  const [key, block] = found;
  return { ...integrations, [key]: { ...block, tools: { ...block.tools, [tool.name]: mode } } };
};

export const withIntegrationChoice = (
  integrations: AgentIntegrations,
  catalog: Catalog,
  slug: string,
  choice: IntegrationChoice,
): AgentIntegrations => {
  const endpoint = endpointOf(catalog, slug);
  if (endpoint === undefined) return integrations;
  const kept: AgentIntegrations = Object.fromEntries(
    Object.entries(integrations).filter(([, block]) => block.endpoint !== endpoint),
  );
  if (choice === 'off') return kept;
  const connections = new Map<string, AgentToolConnection>();
  for (const tool of catalog.tools) {
    if (tool.integration !== slug || tool.delegated !== (choice === 'user')) continue;
    const connection: AgentToolConnection = { owner: tool.connection.owner, name: tool.connection.name };
    connections.set(`${connection.owner}:${connection.name}`, connection);
  }
  let next = kept;
  for (const connection of connections.values()) {
    next = { ...next, [freeKey(next, slug, connection)]: { endpoint, connection, tools: { [ALL_TOOLS]: 'codemode' } } };
  }
  return next;
};
