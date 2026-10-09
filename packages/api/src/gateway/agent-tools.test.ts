import { describe, expect, it } from '@effect/vitest';
import { aliasForConnection } from '@integragents/contracts';
import {
  AGENTDOCK_URL_PLACEHOLDER,
  type AgentIntegrations,
  type CatalogTool,
  ConnectionName,
  IntegrationSlug,
  type IntegrationView,
  integrationToolId,
} from 'agentdock-sdk/schemas';
import { resolveAgentTools } from './agent-tools';

const slug = IntegrationSlug.make('github');
const name = ConnectionName.make('default');

const orgAlias = aliasForConnection({ owner: 'org', integration: slug, name });
const userAlias = aliasForConnection({ owner: 'user', integration: slug, name });

const tool = (alias: string, toolName: string, delegated = false): CatalogTool => ({
  id: integrationToolId(alias, toolName),
  alias,
  name: toolName,
  description: '',
  integration: slug,
  connection: delegated ? { owner: 'user', integration: slug, name } : { owner: 'org', integration: slug, name },
  decision: 'allow',
  delegated,
});

const catalogTools = [
  tool(orgAlias, 'list_issues'),
  tool(orgAlias, 'create_issue'),
  tool(userAlias, 'list_issues', true),
];

const integration = (connections: IntegrationView['connections']): IntegrationView => ({
  slug,
  name: 'GitHub',
  description: '',
  kind: 'mcp',
  displayUrl: 'https://mcp.example.com/github',
  requiresAuthentication: true,
  authMethods: [{ id: 'oauth', label: 'OAuth', kind: 'oauth', template: 'oauth' }],
  connections,
  tools: catalogTools.filter((candidate) => !candidate.delegated),
});

const connected = integration([
  {
    owner: { kind: 'org' },
    integration: slug,
    name,
    template: 'oauth',
    status: 'connected',
    identityLabel: null,
    expiresAt: null,
  },
]);

const resolve = (integrations: AgentIntegrations, view: IntegrationView = connected) =>
  resolveAgentTools({
    integrations,
    catalog: { integrations: [view], tools: catalogTools },
    agentdockUrl: 'http://127.0.0.1:38123',
  });

describe('resolveAgentTools', () => {
  it('grants named tools their mode and leaves the rest disabled', () => {
    const { tools, unresolved } = resolve({
      github: {
        endpoint: 'https://mcp.example.com/github',
        connection: { owner: 'org', name },
        tools: { list_issues: 'native' },
      },
    });
    expect(unresolved).toEqual([]);
    expect(tools.map((candidate) => [candidate.id, candidate.mode])).toEqual([
      [`${orgAlias}.list_issues`, 'native'],
      [`${orgAlias}.create_issue`, 'disabled'],
      [`${userAlias}.list_issues`, 'disabled'],
    ]);
  });

  it('expands * to every tool of the connection with explicit names overriding', () => {
    const { tools } = resolve({
      github: {
        endpoint: 'https://mcp.example.com/github',
        connection: { owner: 'org', name },
        tools: { '*': 'codemode', create_issue: 'native' },
      },
    });
    expect(tools.map((candidate) => candidate.mode)).toEqual(['codemode', 'native', 'disabled']);
  });

  it('reaches the user template through a user connection', () => {
    const { tools } = resolve({
      github: {
        endpoint: 'https://mcp.example.com/github',
        connection: { owner: 'user', name },
        tools: { list_issues: 'codemode' },
      },
    });
    expect(tools.find((candidate) => candidate.id === `${userAlias}.list_issues`)?.mode).toBe('codemode');
    expect(tools.find((candidate) => candidate.id === `${orgAlias}.list_issues`)?.mode).toBe('disabled');
  });

  it('substitutes the server placeholder before matching endpoints', () => {
    const own = { ...connected, displayUrl: 'http://127.0.0.1:38123/mcp' };
    const { unresolved } = resolve(
      {
        agentdock: {
          endpoint: `${AGENTDOCK_URL_PLACEHOLDER}/mcp`,
          connection: { owner: 'org', name },
          tools: { '*': 'codemode' },
        },
      },
      own,
    );
    expect(unresolved).toEqual([]);
  });

  it('reports what the catalog cannot serve', () => {
    const { tools, unresolved } = resolve(
      {
        missing: {
          endpoint: 'https://mcp.example.com/elsewhere',
          connection: { owner: 'org', name },
          tools: { anything: 'native' },
        },
        github: {
          endpoint: 'https://mcp.example.com/github',
          connection: { owner: 'org', name },
          tools: { list_issues: 'native' },
        },
      },
      integration([]),
    );
    expect(tools.every((candidate) => candidate.mode === 'disabled')).toBe(true);
    expect(unresolved.map((entry) => [entry.integration, entry.reason])).toEqual([
      ['missing', 'unknown-endpoint'],
      ['github', 'oauth-required'],
    ]);
  });

  it('flags a named tool the integration does not have', () => {
    const { unresolved } = resolve({
      github: {
        endpoint: 'https://mcp.example.com/github',
        connection: { owner: 'org', name },
        tools: { delete_repo: 'native' },
      },
    });
    expect(unresolved).toEqual([
      expect.objectContaining({ integration: 'github', tool: 'delete_repo', reason: 'unknown-tool' }),
    ]);
  });
});
