import {
  Alias,
  type ApprovalId,
  type AuditRecord,
  aliasForConnection,
  type Connection,
  ConnectionName,
  type ConnectionRef,
  connectionRefOf,
  type InvocationOutcome as GatewayOutcome,
  IntegrationSlug,
  isDelegationTemplate,
  NonNegativeInt,
  type PendingApproval,
  PositiveInt,
  SubjectId,
  type Tool,
  ToolName,
  userOwner,
  whenPresent,
} from '@integragents/contracts';
import {
  type ApprovalConflict,
  type ApprovalNotFound,
  approveApproval,
  defaultTenantId,
  denyApproval,
  forgetConnection,
  GatewayStoreService,
  type InvokeDependencies,
  invokeAsClient,
  OAuthFlowSessions,
  type OAuthSession,
  reconcileConfigurations,
  sameConnectionRef,
} from '@integragents/gateway-core';
import {
  AuthTemplateSlug,
  CatalogStore,
  type IntegrationServices,
  Integrations,
  listIntegrationOverviews,
  McpClient,
  provisionIntegration,
} from '@integragents/host';
import {
  type AgentIntegrations,
  AgentList,
  type AgentToolsResponse,
  type ApprovalView,
  type AuditRecordView,
  type CatalogTool,
  type ConnectionView,
  coerceJson,
  HOME_INTERNAL_AGENT_ID,
  INTERNAL_INTEGRATION_SLUG,
  IntegrationKind,
  type IntegrationOverrides,
  IntegrationUnreachableError,
  type IntegrationView,
  type InvocationOutcome,
  integrationToolId,
  isJsonObject,
  type Json,
  type JsonObject,
  type OAuthSessionView,
  ConnectionName as SdkConnectionName,
  type ConnectionRef as SdkConnectionRef,
  IntegrationSlug as SdkIntegrationSlug,
  splitIntegrationToolId,
  type ToolDecision,
  type UserConnectionIntegration,
} from 'agentdock-sdk/schemas';
import { Database } from 'db';
import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import type * as Crypto from 'effect/Crypto';
import * as Effect from 'effect/Effect';
import type * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Ref from 'effect/Ref';
import * as Schema from 'effect/Schema';
import { INTERNAL_AGENTS } from '../agents/internal-agents.config';
import { ServerConfig } from '../config';
import { createAgentRepo } from '../db/agents-repo';
import { ChangeFeed, ChangeFeedLive } from '../events/service';
import { findIntegrationByEndpoint, resolveAgentTools, resolveEndpoint, selectAuthMethod } from './agent-tools';
import {
  asIntegrationFailure,
  asInvocationFailure,
  type IntegrationFailure,
  type InvocationFailure,
  notFound,
  operationError,
} from './errors';
import { createPrincipals, type Principal, type PrincipalClient, platformPrincipal } from './principals';
import { IntegrationCallScope, openIntegrationCallScope, runScopedIntegrations } from './run-scoped-integrations';

const tenantId = defaultTenantId;
const argumentRetentionDays = 30;
const defaultConnectionName = ConnectionName.make('default');

export type ConnectionOwnerInput = { readonly kind: 'org' } | { readonly kind: 'user'; readonly subject: string };

export type InvokeToolInput = {
  readonly toolId: string;
  readonly input: Json;
  readonly subject?: string | undefined;
  /** Integrations the calling run reaches somewhere else than registered. */
  readonly integrations?: IntegrationOverrides | undefined;
};

export type ApprovalDecision = 'accept' | 'decline';

