import type { AgentIntegrations, AgentToolView, IntegrationView } from 'agentdock-sdk/schemas';
import { ConnectionName, IntegrationSlug, integrationToolId } from 'agentdock-sdk/schemas';
import { describe, expect, it } from 'vitest';
import { withIntegrationChoice, withToolMode } from './agent-tools';

const slug = IntegrationSlug.make('github');
const name = ConnectionName.make('default');
const endpoint = 'https://mcp.example.com/github';

const tool = (alias: string, toolName: string, delegated = false): AgentToolView => ({
  id: integrationToolId(alias, toolName),
  alias,
  name: toolName,
  description: '',
  integration: slug,
  connection: delegated ? { owner: 'user', integration: slug, name } : { owner: 'org', integration: slug, name },
  decision: 'allow',
  delegated,
  mode: 'disabled',
});

const listIssues = tool('org_github_default', 'list_issues');
const createIssue = tool('org_github_default', 'create_issue');
const userListIssues = tool('user_github_default', 'list_issues', true);

const integration: IntegrationView = {
  slug,
  name: 'GitHub',
  description: '',
  kind: 'mcp',
  displayUrl: endpoint,
  requiresAuthentication: true,
  authMethods: [],
  connections: [],
  tools: [],
};

const catalog = { integrations: [integration], tools: [listIssues, createIssue, userListIssues] };

describe('withToolMode', () => {
  it('creates a block for the tool connection on first grant', () => {
    expect(withToolMode({}, catalog, listIssues, 'native')).toEqual({
      github: { endpoint, connection: { owner: 'org', name }, tools: { list_issues: 'native' } },
    });
  });

  it('keys a user connection block apart from the org one', () => {
    const next = withToolMode(withToolMode({}, catalog, listIssues, 'native'), catalog, userListIssues, 'codemode');
    expect(Object.keys(next)).toEqual(['github', 'github-user']);
    expect(next['github-user']?.connection).toEqual({ owner: 'user', name });
  });

  it('expands * before removing one tool and drops an emptied block', () => {
    const start: AgentIntegrations = {
      github: { endpoint, connection: { owner: 'org', name }, tools: { '*': 'codemode' } },
    };
    const next = withToolMode(start, catalog, listIssues, 'disabled');
    expect(next).toEqual({
      github: { endpoint, connection: { owner: 'org', name }, tools: { create_issue: 'codemode' } },
    });
    expect(withToolMode(next, catalog, createIssue, 'disabled')).toEqual({});
  });
});

describe('withIntegrationChoice', () => {
  it('replaces every block of the integration with a wildcard on the chosen connections', () => {
    const start = withToolMode({}, catalog, userListIssues, 'native');
    expect(withIntegrationChoice(start, catalog, slug, 'org')).toEqual({
      github: { endpoint, connection: { owner: 'org', name }, tools: { '*': 'codemode' } },
    });
    expect(withIntegrationChoice(start, catalog, slug, 'off')).toEqual({});
  });
});
