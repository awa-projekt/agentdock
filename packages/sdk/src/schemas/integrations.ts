import * as Schema from 'effect/Schema';
import { Json } from './json';

/** `<alias>.<tool>`: the connection alias never contains a dot, so the first dot splits it. */
export const IntegrationToolId = Schema.String.pipe(Schema.brand('IntegrationToolId'));
export const IntegrationSlug = Schema.String.pipe(Schema.brand('IntegrationSlug'));
export const ConnectionName = Schema.String.pipe(Schema.brand('ConnectionName'));
export const ApprovalId = Schema.String.pipe(Schema.brand('ApprovalId'));

export const IntegrationKind = Schema.Literals(['mcp', 'openapi']);

/**
 * How an enabled tool reaches the agent. `native` puts the tool in the model's
 * own tool set and invokes it directly; `codemode` keeps it out of the tool set
 * and reachable only from inside an `executeTs` script.
 */
export const IntegrationToolMode = Schema.Literals(['native', 'codemode', 'disabled']);

/** Whether a tool runs immediately or freezes until a human approves the call. */
export const ToolDecision = Schema.Literals(['allow', 'require_approval']);

export const AuthPlacement = Schema.Struct({
  carrier: Schema.Literals(['header', 'query', 'env']),
  name: Schema.String,
  prefix: Schema.String,
});

export const AuthMethod = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(['oauth', 'apikey', 'header', 'none']),
  template: Schema.String,
  placements: Schema.optional(Schema.Array(AuthPlacement)),
  supportsDynamicRegistration: Schema.optional(Schema.Boolean),
});

export const ConnectionOwner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('org') }),
  Schema.Struct({ kind: Schema.Literal('user'), subject: Schema.String }),
]);

export const ConnectionView = Schema.Struct({
  owner: ConnectionOwner,
  integration: IntegrationSlug,
  name: ConnectionName,
  template: Schema.String,
  status: Schema.Literals(['connected', 'reauthorization_required']),
  identityLabel: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.Number),
  error: Schema.optional(Schema.String),
});

/** A connection as policy names it; a user connection without a subject stands for the calling user's own. */
export const ConnectionRef = Schema.Union([
  Schema.Struct({ owner: Schema.Literal('org'), integration: IntegrationSlug, name: ConnectionName }),
  Schema.Struct({
    owner: Schema.Literal('user'),
    subject: Schema.optional(Schema.String),
    integration: IntegrationSlug,
    name: ConnectionName,
  }),
]);

export const CatalogTool = Schema.Struct({
  id: IntegrationToolId,
  alias: Schema.String,
  name: Schema.String,
  description: Schema.String,
  integration: IntegrationSlug,
  connection: ConnectionRef,
  decision: ToolDecision,
  /** The tool runs on the calling user's own connection; invocations name a subject. */
  delegated: Schema.Boolean,
  inputSchema: Schema.optional(Json),
  outputSchema: Schema.optional(Json),
});

export const IntegrationView = Schema.Struct({
  slug: IntegrationSlug,
  name: Schema.String,
  description: Schema.String,
  kind: IntegrationKind,
  displayUrl: Schema.optional(Schema.String),
  requiresAuthentication: Schema.Boolean,
  authMethods: Schema.Array(AuthMethod),
  connections: Schema.Array(ConnectionView),
  tools: Schema.Array(CatalogTool),
  toolError: Schema.optional(Schema.String),
});

export const IntegrationsResponse = Schema.Struct({
  integrations: Schema.Array(IntegrationView),
  /** Every tool a workflow or an agent can be bound to, across all integrations. */
  tools: Schema.Array(CatalogTool),
});

export const DiscoverIntegrationInput = Schema.Struct({
  url: Schema.String,
  name: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
});

export const DiscoverIntegrationResponse = Schema.Struct({
  integration: IntegrationView,
});

export const IntegrationRegistryKind = Schema.Literals(['mcp', 'openapi', 'graphql', 'cli']);
export const InstallableIntegrationRegistryKind = Schema.Literals(['mcp', 'openapi']);

export const SearchIntegrationRegistryInput = Schema.Struct({
  query: Schema.String,
  kind: Schema.optional(InstallableIntegrationRegistryKind),
  limit: Schema.optional(Schema.Number),
});

export const IntegrationRegistrySurface = Schema.Struct({
  kind: InstallableIntegrationRegistryKind,
  slug: Schema.String,
  url: Schema.String,
  icon: Schema.optional(Schema.String),
  authKind: Schema.optional(Schema.String),
  authNote: Schema.optional(Schema.String),
});

export const IntegrationRegistryMatch = Schema.Struct({
  domain: Schema.String,
  name: Schema.String,
  description: Schema.String,
  kinds: Schema.Array(IntegrationRegistryKind),
  registryUrl: Schema.String,
  surfaces: Schema.Array(IntegrationRegistrySurface),
});

export const SearchIntegrationRegistryResponse = Schema.Struct({
  query: Schema.String,
  results: Schema.Array(IntegrationRegistryMatch),
});

export const RemoveIntegrationResponse = Schema.Struct({ removed: Schema.Boolean });