export type IntegrationCatalogService = {
  readonly listIntegrations: () => Effect.Effect<
    { readonly integrations: ReadonlyArray<IntegrationView>; readonly tools: ReadonlyArray<CatalogTool> },
    IntegrationFailure
  >;
  readonly discoverIntegration: (input: {
    readonly url: string;
    readonly name?: string | undefined;
    readonly slug?: string | undefined;
  }) => Effect.Effect<IntegrationView, IntegrationFailure>;
  readonly removeIntegration: (slug: string) => Effect.Effect<void, IntegrationFailure>;
  readonly connect: (
    slug: string,
    owner: ConnectionOwnerInput,
    input: {
      readonly name?: string | undefined;
      readonly template?: string | undefined;
      readonly values?: Readonly<Record<string, string>> | undefined;
    },
  ) => Effect.Effect<
    { readonly connection: ConnectionView; readonly tools: ReadonlyArray<CatalogTool> },
    IntegrationFailure
  >;
  readonly startOAuth: (
    slug: string,
    owner: ConnectionOwnerInput,
    input: {
      readonly name?: string | undefined;
      readonly template?: string | undefined;
      readonly clientId?: string | undefined;
      readonly clientSecret?: string | undefined;
    },
  ) => Effect.Effect<OAuthSessionView, IntegrationFailure>;
  readonly getOAuthSession: (id: string) => Effect.Effect<OAuthSessionView, IntegrationFailure>;
  readonly provideOAuthClient: (
    id: string,
    input: { readonly clientId: string; readonly clientSecret?: string | undefined },
  ) => Effect.Effect<OAuthSessionView, IntegrationFailure>;
  readonly removeConnection: (
    slug: string,
    name: string,
    owner: ConnectionOwnerInput,
  ) => Effect.Effect<void, IntegrationFailure>;
  readonly refreshConnection: (
    slug: string,
    name: string,
  ) => Effect.Effect<ReadonlyArray<CatalogTool>, IntegrationFailure>;
  readonly listUserConnections: (
    subject: string,
  ) => Effect.Effect<ReadonlyArray<UserConnectionIntegration>, IntegrationFailure>;
  /** Every catalog tool with the mode the agent's config gives it, plus the declarations the catalog cannot honour. */
  readonly listAgentTools: (agentId: string) => Effect.Effect<AgentToolsResponse, IntegrationFailure>;
  /**
   * Registers the integrations an agent declares that are not registered yet
   * and opens the org connections it names where that needs no person: a
   * key from the server environment, or no auth at all. OAuth connections are
   * left for the dashboard and show up as unresolved.
   */
  readonly provisionAgentIntegrations: (integrations: AgentIntegrations) => Effect.Effect<void, IntegrationFailure>;
  /** Projects the agent's config onto its gateway access profile, which is what invocation checks. */
  readonly syncAgentGrants: (agentId: string) => Effect.Effect<void, IntegrationFailure>;
  readonly forgetAgent: (agentId: string) => Effect.Effect<void, IntegrationFailure>;
  readonly setToolDecision: (toolId: string, decision: ToolDecision) => Effect.Effect<void, IntegrationFailure>;
  readonly ensurePrincipal: (principal: Principal) => Effect.Effect<PrincipalClient, IntegrationFailure>;
  /**
   * Fails with {@link IntegrationUnreachableError} when the tool's server stays
   * out of reach through its retries; a run should end on it.
   */
  readonly invoke: (
    principal: Principal,
    input: InvokeToolInput,
  ) => Effect.Effect<InvocationOutcome, InvocationFailure>;
  readonly listApprovals: (
    status?: PendingApproval['status'] | undefined,
  ) => Effect.Effect<ReadonlyArray<ApprovalView>, IntegrationFailure>;
  readonly getApproval: (id: ApprovalId) => Effect.Effect<ApprovalView, IntegrationFailure>;
  /** Records a decision once; a call that is no longer pending is returned as it stands. */
  readonly decideApproval: (
    id: ApprovalId,
    action: ApprovalDecision,
    decidedBy: string,
  ) => Effect.Effect<ApprovalView, IntegrationFailure>;
  readonly listAudit: (query: {
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
  }) => Effect.Effect<{ readonly records: ReadonlyArray<AuditRecordView>; readonly total: number }, IntegrationFailure>;
};

export const IntegrationCatalog = Context.Service<IntegrationCatalogService>('@agentdock/api/IntegrationCatalog');

const decodeSlug = Schema.decodeUnknownOption(IntegrationSlug);
const decodeConnectionName = Schema.decodeUnknownOption(ConnectionName);
const decodeAlias = Schema.decodeUnknownOption(Alias);
const decodeSubject = Schema.decodeUnknownOption(SubjectId);
const decodeKind = Schema.decodeUnknownOption(IntegrationKind);
const decodePositiveInt = Schema.decodeUnknownSync(PositiveInt);
const decodeNonNegativeInt = Schema.decodeUnknownSync(NonNegativeInt);

const requireSlug = (value: string) =>
  Option.match(decodeSlug(value), {
    onNone: () => Effect.fail(notFound(`Unknown integration ${value}`)),
    onSome: Effect.succeed,
  });

const requireConnectionName = (value: string) =>
  Option.match(decodeConnectionName(value), {
    onNone: () => Effect.fail(notFound(`Unknown connection ${value}`)),
    onSome: Effect.succeed,
  });

const requireSubject = (value: string) =>
  Option.match(decodeSubject(value), {
    onNone: () => Effect.fail(operationError(`User id ${value} cannot name a gateway subject`)),
    onSome: Effect.succeed,
  });

const ownerOf = (owner: ConnectionOwnerInput) =>
  owner.kind === 'org' ? Effect.succeed('org' as const) : Effect.map(requireSubject(owner.subject), userOwner);

const sdkSlug = (slug: string) => SdkIntegrationSlug.make(slug);
const sdkConnectionName = (name: string) => SdkConnectionName.make(name);

const sdkConnectionRef = (connection: ConnectionRef): SdkConnectionRef =>
  connection.owner === 'org'
    ? { owner: 'org', integration: sdkSlug(connection.integration), name: sdkConnectionName(connection.name) }
    : {
        owner: 'user',
        ...whenPresent('subject', connection.subject),
        integration: sdkSlug(connection.integration),
        name: sdkConnectionName(connection.name),
      };

const gatewayConnectionRef = (connection: SdkConnectionRef): ConnectionRef =>
  connection.owner === 'org'
    ? {
        owner: 'org',
        integration: IntegrationSlug.make(connection.integration),
        name: ConnectionName.make(connection.name),
      }
    : {
        owner: 'user',
        ...whenPresent('subject', connection.subject === undefined ? undefined : SubjectId.make(connection.subject)),
        integration: IntegrationSlug.make(connection.integration),
        name: ConnectionName.make(connection.name),
      };

const userOwnerPrefix = 'user:';

const connectionView = (connection: Connection): ConnectionView => ({
  owner:
    connection.owner === 'org'
      ? { kind: 'org' }
      : { kind: 'user', subject: connection.owner.slice(userOwnerPrefix.length) },
  integration: sdkSlug(connection.integration),
  name: sdkConnectionName(connection.name),
  template: connection.template,
  status: connection.status,
  identityLabel: connection.identityLabel ?? null,
  expiresAt: connection.expiresAt ?? null,
  ...whenPresent('error', connection.error),
});

const oauthSessionView = (session: OAuthSession): OAuthSessionView => ({
  id: session.id,
  integration: session.integration,
  connection: session.connection,
  state:
    session.state.status === 'connected'
      ? { status: 'connected', connection: connectionView(session.state.connection) }
      : session.state.status === 'needs-client'
        ? { status: 'needs-client', guidance: session.state.guidance }
        : session.state,
});

// The catalog keeps a tool's shared `$defs` apart from its schema; the UI and
// the model need them inlined so `$ref`s resolve.
const inlineSchemaDefs = (schema: Json | undefined, defs: JsonObject | undefined): Json | undefined => {
  if (schema === undefined || defs === undefined || Object.keys(defs).length === 0 || !isJsonObject(schema)) {
    return schema;
  }
  const existing = schema.$defs;
  return { ...schema, $defs: isJsonObject(existing) ? { ...defs, ...existing } : defs };
};

const catalogTool = (
  connection: ConnectionRef,
  tool: Pick<Tool, 'name' | 'description' | 'defaultDecision' | 'inputSchema' | 'outputSchema' | 'schemaDefinitions'>,
  decisions: ReadonlyMap<string, ToolDecision>,
): CatalogTool => {
  const alias = aliasForConnection(connection);
  const id = integrationToolId(alias, tool.name);
  const defs = tool.schemaDefinitions === undefined ? undefined : coerceJson(tool.schemaDefinitions);
  const inputSchema = inlineSchemaDefs(
    tool.inputSchema === undefined ? undefined : coerceJson(tool.inputSchema),
    isJsonObject(defs) ? defs : undefined,
  );
  const outputSchema = inlineSchemaDefs(
    tool.outputSchema === undefined ? undefined : coerceJson(tool.outputSchema),
    isJsonObject(defs) ? defs : undefined,
  );
  return {
    id,
    alias,
    name: tool.name,
    description: tool.description,
    integration: sdkSlug(connection.integration),
    connection: sdkConnectionRef(connection),
    decision: decisions.get(id) ?? tool.defaultDecision,
    delegated: isDelegationTemplate(connection),
    ...whenPresent('inputSchema', inputSchema),
    ...whenPresent('outputSchema', outputSchema),
  };
};

type Catalog = {
  readonly integrations: ReadonlyArray<IntegrationView>;
  /** Tools reachable through the organisation's connections, bindable by workflows. */
  readonly orgTools: ReadonlyArray<CatalogTool>;
  /** One tool per integration and tool name, reached through the calling user's own connection. */
  readonly templateTools: ReadonlyArray<CatalogTool>;
  readonly offered: ReadonlySet<string>;
};

const outcomeView = (outcome: GatewayOutcome): InvocationOutcome => {
  switch (outcome.status) {
    case 'succeeded':
      return { status: 'succeeded', result: coerceJson(outcome.result) };
    case 'pending':
      return { status: 'pending', approvalId: outcome.approvalId, expiresAt: outcome.expiresAt.getTime() };
    case 'denied':
      return outcome;
    case 'failed':
      return outcome;
    case 'invalid':
      return outcome;
    case 'authorization-required':
      return {
        status: 'authorization-required',
        integration: sdkSlug(outcome.integration),
        connection: sdkConnectionName(outcome.connection),
        subject: outcome.subject,
        session: {
          id: outcome.session.id,
          integration: outcome.session.integration,
          connection: outcome.session.connection,
          state:
            outcome.session.state.status === 'connected'
              ? { status: 'connected', connection: connectionView(outcome.session.state.connection) }
              : outcome.session.state.status === 'needs-client'
                ? { status: 'needs-client', guidance: outcome.session.state.guidance }
                : outcome.session.state,
        },
      };
  }
};

const approvalView = (approval: PendingApproval, principals: ReadonlyMap<string, Principal>): ApprovalView => ({
  id: approval.id,
  principal: principals.get(approval.clientId) ?? null,
  toolId: integrationToolId(approval.alias, approval.tool),
  alias: approval.alias,
  tool: approval.tool,
  arguments: coerceJson(approval.arguments),
  status: approval.status,
  createdAt: approval.createdAt.getTime(),
  expiresAt: approval.expiresAt.getTime(),
  decidedAt: approval.decidedAt?.getTime() ?? null,
  decidedBy: approval.decidedBy,
  result: approval.result === null ? null : coerceJson(approval.result),
  error: approval.error,
});