export const ConnectIntegrationInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  template: Schema.optional(Schema.String),
  values: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export const ConnectIntegrationResponse = Schema.Struct({
  connection: ConnectionView,
  tools: Schema.Array(CatalogTool),
});

export const StartOAuthConnectionInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  template: Schema.optional(Schema.String),
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
});

export const OAuthSessionState = Schema.Union([
  Schema.Struct({ status: Schema.Literal('pending'), authorizationUrl: Schema.String }),
  Schema.Struct({ status: Schema.Literal('connected'), connection: ConnectionView }),
  Schema.Struct({ status: Schema.Literal('failed'), message: Schema.String }),
  Schema.Struct({ status: Schema.Literal('needs-client'), guidance: Schema.String }),
]);

export const OAuthSessionView = Schema.Struct({
  id: Schema.String,
  integration: Schema.String,
  connection: Schema.String,
  state: OAuthSessionState,
});

export const ProvideOAuthClientInput = Schema.Struct({
  clientId: Schema.String,
  clientSecret: Schema.optional(Schema.String),
});

export const RemoveConnectionResponse = Schema.Struct({ removed: Schema.Boolean });

export const RefreshConnectionResponse = Schema.Struct({ tools: Schema.Array(CatalogTool) });

export const UserConnectionIntegration = Schema.Struct({
  slug: IntegrationSlug,
  name: Schema.String,
  description: Schema.String,
  kind: IntegrationKind,
  authMethods: Schema.Array(AuthMethod),
  connection: Schema.optional(ConnectionView),
  /** Some agent reaches this integration through the calling user's own connection. */
  offered: Schema.Boolean,
});

export const UserConnectionsResponse = Schema.Struct({
  integrations: Schema.Array(UserConnectionIntegration),
});

export const AgentToolView = Schema.Struct({
  ...CatalogTool.fields,
  mode: IntegrationToolMode,
});

/**
 * A declared integration or tool the catalog cannot serve right now, and why:
 * the endpoint is not registered, the named connection does not exist (an
 * OAuth one has to be authorised by a person), or the tool is not on the server.
 */
export const UnresolvedAgentTool = Schema.Struct({
  integration: Schema.String,
  tool: Schema.optional(Schema.String),
  reason: Schema.Literals(['unknown-endpoint', 'no-connection', 'oauth-required', 'unknown-tool']),
  slug: Schema.optional(IntegrationSlug),
  message: Schema.String,
});

export const AgentToolsResponse = Schema.Struct({
  tools: Schema.Array(AgentToolView),
  unresolved: Schema.Array(UnresolvedAgentTool),
});

export const UpdatedResponse = Schema.Struct({ updated: Schema.Boolean });

export const SetToolDecisionInput = Schema.Struct({ decision: ToolDecision });

/**
 * Points one MCP integration at another server for a single run, e.g. an eval
 * case's own server. The connection's stored credential is never sent there;
 * `bearerToken` is, as `Authorization: Bearer …`, when the server needs one.
 */
export const IntegrationEndpointOverride = Schema.Struct({
  endpoint: Schema.String,
  bearerToken: Schema.optional(Schema.String),
});

/** Integration slug → where the run reaches it instead of its registered endpoint. */
export const IntegrationOverrides = Schema.Record(Schema.String, IntegrationEndpointOverride);

/** Where a run's overrides travel: the metadata of the message that starts its A2A task. */
export const INTEGRATION_OVERRIDES_METADATA_KEY = 'agentdock/integrations';

export const ExecuteToolInput = Schema.Struct({
  toolId: IntegrationToolId,
  input: Json,
  integrations: Schema.optional(IntegrationOverrides),
});

export const InvocationOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal('succeeded'), result: Json }),
  Schema.Struct({ status: Schema.Literal('pending'), approvalId: ApprovalId, expiresAt: Schema.Number }),
  Schema.Struct({ status: Schema.Literal('denied'), reason: Schema.String }),
  Schema.Struct({ status: Schema.Literal('failed'), message: Schema.String }),
  Schema.Struct({
    status: Schema.Literal('invalid'),
    message: Schema.String,
    issues: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
  }),
  Schema.Struct({
    status: Schema.Literal('authorization-required'),
    integration: IntegrationSlug,
    connection: ConnectionName,
    subject: Schema.String,
    session: OAuthSessionView,
  }),
]);

export const ApprovalStatus = Schema.Literals(['pending', 'executing', 'approved', 'denied', 'expired']);

export const ApprovalPrincipal = Schema.Struct({
  kind: Schema.Literals(['agent', 'workflow', 'platform']),
  id: Schema.String,
  name: Schema.String,
});

export const ApprovalView = Schema.Struct({
  id: ApprovalId,
  principal: Schema.NullOr(ApprovalPrincipal),
  toolId: IntegrationToolId,
  alias: Schema.String,
  tool: Schema.String,
  arguments: Json,
  status: ApprovalStatus,
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
  decidedAt: Schema.NullOr(Schema.Number),
  decidedBy: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Json),
  error: Schema.NullOr(Schema.String),
});

export const ApprovalsResponse = Schema.Struct({ approvals: Schema.Array(ApprovalView) });