const auditView = (record: AuditRecord, principals: ReadonlyMap<string, Principal>): AuditRecordView => ({
  id: record.id,
  principal: record.clientId === null ? null : (principals.get(record.clientId) ?? null),
  toolId: record.alias === null || record.tool === null ? null : integrationToolId(record.alias, record.tool),
  subject: record.subject,
  decision: record.decision,
  outcome: record.outcome,
  message: record.message,
  createdAt: record.createdAt.getTime(),
});

type Grant = { readonly connection: ConnectionRef; readonly tool: ToolName };

const decodeAgentList = Schema.decodeUnknownSync(AgentList);

/** A single `token` value is the template's one secret; anything else is passed by name. */
const connectionValues = (values: Readonly<Record<string, string>>) => {
  const keys = Object.keys(values);
  const token = values.token;
  return keys.length === 0 ? { value: '' } : keys.length === 1 && token !== undefined ? { value: token } : { values };
};

const grantKey = (connection: ConnectionRef, tool: string): string =>
  integrationToolId(aliasForConnection(connection), tool);

export const IntegrationCatalogLive = Layer.effect(
  IntegrationCatalog,
  Effect.gen(function* () {
    const { db } = yield* Database;
    const server = yield* ServerConfig;
    const agentdockUrl = new URL(server.internalMcpEndpoint).origin;
    const store = yield* GatewayStoreService;
    const host = yield* Integrations;
    const oauth = yield* OAuthFlowSessions;
    const hostContext = yield* Effect.context<IntegrationServices>();
    const runtimeContext = yield* Effect.context<Crypto.Crypto | HttpClient.HttpClient>();
    const principals = createPrincipals(db, store);
    const changes = yield* ChangeFeed;
    const touchesIntegrations = changes.touches('integrations');
    const touchesApprovals = changes.touches('approvals', 'audit');

    // Every execution goes through the invocation's run scope: endpoint
    // overrides, retries of unreachable servers, and their report.
    const integrations = runScopedIntegrations({
      host,
      store: Context.get(hostContext, CatalogStore),
      mcp: Context.get(hostContext, McpClient),
    });
    const invokeDependencies: InvokeDependencies = { store, integrations, oauth, argumentRetentionDays };

    const reconcile = reconcileConfigurations({ store, integrations: host, tenantId });

    const decisionMap = Effect.fn('IntegrationCatalog.decisions')(function* () {
      const policy = yield* store.findDefaultApprovalPolicy(tenantId);
      const tools = policy === undefined ? [] : yield* store.listApprovalPolicyTools(policy.id);
      return new Map<string, ToolDecision>(tools.map((tool) => [grantKey(tool.connection, tool.tool), tool.decision]));
    });

    /** Whether a run's overrides point the tool's integration elsewhere. */
    const overridesTool = Effect.fn('IntegrationCatalog.overridesTool')(function* (
      toolId: string,
      overrides: IntegrationOverrides | undefined,
    ) {
      if (overrides === undefined || Object.keys(overrides).length === 0) return false;
      const full = yield* catalog();
      const tool = [...full.orgTools, ...full.templateTools].find((candidate) => candidate.id === toolId);
      return tool !== undefined && overrides[tool.integration] !== undefined;
    });

    const offeredIntegrations = Effect.fn('IntegrationCatalog.offered')(function* () {
      const profiles = yield* store.listAccessProfiles(tenantId);
      const grants = yield* Effect.forEach(profiles, (profile) => store.listAccessProfileTools(profile.id));
      return new Set(
        grants
          .flat()
          .flatMap((grant) => (isDelegationTemplate(grant.connection) ? [String(grant.connection.integration)] : [])),
      );
    });

    const catalog = Effect.fn('IntegrationCatalog.catalog')(function* (): Effect.fn.Return<Catalog, Error> {
      const [overviews, decisions, offered] = yield* Effect.all([
        listIntegrationOverviews().pipe(Effect.provide(hostContext)),
        decisionMap(),
        offeredIntegrations(),
      ]);
      const orgTools: Array<CatalogTool> = [];
      const templateTools: Array<CatalogTool> = [];
      const integrations = overviews.map((overview): IntegrationView => {
        const own = overview.tools
          .filter((tool) => tool.owner === 'org')
          .map((tool) =>
            catalogTool(
              connectionRefOf('org', IntegrationSlug.make(overview.slug), ConnectionName.make(tool.connection)),
              tool,
              decisions,
            ),
          );
        orgTools.push(...own);
        const template: ConnectionRef = {
          owner: 'user',
          integration: IntegrationSlug.make(overview.slug),
          name: defaultConnectionName,
        };
        const seen = new Set<string>();
        for (const tool of overview.tools) {
          if (seen.has(tool.name)) continue;
          seen.add(tool.name);
          templateTools.push(catalogTool(template, tool, decisions));
        }
        return {
          slug: sdkSlug(overview.slug),
          name: overview.name,
          description: overview.description,
          kind: Option.getOrElse(decodeKind(overview.kind), () => 'openapi' as const),
          ...whenPresent('displayUrl', overview.displayUrl),
          requiresAuthentication: overview.requiresAuthentication,
          authMethods: overview.authMethods.map((method) => ({
            id: method.id,
            label: method.label,
            kind: method.kind,
            template: method.template,
            ...whenPresent(
              'placements',
              method.placements?.map((placement) => ({
                carrier: placement.carrier,
                name: placement.name,
                prefix: placement.prefix,
              })),
            ),
            ...whenPresent('supportsDynamicRegistration', method.oauth?.supportsDynamicRegistration),
          })),
          connections: overview.connections.map(connectionView),
          tools: own,
          ...whenPresent('toolError', overview.toolError),
        };
      });
      return { integrations, orgTools, templateTools, offered };
    });

    const visibleCatalog = Effect.fn('IntegrationCatalog.visible')(function* () {
      const full = yield* catalog();
      const hidden = (slug: string) => slug === INTERNAL_INTEGRATION_SLUG;
      return {
        ...full,
        integrations: full.integrations.filter((integration) => !hidden(integration.slug)),
        orgTools: full.orgTools.filter((tool) => !hidden(tool.integration)),
        templateTools: full.templateTools.filter((tool) => !hidden(tool.integration)),
      };
    });

    const integrationView = Effect.fn('IntegrationCatalog.integrationView')(function* (slug: IntegrationSlug) {
      const full = yield* catalog();
      const found = full.integrations.find((integration) => integration.slug === slug);
      if (found === undefined) return yield* notFound(`Unknown integration ${slug}`);
      return found;
    });

    const requireIntegration = Effect.fn('IntegrationCatalog.requireIntegration')(function* (value: string) {
      const slug = yield* requireSlug(value);
      const found = yield* host.findIntegration(slug);
      if (Option.isNone(found)) return yield* notFound(`Unknown integration ${value}`);
      return found.value;
    });

    const toolsOfConnection = Effect.fn('IntegrationCatalog.toolsOfConnection')(function* (
      slug: IntegrationSlug,
      owner: Connection['owner'],
      name: ConnectionName,
    ) {
      const [tools, decisions] = yield* Effect.all([
        host.listTools({ integration: slug, owner, connection: name }),
        decisionMap(),
      ]);
      const connection = connectionRefOf(owner, slug, name);
      return tools.map((tool) => catalogTool(connection, tool, decisions));
    });

    const agentRepo = createAgentRepo(db, operationError);
    const internalAgents = decodeAgentList(INTERNAL_AGENTS);

    const agentIntegrations = Effect.fn('IntegrationCatalog.agentIntegrations')(function* (agentId: string) {
      const internal = internalAgents.find((agent) => agent.id === agentId);
      if (internal !== undefined) return internal.integrations;
      const agent = yield* agentRepo.getPublicAgentById(agentId);
      if (agent === null) return yield* notFound(`Unknown agent ${agentId}`);
      return agent.integrations;
    });

    const resolveAgent = Effect.fn('IntegrationCatalog.resolveAgent')(function* (
      agentId: string,
      integrations: AgentIntegrations,
    ) {
      const full = yield* agentId === HOME_INTERNAL_AGENT_ID ? catalog() : visibleCatalog();
      return resolveAgentTools({
        integrations,
        catalog: { integrations: full.integrations, tools: [...full.orgTools, ...full.templateTools] },
        agentdockUrl,
      });
    });

    const replaceGrants = Effect.fn('IntegrationCatalog.replaceGrants')(function* (
      principal: PrincipalClient,
      grants: ReadonlyArray<Grant>,
    ) {
      yield* store.replaceAccessProfileTools(principal.accessProfileId, grants);
      yield* reconcile;
    });

    const syncAgent = Effect.fn('IntegrationCatalog.syncAgent')(function* (
      agentId: string,
      integrations: AgentIntegrations,
    ) {
      const principal = yield* principals
        .ensure({ kind: 'agent', id: agentId, name: agentId })
        .pipe(Effect.provide(runtimeContext));
      const resolved = yield* resolveAgent(agentId, integrations);
      yield* replaceGrants(principal, resolved.tools.filter((tool) => tool.mode !== 'disabled').map(grantOf));
    });

    const syncAllAgents = Effect.fn('IntegrationCatalog.syncAllAgents')(function* () {
      const agents = [...internalAgents, ...(yield* agentRepo.listPublicAgents())];
      yield* Effect.forEach(agents, (agent) => syncAgent(agent.id, agent.integrations), { discard: true });
    });

    const secretValues = Effect.fn('IntegrationCatalog.secretValues')(function* (
      key: string,
      secrets: Readonly<Record<string, string>>,
    ) {
      const entries = yield* Effect.forEach(Object.entries(secrets), ([name, variable]) =>
        Config.String(variable).pipe(
          Effect.mapError(() => operationError(`${key}: environment variable ${variable} is not set on the server`)),
          Effect.map((value) => [name, value] as const),
        ),
      );
      return Object.fromEntries(entries);
    });

    const provisionBlock = Effect.fn('IntegrationCatalog.provisionBlock')(function* (
      key: string,
      block: AgentIntegrations[string],
    ) {
      const endpoint = resolveEndpoint(block.endpoint, agentdockUrl);
      const registered = findIntegrationByEndpoint(yield* host.listIntegrations(), endpoint);
      const integration =
        registered ?? (yield* provisionIntegration(endpoint).pipe(Effect.provide(hostContext))).integration;
      if (block.connection.owner === 'user') return;
      const name = ConnectionName.make(block.connection.name);
      const connections = yield* host.listConnections({ integration: integration.slug, owner: 'org' });
      if (connections.some((connection) => connection.name === name)) return;
      const method = selectAuthMethod(integration.authMethods, block.auth?.template);
      if (method === undefined) {
        return yield* operationError(
          `${key}: ${integration.slug} offers no auth template "${block.auth?.template}". Available: ${integration.authMethods
            .map((candidate) => candidate.template)
            .join(', ')}`,
        );
      }
      if (method.kind === 'oauth') return;
      const values = yield* secretValues(key, block.auth?.secrets ?? {});
      if (method.kind !== 'none' && Object.keys(values).length === 0) return;
      yield* host.createConnection({
        owner: 'org',
        integration: integration.slug,
        name,
        template: AuthTemplateSlug.make(method.template),
        ...connectionValues(values),
      });
    });

    const grantOf = (tool: CatalogTool) => ({
      connection: gatewayConnectionRef(tool.connection),
      tool: ToolName.make(tool.name),
    });

    const service: IntegrationCatalogService = {
      listIntegrations: Effect.fn('IntegrationCatalog.listIntegrations')(function* () {
        const full = yield* catalog();
        return { integrations: full.integrations, tools: full.orgTools };
      }, asIntegrationFailure),

      discoverIntegration: Effect.fn('IntegrationCatalog.discoverIntegration')(
        function* (input) {
          const discovery = yield* provisionIntegration(input.url, {
            ...whenPresent('name', input.name),
            ...whenPresent('slug', input.slug),
          }).pipe(Effect.provide(hostContext));
          yield* reconcile;
          yield* syncAllAgents();
          return yield* integrationView(discovery.integration.slug);
        },
        asIntegrationFailure,
        touchesIntegrations,
      ),

      removeIntegration: Effect.fn('IntegrationCatalog.removeIntegration')(
        function* (value) {
          const integration = yield* requireIntegration(value);
          const connections = yield* host.listConnections({ integration: integration.slug });
          yield* Effect.forEach(
            connections,
            (connection) =>
              forgetConnection({
                store,
                tenantId,
                connection: connectionRefOf(connection.owner, integration.slug, connection.name),
              }),
            { discard: true },
          );
          yield* host.removeIntegration(integration.slug);
          yield* reconcile;
          yield* syncAllAgents();
        },
        asIntegrationFailure,
        touchesIntegrations,
      ),

      connect: Effect.fn('IntegrationCatalog.connect')(
        function* (value, ownerInput, input) {
          const integration = yield* requireIntegration(value);
          const owner = yield* ownerOf(ownerInput);
          const method = selectAuthMethod(integration.authMethods, input.template);
          if (method === undefined) {
            return yield* operationError(
              `${integration.slug} offers no auth template "${input.template}". Available: ${integration.authMethods
                .map((candidate) => candidate.template)
                .join(', ')}`,
            );
          }
          if (method.kind === 'oauth')
            return yield* operationError(`${integration.slug} uses OAuth; start an OAuth connection`);
          const name = yield* requireConnectionName(input.name ?? 'default');
          const connection = yield* host.createConnection({
            owner,
            integration: integration.slug,
            name,
            template: AuthTemplateSlug.make(method.template),
            ...connectionValues(input.values ?? {}),
          });
          yield* reconcile;
          yield* syncAllAgents();
          const tools = yield* toolsOfConnection(integration.slug, owner, name);
          return { connection: connectionView(connection), tools };
        },
        asIntegrationFailure,
        touchesIntegrations,
      ),

      startOAuth: Effect.fn('IntegrationCatalog.startOAuth')(function* (value, ownerInput, input) {
        const integration = yield* requireIntegration(value);
        const method = integration.authMethods.find((candidate) =>
          input.template === undefined
            ? candidate.kind === 'oauth'
            : candidate.template === input.template || candidate.id === input.template,
        );
        if (method === undefined || method.kind !== 'oauth') {
          return yield* operationError(`${integration.slug} has no OAuth auth method`);
        }
        const subject = ownerInput.kind === 'user' ? yield* requireSubject(ownerInput.subject) : undefined;
        if (subject !== undefined && (yield* store.findSubjectById(subject)) === undefined) {
          yield* store.createSubject({ id: subject, tenantId });
        }
        const session = yield* oauth.start({
          integration: integration.slug,
          connection: input.name ?? 'default',
          authMethod: method,
          bindingTenant: tenantId,
          ...whenPresent('subject', subject),
          ...whenPresent('clientId', input.clientId),
          ...whenPresent('clientSecret', input.clientSecret),
        });
        return oauthSessionView(session);
      }, asIntegrationFailure),

      getOAuthSession: Effect.fn('IntegrationCatalog.getOAuthSession')(function* (id) {
        const session = yield* oauth.get(id);
        if (session === undefined) return yield* notFound('Unknown or expired OAuth session');
        return oauthSessionView(session);
      }, asIntegrationFailure),

      provideOAuthClient: Effect.fn('IntegrationCatalog.provideOAuthClient')(function* (id, input) {
        const secret = input.clientSecret?.trim();
        const session = yield* oauth.provideClient(id, {
          clientId: input.clientId.trim(),
          ...whenPresent('clientSecret', secret === undefined || secret.length === 0 ? undefined : secret),
        });
        if (session === undefined)
          return yield* notFound('Unknown OAuth session, or it is no longer waiting for a client');
        return oauthSessionView(session);
      }, asIntegrationFailure),

      removeConnection: Effect.fn('IntegrationCatalog.removeConnection')(
        function* (value, nameValue, ownerInput) {
          const integration = yield* requireIntegration(value);
          const owner = yield* ownerOf(ownerInput);
          const name = yield* requireConnectionName(nameValue);
          const existing = yield* host.listConnections({ integration: integration.slug, owner });
          if (!existing.some((connection) => connection.name === name)) {
            return yield* notFound(`${integration.slug} has no connection ${name}`);
          }
          yield* host.removeConnection({ owner, integration: integration.slug, name });
          yield* forgetConnection({ store, tenantId, connection: connectionRefOf(owner, integration.slug, name) });
          yield* reconcile;
          yield* syncAllAgents();
        },
        asIntegrationFailure,
        touchesIntegrations,
      ),

      refreshConnection: Effect.fn('IntegrationCatalog.refreshConnection')(
        function* (value, nameValue) {
          const integration = yield* requireIntegration(value);
          const name = yield* requireConnectionName(nameValue);
          yield* host.refreshConnection({ owner: 'org', integration: integration.slug, name });
          yield* reconcile;
          yield* syncAllAgents();
          return yield* toolsOfConnection(integration.slug, 'org', name);
        },
        asIntegrationFailure,
        touchesIntegrations,
      ),

      listUserConnections: Effect.fn('IntegrationCatalog.listUserConnections')(function* (subjectValue) {
        const subject = yield* requireSubject(subjectValue);
        const [visible, held] = yield* Effect.all([
          visibleCatalog(),
          host.listConnections({ owner: userOwner(subject) }),
        ]);
        return visible.integrations.map((integration): UserConnectionIntegration => {
          const connection = held.find((candidate) => candidate.integration === integration.slug);
          return {
            slug: integration.slug,
            name: integration.name,
            description: integration.description,
            kind: integration.kind,
            authMethods: integration.authMethods,
            ...whenPresent('connection', connection === undefined ? undefined : connectionView(connection)),
            offered: visible.offered.has(integration.slug),
          };
        });
      }, asIntegrationFailure),

      listAgentTools: Effect.fn('IntegrationCatalog.listAgentTools')(function* (agentId) {
        return yield* resolveAgent(agentId, yield* agentIntegrations(agentId));
      }, asIntegrationFailure),

      provisionAgentIntegrations: Effect.fn('IntegrationCatalog.provisionAgentIntegrations')(
        function* (integrations) {
          const blocks = Object.entries(integrations);
          if (blocks.length === 0) return;
          yield* Effect.forEach(blocks, ([key, block]) => provisionBlock(key, block), { discard: true });
          yield* reconcile;
        },
        asIntegrationFailure,
        touchesIntegrations,
      ),

      syncAgentGrants: Effect.fn('IntegrationCatalog.syncAgentGrants')(
        function* (agentId) {
          yield* syncAgent(agentId, yield* agentIntegrations(agentId));
        },
        asIntegrationFailure,
        touchesIntegrations,
      ),

      forgetAgent: Effect.fn('IntegrationCatalog.forgetAgent')(
        function* (agentId) {
          const principal = yield* principals
            .ensure({ kind: 'agent', id: agentId, name: agentId })
            .pipe(Effect.provide(runtimeContext));
          yield* replaceGrants(principal, []);
        },
        asIntegrationFailure,
        touchesIntegrations,
      ),

      setToolDecision: Effect.fn('IntegrationCatalog.setToolDecision')(
        function* (toolId, decision) {
          const full = yield* catalog();
          const tool = [...full.orgTools, ...full.templateTools].find((candidate) => candidate.id === toolId);
          if (tool === undefined) return yield* notFound(`Unknown tool ${toolId}`);
          const policy = yield* store.findDefaultApprovalPolicy(tenantId);
          if (policy === undefined) return yield* operationError('The gateway tenant has no default approval policy');
          const grant = grantOf(tool);
          const existing = yield* store.listApprovalPolicyTools(policy.id);
          const others = existing.filter(
            (entry) => !(entry.tool === grant.tool && sameConnectionRef(entry.connection, grant.connection)),
          );
          yield* store.replaceApprovalPolicyTools(policy.id, [...others, { ...grant, decision }]);
        },
        asIntegrationFailure,
        touchesIntegrations,
      ),

      ensurePrincipal: (principal) =>
        principals.ensure(principal).pipe(Effect.provide(runtimeContext), asIntegrationFailure),

      invoke: Effect.fn('IntegrationCatalog.invoke')(
        function* (principal, input) {
          const parts = splitIntegrationToolId(input.toolId);
          const alias = parts === null ? Option.none() : decodeAlias(parts.alias);
          if (parts === null || Option.isNone(alias)) return yield* notFound(`Unknown tool ${input.toolId}`);
          const { client } = yield* principals.ensure(principal).pipe(Effect.provide(runtimeContext));
          const subject = input.subject === undefined ? undefined : yield* requireSubject(input.subject);
          if (subject !== undefined && (yield* store.findSubjectById(subject)) === undefined) {
            yield* store.createSubject({ id: subject, tenantId });
          }
          const scope = yield* openIntegrationCallScope(input.integrations);
          const outcome = yield* invokeAsClient(invokeDependencies, {
            client,
            alias: alias.value,
            tool: ToolName.make(parts.tool),
            arguments: input.input,
            ...whenPresent('subject', subject),
          }).pipe(Effect.provide(runtimeContext), Effect.provideService(IntegrationCallScope, scope));
          if (outcome.status === 'failed') {
            const unreachable = yield* Ref.get(scope.unreachable);
            if (Option.isSome(unreachable)) {
              return yield* new IntegrationUnreachableError({
                message: `${unreachable.value.integration} could not be reached at ${unreachable.value.endpoint}: ${unreachable.value.detail}`,
                integration: unreachable.value.integration,
                endpoint: unreachable.value.endpoint,
              });
            }
          }
          if (outcome.status === 'pending' && (yield* overridesTool(input.toolId, input.integrations))) {
            // An approved call runs later, outside this run, against the
            // registered endpoint; a run pointed elsewhere cannot wait for one.
            yield* denyApproval(store, { tenantId, id: outcome.approvalId, decidedBy: 'agentdock:endpoint-override' });
            return {
              status: 'denied',
              reason: `${input.toolId} needs approval, and approvals do not follow a run's endpoint override. Allow the tool, or run without the override.`,
            } satisfies InvocationOutcome;
          }
          return outcomeView(outcome);
        },
        asInvocationFailure,
        touchesApprovals,
      ),

      listApprovals: Effect.fn('IntegrationCatalog.listApprovals')(function* (status) {
        const [approvals, byClient] = yield* Effect.all([
          store.listApprovals(tenantId, status),
          principals.byClientId(),
        ]);
        return approvals.map((approval) => approvalView(approval, byClient));
      }, asIntegrationFailure),

      getApproval: Effect.fn('IntegrationCatalog.getApproval')(function* (id) {
        const approval = yield* store.getApproval(tenantId, id);
        if (approval === undefined) return yield* notFound(`Unknown approval ${id}`);
        return approvalView(approval, yield* principals.byClientId());
      }, asIntegrationFailure),

      decideApproval: Effect.fn('IntegrationCatalog.decideApproval')(
        function* (id, action, decidedBy) {
          const existing = yield* store.getApproval(tenantId, id);
          if (existing === undefined) return yield* notFound(`Unknown approval ${id}`);
          const byClient = yield* principals.byClientId();
          if (existing.status !== 'pending') return approvalView(existing, byClient);
          const decided = yield* (
            action === 'accept'
              ? approveApproval(
                  { store, integrations, retentionDays: argumentRetentionDays },
                  { tenantId, id, decidedBy },
                ).pipe(Effect.provide(runtimeContext))
              : denyApproval(store, { tenantId, id, decidedBy })
          ).pipe(
            Effect.catchTag('ApprovalNotFound', (failure: ApprovalNotFound) =>
              Effect.fail(notFound(`Unknown approval ${failure.id}`)),
            ),
            Effect.catchTag('ApprovalConflict', (failure: ApprovalConflict) =>
              Effect.flatMap(store.getApproval(tenantId, id), (settled) =>
                settled === undefined
                  ? Effect.fail(operationError(failure.message))
                  : Effect.succeed({ approval: settled }),
              ),
            ),
          );
          return approvalView(decided.approval, byClient);
        },
        asIntegrationFailure,
        touchesApprovals,
      ),

      listAudit: Effect.fn('IntegrationCatalog.listAudit')(function* (query) {
        const limit = decodePositiveInt(Math.min(Math.max(query.limit ?? 50, 1), 500));
        const offset = decodeNonNegativeInt(Math.max(query.offset ?? 0, 0));
        const [records, total, byClient] = yield* Effect.all([
          store.listAudit(tenantId, { limit, offset }),
          store.countAudit(tenantId, {}),
          principals.byClientId(),
        ]);
        return { records: records.map((record) => auditView(record, byClient)), total };
      }, asIntegrationFailure),
    };

    return IntegrationCatalog.of(service);
  }),
).pipe(Layer.provide(ChangeFeedLive));

export { platformPrincipal };