export const DecideApprovalResponse = Schema.Struct({ approval: ApprovalView });

export const AuditOutcome = Schema.Literals(['succeeded', 'failed', 'denied', 'pending']);

export const AuditRecordView = Schema.Struct({
  id: Schema.String,
  principal: Schema.NullOr(ApprovalPrincipal),
  toolId: Schema.NullOr(IntegrationToolId),
  subject: Schema.NullOr(Schema.String),
  decision: Schema.NullOr(ToolDecision),
  outcome: AuditOutcome,
  message: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
});

export const AuditResponse = Schema.Struct({
  records: Schema.Array(AuditRecordView),
  total: Schema.Number,
});

export const AuditQuery = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString),
  offset: Schema.optional(Schema.NumberFromString),
});

export class IntegrationOperationError extends Schema.TaggedError<IntegrationOperationError>()(
  'IntegrationOperationError',
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class IntegrationNotFoundError extends Schema.TaggedError<IntegrationNotFoundError>()(
  'IntegrationNotFoundError',
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/**
 * An integration's server could not be reached, not even after retries. A run
 * fails on it rather than continuing without the data.
 */
export class IntegrationUnreachableError extends Schema.TaggedError<IntegrationUnreachableError>()(
  'IntegrationUnreachableError',
  { message: Schema.String, integration: Schema.String, endpoint: Schema.String },
  { httpApiStatus: 502 },
) {}

export const integrationToolId = (alias: string, tool: string): IntegrationToolId =>
  IntegrationToolId.make(`${alias}.${tool}`);

export const splitIntegrationToolId = (toolId: string): { readonly alias: string; readonly tool: string } | null => {
  const dot = toolId.indexOf('.');
  if (dot <= 0 || dot === toolId.length - 1) return null;
  return { alias: toolId.slice(0, dot), tool: toolId.slice(dot + 1) };
};

export type IntegrationToolId = typeof IntegrationToolId.Type;
export type IntegrationSlug = typeof IntegrationSlug.Type;
export type ConnectionName = typeof ConnectionName.Type;
export type ApprovalId = typeof ApprovalId.Type;
export type IntegrationKind = typeof IntegrationKind.Type;
export type IntegrationToolMode = typeof IntegrationToolMode.Type;
export type ToolDecision = typeof ToolDecision.Type;
export type AuthMethod = typeof AuthMethod.Type;
export type ConnectionOwner = typeof ConnectionOwner.Type;
export type ConnectionView = typeof ConnectionView.Type;
export type ConnectionRef = typeof ConnectionRef.Type;
export type CatalogTool = typeof CatalogTool.Type;
export type IntegrationView = typeof IntegrationView.Type;
export type IntegrationsResponse = typeof IntegrationsResponse.Type;
export type DiscoverIntegrationInput = typeof DiscoverIntegrationInput.Type;
export type DiscoverIntegrationResponse = typeof DiscoverIntegrationResponse.Type;
export type IntegrationRegistryKind = typeof IntegrationRegistryKind.Type;
export type InstallableIntegrationRegistryKind = typeof InstallableIntegrationRegistryKind.Type;
export type SearchIntegrationRegistryInput = typeof SearchIntegrationRegistryInput.Type;
export type IntegrationRegistrySurface = typeof IntegrationRegistrySurface.Type;
export type IntegrationRegistryMatch = typeof IntegrationRegistryMatch.Type;
export type SearchIntegrationRegistryResponse = typeof SearchIntegrationRegistryResponse.Type;
export type ConnectIntegrationInput = typeof ConnectIntegrationInput.Type;
export type ConnectIntegrationResponse = typeof ConnectIntegrationResponse.Type;
export type StartOAuthConnectionInput = typeof StartOAuthConnectionInput.Type;
export type OAuthSessionState = typeof OAuthSessionState.Type;
export type OAuthSessionView = typeof OAuthSessionView.Type;
export type ProvideOAuthClientInput = typeof ProvideOAuthClientInput.Type;
export type UserConnectionIntegration = typeof UserConnectionIntegration.Type;
export type UserConnectionsResponse = typeof UserConnectionsResponse.Type;
export type AgentToolView = typeof AgentToolView.Type;
export type AgentToolsResponse = typeof AgentToolsResponse.Type;
export type UnresolvedAgentTool = typeof UnresolvedAgentTool.Type;
export type SetToolDecisionInput = typeof SetToolDecisionInput.Type;
export type IntegrationEndpointOverride = typeof IntegrationEndpointOverride.Type;
export type IntegrationOverrides = typeof IntegrationOverrides.Type;
export type ExecuteToolInput = typeof ExecuteToolInput.Type;
export type InvocationOutcome = typeof InvocationOutcome.Type;
export type ApprovalStatus = typeof ApprovalStatus.Type;
export type ApprovalPrincipal = typeof ApprovalPrincipal.Type;
export type ApprovalView = typeof ApprovalView.Type;
export type ApprovalsResponse = typeof ApprovalsResponse.Type;
export type AuditRecordView = typeof AuditRecordView.Type;
export type AuditResponse = typeof AuditResponse.Type;
