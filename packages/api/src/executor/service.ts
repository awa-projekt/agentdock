import { createExecutionEngine, formatExecuteResult, formatPausedExecution } from '@executor-js/execution/core';
import { googleDiscoveryPlugin } from '@executor-js/plugin-google-discovery';
import { graphqlPlugin } from '@executor-js/plugin-graphql';
import { mcpPlugin } from '@executor-js/plugin-mcp';
import { openApiPlugin } from '@executor-js/plugin-openapi';
import { makeQuickJsExecutor } from '@executor-js/runtime-quickjs';
import {
  collectSchemas,
  createExecutor,
  Scope,
  ScopeId,
  SecretId,
  SetSecretInput,
  StorageError,
  definePlugin,
  type AnyPlugin,
  type Executor,
  type SecretProvider,
} from '@executor-js/sdk/core';
import { makeSqliteAdapter, makeSqliteBlobStore } from '@executor-js/storage-file';
import { NodeHttpClient } from '@effect/platform-node';
import { and, eq, inArray } from 'drizzle-orm';
import { blob, db, executor_pinned_tool, tool_policy } from 'db';
import { createExecutorExecutionToolsFromOperations } from 'agentdock-sdk';
import { Context, Effect, Layer } from 'effect';
import type { ToolSet } from 'ai';
import type { ExecutionEngine } from '@executor-js/execution/core';
import { ExecutorMcpProbeError } from './schemas';
import type {
  AddMcpSourceInput,
  AddMcpSourceResponse,
  AddGoogleDiscoverySourceInput,
  AddGraphqlSourceInput,
  AddOpenApiSourceInput,
  CompleteOAuthInput,
  CompleteOAuthResponse,
  DetectSourceInput,
  DetectSourceResponse,
  ExecutorSourcesResponse,
  ExecutorToolMode,
  McpProbeInput,
  McpProbeResponse,
  PreviewOpenApiInput,
  ProbeGoogleDiscoveryInput,
  SetExecutorToolModesInput,
  SetExecutorToolModesResponse,
  SetPinnedExecutorToolsInput,
  SetPinnedExecutorToolsResponse,
  StartOAuthInput,
  StartOAuthResponse,
  SourceAddResponse,
  SourceStaticAuthInput,
  UpdateMcpSourceInput,
} from './schemas';

type AgentExecutorHandle = {
  readonly scope: string;
  readonly executor: Executor<readonly AnyPlugin[]> & { readonly mcp: any; readonly openapi: any; readonly graphql: any; readonly googleDiscovery: any };
  readonly engine: ExecutionEngine<any>;
};

type AgentExecutorRegistryService = {
  readonly get: (agentId: string) => Effect.Effect<AgentExecutorHandle, unknown>;
  readonly listSources: (agentId: string) => Effect.Effect<ExecutorSourcesResponse, unknown>;
  readonly detectSource: (agentId: string, input: DetectSourceInput) => Effect.Effect<DetectSourceResponse, unknown>;
  readonly probeMcpEndpoint: (agentId: string, input: McpProbeInput) => Effect.Effect<McpProbeResponse, ExecutorMcpProbeError>;
  readonly addMcpSource: (agentId: string, input: AddMcpSourceInput) => Effect.Effect<AddMcpSourceResponse, unknown>;
  readonly updateMcpSource: (agentId: string, sourceId: string, input: UpdateMcpSourceInput) => Effect.Effect<{ readonly updated: boolean }, unknown>;
  readonly removeMcpSource: (agentId: string, sourceId: string) => Effect.Effect<{ readonly removed: boolean }, unknown>;
  readonly previewOpenApiSpec: (agentId: string, input: PreviewOpenApiInput) => Effect.Effect<unknown, unknown>;
  readonly addOpenApiSource: (agentId: string, input: AddOpenApiSourceInput) => Effect.Effect<SourceAddResponse, unknown>;
  readonly addGraphqlSource: (agentId: string, input: AddGraphqlSourceInput) => Effect.Effect<SourceAddResponse, unknown>;
  readonly probeGoogleDiscovery: (agentId: string, input: ProbeGoogleDiscoveryInput) => Effect.Effect<unknown, unknown>;
  readonly addGoogleDiscoverySource: (agentId: string, input: AddGoogleDiscoverySourceInput) => Effect.Effect<SourceAddResponse, unknown>;
  readonly removeExecutorSource: (agentId: string, sourceId: string) => Effect.Effect<{ readonly removed: boolean }, unknown>;
  readonly setPinnedTools: (agentId: string, input: SetPinnedExecutorToolsInput) => Effect.Effect<SetPinnedExecutorToolsResponse, unknown>;
  readonly setToolModes: (agentId: string, input: SetExecutorToolModesInput) => Effect.Effect<SetExecutorToolModesResponse, unknown>;
  readonly startOAuth: (agentId: string, input: StartOAuthInput) => Effect.Effect<StartOAuthResponse, unknown>;
  readonly completeOAuth: (agentId: string, input: CompleteOAuthInput) => Effect.Effect<CompleteOAuthResponse, unknown>;
  readonly createTools: (agentId: string) => Effect.Effect<ToolSet, unknown>;
};

const toScopeId = (agentId: string): string => `agent:${agentId}`;
const toConnectionId = (agentId: string, namespace: string): string => `mcp-oauth2-${agentId}-${namespace}`;
const toPluginConnectionId = (pluginId: string, agentId: string, namespace: string): string => `${pluginId}-oauth2-${agentId}-${namespace}`;
const EXECUTOR_SOURCE_ID = 'executor';
const MANAGED_DISABLED_POLICY_PREFIX = 'agentdock-disabled-tool-';
const safeIdPart = (value: string): string => value.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/-+/g, '-');
const toHeaderSecretId = (sourceNamespace: string, headerName: string): string => safeIdPart(`mcp-${sourceNamespace}-${headerName}`);
const toQueryParamSecretId = (sourceNamespace: string, paramName: string): string => safeIdPart(`mcp-${sourceNamespace}-query-${paramName}`);
const toSourceCredentialSecretId = (pluginId: string, sourceNamespace: string, name: string): string => safeIdPart(`${pluginId}-${sourceNamespace}-${name}`);

const MCP_INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 'agentdock-probe',
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'agentdock-probe', version: '0' },
  },
});

const secretNamespace = (scope: string): string => `secrets:${scope}`;

const wrapStorageError = (operation: string) => (cause: unknown) =>
  new StorageError({ message: `Agentdock secret provider ${operation} failed`, cause });

const dbSecretProvider: SecretProvider = {
  key: 'agentdock-db',
  writable: true,
  get: (id, scope) =>
    Effect.tryPromise({
      try: () =>
        db.select({ value: blob.value })
          .from(blob)
          .where(and(eq(blob.namespace, secretNamespace(scope)), eq(blob.key, id)))
          .limit(1)
          .all(),
      catch: wrapStorageError('get'),
    }).pipe(Effect.map((rows) => rows[0]?.value ?? null)),
  set: (id, value, scope) =>
    Effect.tryPromise({
      try: () =>
        db.insert(blob)
          .values({ namespace: secretNamespace(scope), key: id, value })
          .onConflictDoUpdate({ target: [blob.namespace, blob.key], set: { value } })
          .run(),
      catch: wrapStorageError('set'),
    }).pipe(Effect.asVoid),
  delete: (id, scope) =>
    Effect.tryPromise({
      try: () =>
        db.delete(blob)
          .where(and(eq(blob.namespace, secretNamespace(scope)), eq(blob.key, id)))
          .run(),
      catch: wrapStorageError('delete'),
    }).pipe(Effect.map((result) => result.rowsAffected > 0)),
};

const agentdockSecretsPlugin = definePlugin(() => ({
  id: 'agentdock-secrets' as const,
  storage: () => ({}),
  secretProviders: [dbSecretProvider],
}));

const plugins = [
  agentdockSecretsPlugin() as ReturnType<typeof agentdockSecretsPlugin> & AnyPlugin,
  mcpPlugin({ httpClientLayer: NodeHttpClient.layerUndici }) as ReturnType<typeof mcpPlugin> & AnyPlugin,
  openApiPlugin({ httpClientLayer: NodeHttpClient.layerUndici }) as ReturnType<typeof openApiPlugin> & AnyPlugin,
  graphqlPlugin({ httpClientLayer: NodeHttpClient.layerUndici }) as ReturnType<typeof graphqlPlugin> & AnyPlugin,
  googleDiscoveryPlugin() as ReturnType<typeof googleDiscoveryPlugin> & AnyPlugin,
] as const;
const schema = collectSchemas(plugins);

const formatExecutionOutcome = (outcome: any) =>
  outcome.status === 'completed'
    ? formatExecuteResult(outcome.result)
    : {
        ...formatPausedExecution(outcome.execution),
        resumePayload: {
          executionId: outcome.execution.id,
          action: 'accept' as const,
          content: {},
        },
      };

const errorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }

  return fallback;
};

const deriveMcpProbeName = (endpoint: string): string => {
  try {
    return new (globalThis as any).URL(endpoint).hostname.replace(/^www\./, '') || 'mcp';
  } catch {
    return 'mcp';
  }
};

const deriveMcpProbeNamespace = (endpoint: string): string =>
  deriveMcpProbeName(endpoint).replace(/[^a-zA-Z0-9_-]/g, '_') || 'mcp';

const openApiSpecToString = (spec: { readonly kind: 'url'; readonly url: string } | { readonly kind: 'blob'; readonly value: string }): string =>
  spec.kind === 'url' ? spec.url : spec.value;

const listPinnedToolIds = (agentId: string) =>
  Effect.tryPromise({
    try: async () =>
      new Set(
        (await db.select({ toolId: executor_pinned_tool.tool_id })
          .from(executor_pinned_tool)
          .where(eq(executor_pinned_tool.agent_id, agentId))
          .all())
          .map((row) => row.toolId),
      ),
    catch: wrapStorageError('list pinned executor tools'),
  });

const toDisabledToolPolicyId = (toolId: string): string => `${MANAGED_DISABLED_POLICY_PREFIX}${safeIdPart(toolId)}`;

const listDisabledToolIds = (agentId: string) =>
  Effect.tryPromise({
    try: async () =>
      new Set(
        (await db.select({ pattern: tool_policy.pattern })
          .from(tool_policy)
          .where(and(eq(tool_policy.scope_id, toScopeId(agentId)), eq(tool_policy.action, 'block')))
          .all())
          .map((row) => row.pattern),
      ),
    catch: wrapStorageError('list disabled executor tools'),
  });

const resolveToolMode = (toolId: string, pinnedToolIds: ReadonlySet<string>, disabledToolIds: ReadonlySet<string>): ExecutorToolMode => {
  if (disabledToolIds.has(toolId)) return 'disabled';
  if (pinnedToolIds.has(toolId)) return 'native';
  return 'discoverable';
};

const formatPinnedToolsDescription = (tools: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: unknown;
}>): string => {
  if (tools.length === 0) return '';

  const formattedTools = tools.map((tool) => {
    const inputSchema = tool.inputSchema === undefined ? 'No input schema.' : JSON.stringify(tool.inputSchema, null, 2);
    return [
      `Tool: ${tool.name}`,
      `ID: ${tool.id}`,
      tool.description ? `Description: ${tool.description}` : 'Description: No description.',
      'Input schema:',
      inputSchema,
    ].join('\n');
  });

  return [
    '',
    'Pinned executor tools available without discovery:',
    'The following tools have been selected in the Sources UI. You can call them directly from execute code without first running discovery to inspect their description or input schema.',
    ...formattedTools,
  ].join('\n\n');
};

const resolveOpenApiBaseUrl = (baseUrl: string, spec: { readonly kind: 'url'; readonly url: string } | { readonly kind: 'blob'; readonly value: string }): string => {
  if (!baseUrl.trim() || spec.kind !== 'url') return baseUrl;
  try {
    return new URL(baseUrl, spec.url).toString();
  } catch {
    return baseUrl;
  }
};

const storeSourceSecret = (
  executor: AgentExecutorHandle['executor'],
  scope: string,
  input: { readonly id: string; readonly name: string; readonly value: string },
) =>
  executor.secrets.set(SetSecretInput.make({
    id: SecretId.make(input.id),
    scope: ScopeId.make(scope),
    name: input.name,
    value: input.value,
  }));

const staticAuthToCredentialConfig = Effect.fn('AgentExecutorRegistry.staticAuthToCredentialConfig')(function* (
  executor: AgentExecutorHandle['executor'],
  scope: string,
  pluginId: string,
  namespace: string,
  sourceName: string,
  auth: SourceStaticAuthInput | undefined,
) {
  if (!auth || auth.kind === 'none') return {};
  if (auth.kind === 'header') {
    const secretId = toSourceCredentialSecretId(pluginId, namespace, `header-${auth.headerName}`);
    yield* storeSourceSecret(executor, scope, {
      id: secretId,
      name: `${sourceName} ${auth.headerName}`,
      value: auth.token,
    });
    return {
      headers: { [auth.headerName]: { kind: 'secret' as const, secretId, prefix: auth.prefix } },
      credentials: {
        scope,
        headers: { [auth.headerName]: { kind: 'secret' as const, secretId, prefix: auth.prefix } },
      },
    };
  }

  const secretId = toSourceCredentialSecretId(pluginId, namespace, `query-${auth.paramName}`);
  yield* storeSourceSecret(executor, scope, {
    id: secretId,
    name: `${sourceName} ${auth.paramName}`,
    value: auth.token,
  });
  return {
    queryParams: { [auth.paramName]: { kind: 'secret' as const, secretId, prefix: auth.prefix } },
    credentials: {
      scope,
      queryParams: { [auth.paramName]: { kind: 'secret' as const, secretId, prefix: auth.prefix } },
    },
  };
});

const isOAuthMcpChallenge = (response: {
  readonly status: number;
  readonly headers: { readonly get: (name: string) => string | null };
}): boolean => {
  if (response.status !== 401) return false;
  const wwwAuthenticate = response.headers.get('www-authenticate') ?? '';
  return /^\s*bearer\b/i.test(wwwAuthenticate) && /(?:^|[\s,])(resource_metadata|error)\s*=/i.test(wwwAuthenticate);
};

const probeOAuthProtectedMcpEndpoint = (
  executor: AgentExecutorHandle['executor'],
  endpoint: string,
): Effect.Effect<McpProbeResponse, ExecutorMcpProbeError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        (globalThis as any).fetch(endpoint, {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
          },
          body: MCP_INITIALIZE_BODY,
          signal: (globalThis as any).AbortSignal.timeout(8_000),
        }),
      catch: (error) => new ExecutorMcpProbeError({ message: errorMessage(error, 'Failed to reach MCP endpoint') }),
    });

    if (!isOAuthMcpChallenge(response as Parameters<typeof isOAuthMcpChallenge>[0])) {
      return yield* new ExecutorMcpProbeError({ message: "This URL doesn't appear to host an OAuth-protected MCP server." });
    }

    const oauth = yield* executor.oauth.probe({ endpoint }).pipe(
      Effect.mapError(
        (error: unknown) =>
          new ExecutorMcpProbeError({
            message: errorMessage(error, "This server requires authentication, but OAuth metadata wasn't found."),
          }),
      ),
    );

    return {
      connected: false,
      requiresOAuth: true,
      supportsDynamicRegistration: oauth.supportsDynamicRegistration,
      name: deriveMcpProbeName(endpoint),
      namespace: deriveMcpProbeNamespace(endpoint),
      toolCount: null,
      serverName: null,
    };
  });

export const AgentExecutorRegistry = Context.Service<AgentExecutorRegistryService>(
  '@agentdock/api/AgentExecutorRegistry',
);

export const AgentExecutorRegistryLive = Layer.effect(
  AgentExecutorRegistry,
  Effect.gen(function* () {
    const handles = new Map<string, AgentExecutorHandle>();

    const get = Effect.fn('AgentExecutorRegistry.get')(function* (agentId: string) {
      const existing = handles.get(agentId);
      if (existing) return existing;

      const scope = Scope.make({
        id: ScopeId.make(toScopeId(agentId)),
        name: `Agent ${agentId}`,
        createdAt: new Date(),
      });
      const executor = (yield* createExecutor({
        scopes: [scope],
        adapter: makeSqliteAdapter({ db, schema }),
        blobs: makeSqliteBlobStore({ db }),
        plugins,
        onElicitation: 'accept-all',
        httpClientLayer: NodeHttpClient.layerUndici,
        oauthEndpointUrlPolicy: { allowHttp: true },
      })) as unknown as AgentExecutorHandle['executor'];
      const engine = createExecutionEngine({
        executor,
        codeExecutor: makeQuickJsExecutor({ timeoutMs: 10_000, memoryLimitBytes: 64 * 1024 * 1024 }),
      });
      const handle = { scope: scope.id, executor, engine: engine as ExecutionEngine<any> } satisfies AgentExecutorHandle;
      handles.set(agentId, handle);
      return handle;
    });

    return AgentExecutorRegistry.of({
      get,
      listSources: Effect.fn('AgentExecutorRegistry.listSources')(function* (agentId: string) {
        const { executor } = yield* get(agentId);
        const [sources, tools, pinnedToolIds, disabledToolIds] = yield* Effect.all([
          executor.sources.list(),
          executor.tools.list({ includeBlocked: true }),
          listPinnedToolIds(agentId),
          listDisabledToolIds(agentId),
        ]);
        const visibleSources = sources.filter((source) => source.id !== EXECUTOR_SOURCE_ID);
        const visibleTools = tools.filter((tool) => tool.sourceId !== EXECUTOR_SOURCE_ID);
        return {
          sources: visibleSources.map((source) => ({
            ...source,
            toolCount: visibleTools.filter((tool) => tool.sourceId === source.id).length,
          })),
          tools: visibleTools.map((tool) => ({
            id: tool.id,
            sourceId: tool.sourceId,
            pluginId: tool.pluginId,
            name: tool.name,
            description: tool.description,
            pinned: pinnedToolIds.has(tool.id),
            mode: resolveToolMode(tool.id, pinnedToolIds, disabledToolIds),
            ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
            ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
          })),
        };
      }),
      detectSource: Effect.fn('AgentExecutorRegistry.detectSource')(function* (agentId, input) {
        const { executor } = yield* get(agentId);
        const results = yield* executor.sources.detect(input.url);
        return { results };
      }),
      probeMcpEndpoint: Effect.fn('AgentExecutorRegistry.probeMcpEndpoint')(function* (agentId, input) {
        const { executor } = yield* get(agentId).pipe(
          Effect.mapError(
            (error) => new ExecutorMcpProbeError({ message: errorMessage(error, 'Failed to initialize agent executor') }),
          ),
        );
        return yield* (executor.mcp.probeEndpoint(input.endpoint) as Effect.Effect<McpProbeResponse, unknown, never>).pipe(
          Effect.catch((error) =>
            probeOAuthProtectedMcpEndpoint(executor, input.endpoint).pipe(
              Effect.mapError(
                () => new ExecutorMcpProbeError({ message: errorMessage(error, 'Failed to probe MCP endpoint') }),
              ),
            ),
          ),
        );
      }),
      addMcpSource: Effect.fn('AgentExecutorRegistry.addMcpSource')(function* (agentId, input) {
        const { executor, scope } = yield* get(agentId);
        const namespace = input.namespace ?? deriveMcpProbeNamespace(input.endpoint);
        const auth = input.auth ?? { kind: 'none' as const };
        const mcpAuth = yield* Effect.gen(function* () {
          if (auth.kind === 'oauth2') {
            return { credentialTargetScope: scope, auth: { kind: 'oauth2' as const, connectionId: auth.connectionId } };
          }

          if (auth.kind === 'header') {
            const secretId = toHeaderSecretId(namespace, auth.headerName);
            yield* executor.secrets.set(SetSecretInput.make({
              id: SecretId.make(secretId),
              scope: ScopeId.make(scope),
              name: `${input.name} ${auth.headerName}`,
              value: auth.token,
            }));

            return {
              credentialTargetScope: scope,
              auth: {
                kind: 'header' as const,
                headerName: auth.headerName,
                secretId,
                prefix: auth.prefix,
                targetScope: ScopeId.make(scope),
              },
            };
          }

          if (auth.kind === 'queryParam') {
            const secretId = toQueryParamSecretId(namespace, auth.paramName);
            yield* executor.secrets.set(SetSecretInput.make({
              id: SecretId.make(secretId),
              scope: ScopeId.make(scope),
              name: `${input.name} ${auth.paramName}`,
              value: auth.token,
            }));

            return {
              credentialTargetScope: scope,
              queryParams: { [auth.paramName]: { kind: 'secret' as const, secretId, prefix: auth.prefix } },
              credentials: {
                scope,
                queryParams: { [auth.paramName]: { kind: 'secret' as const, secretId, prefix: auth.prefix } },
              },
              auth: { kind: 'none' as const },
            };
          }

          return { auth: { kind: 'none' as const } };
        });

        return yield* (executor.mcp.addSource({
          scope,
          transport: 'remote',
          name: input.name,
          endpoint: input.endpoint,
          namespace,
          ...mcpAuth,
        }) as Effect.Effect<AddMcpSourceResponse, unknown, never>);
      }),
      updateMcpSource: Effect.fn('AgentExecutorRegistry.updateMcpSource')(function* (agentId, sourceId, input) {
        const { executor, scope } = yield* get(agentId);
        const auth = input.auth;
        let updateAuth: Record<string, unknown> = {};
        if (auth?.kind === 'none') {
          updateAuth = { auth: { kind: 'none' as const } };
        }

        if (auth?.kind === 'header') {
          const secretId = toHeaderSecretId(sourceId, auth.headerName);
          yield* (executor.secrets.set(SetSecretInput.make({
            id: SecretId.make(secretId),
            scope: ScopeId.make(scope),
            name: `${input.name?.trim() || sourceId} ${auth.headerName}`,
            value: auth.token,
          })) as Effect.Effect<unknown, unknown, never>);
          updateAuth = {
            credentialTargetScope: scope,
            auth: {
              kind: 'header' as const,
              headerName: auth.headerName,
              secretId,
              prefix: auth.prefix,
              targetScope: ScopeId.make(scope),
            },
          };
        }

        if (auth?.kind === 'queryParam') {
          const secretId = toQueryParamSecretId(sourceId, auth.paramName);
          yield* (executor.secrets.set(SetSecretInput.make({
            id: SecretId.make(secretId),
            scope: ScopeId.make(scope),
            name: `${input.name?.trim() || sourceId} ${auth.paramName}`,
            value: auth.token,
          })) as Effect.Effect<unknown, unknown, never>);
          updateAuth = {
            credentialTargetScope: scope,
            queryParams: { [auth.paramName]: { kind: 'secret' as const, secretId, prefix: auth.prefix } },
            credentials: {
              scope,
              queryParams: { [auth.paramName]: { kind: 'secret' as const, secretId, prefix: auth.prefix } },
            },
            auth: { kind: 'none' as const },
          };
        }

        yield* (executor.mcp.updateSource(sourceId, scope, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}),
          ...updateAuth,
        }) as Effect.Effect<void, unknown, never>);

        if (input.endpoint !== undefined || input.auth !== undefined) {
          yield* (executor.mcp.refreshSource(sourceId, scope) as Effect.Effect<unknown, unknown, never>);
        }

        return { updated: true };
      }),
      removeMcpSource: Effect.fn('AgentExecutorRegistry.removeMcpSource')(function* (agentId, sourceId) {
        const { executor, scope } = yield* get(agentId);
        yield* (executor.mcp.removeSource(sourceId, scope) as Effect.Effect<void, unknown, never>);
        return { removed: true };
      }),
      previewOpenApiSpec: Effect.fn('AgentExecutorRegistry.previewOpenApiSpec')(function* (agentId, input) {
        const { executor } = yield* get(agentId);
        return yield* (executor.openapi.previewSpec(openApiSpecToString(input.spec)) as Effect.Effect<unknown, unknown, never>);
      }),
      addOpenApiSource: Effect.fn('AgentExecutorRegistry.addOpenApiSource')(function* (agentId, input) {
        const { executor, scope } = yield* get(agentId);
        const headers: Record<string, unknown> = {};
        const queryParams: Record<string, unknown> = {};
        const configureHeaders: Record<string, unknown> = {};
        const configureQueryParams: Record<string, unknown> = {};

        if (input.auth?.kind === 'header') {
          const secretId = toSourceCredentialSecretId('openapi', input.namespace, `header-${input.auth.headerName}`);
          yield* storeSourceSecret(executor, scope, { id: secretId, name: `${input.name} ${input.auth.headerName}`, value: input.auth.token });
          headers[input.auth.headerName] = { kind: 'secret', prefix: input.auth.prefix };
          configureHeaders[input.auth.headerName] = { kind: 'secret', secretId, prefix: input.auth.prefix };
        }
        if (input.auth?.kind === 'queryParam') {
          const secretId = toSourceCredentialSecretId('openapi', input.namespace, `query-${input.auth.paramName}`);
          yield* storeSourceSecret(executor, scope, { id: secretId, name: `${input.name} ${input.auth.paramName}`, value: input.auth.token });
          queryParams[input.auth.paramName] = { kind: 'secret', prefix: input.auth.prefix };
          configureQueryParams[input.auth.paramName] = { kind: 'secret', secretId, prefix: input.auth.prefix };
        }

        let oauth2: Record<string, unknown> | undefined;
        let configureOauth2: Record<string, unknown> | undefined;
        let authorizationUrl: string | null | undefined;
        if (input.oauth2) {
          const clientIdSecretId = toSourceCredentialSecretId('openapi', input.namespace, 'oauth-client-id');
          const clientSecretSecretId = input.oauth2.clientSecret ? toSourceCredentialSecretId('openapi', input.namespace, 'oauth-client-secret') : null;
          const connectionId = toPluginConnectionId('openapi', agentId, input.namespace);
          yield* storeSourceSecret(executor, scope, { id: clientIdSecretId, name: `${input.name} OAuth client ID`, value: input.oauth2.clientId });
          if (clientSecretSecretId && input.oauth2.clientSecret) {
            yield* storeSourceSecret(executor, scope, { id: clientSecretSecretId, name: `${input.name} OAuth client secret`, value: input.oauth2.clientSecret });
          }
          const connectionSlot = `oauth2:${input.oauth2.securitySchemeName}:connection`;
          const clientIdSlot = `oauth2:${input.oauth2.securitySchemeName}:client-id`;
          const clientSecretSlot = `oauth2:${input.oauth2.securitySchemeName}:client-secret`;
          oauth2 = {
            kind: 'oauth2',
            securitySchemeName: input.oauth2.securitySchemeName,
            flow: input.oauth2.flow,
            tokenUrl: input.oauth2.tokenUrl,
            authorizationUrl: input.oauth2.authorizationUrl ?? null,
            clientIdSlot,
            clientSecretSlot,
            connectionSlot,
            scopes: input.oauth2.scopes,
          };
          const started = yield* executor.oauth.start({
            endpoint: input.oauth2.authorizationUrl ?? input.oauth2.tokenUrl,
            redirectUrl: input.oauth2.authorizationUrl ?? input.oauth2.tokenUrl,
            connectionId,
            tokenScope: scope,
            pluginId: 'openapi',
            identityLabel: `${input.name} OAuth`,
            strategy: input.oauth2.flow === 'clientCredentials'
              ? {
                  kind: 'client-credentials' as const,
                  tokenEndpoint: input.oauth2.tokenUrl,
                  clientIdSecretId,
                  clientSecretSecretId: clientSecretSecretId ?? '',
                  scopes: input.oauth2.scopes,
                  clientAuth: input.oauth2.clientAuth,
                }
              : {
                  kind: 'authorization-code' as const,
                  authorizationEndpoint: input.oauth2.authorizationUrl ?? '',
                  tokenEndpoint: input.oauth2.tokenUrl,
                  issuerUrl: null,
                  clientIdSecretId,
                  clientSecretSecretId,
                  scopes: input.oauth2.scopes,
                  clientAuth: input.oauth2.clientAuth,
                },
          });
          authorizationUrl = started.authorizationUrl;
          configureOauth2 = {
            clientId: { kind: 'secret', secretId: clientIdSecretId },
            clientSecret: clientSecretSecretId ? { kind: 'secret', secretId: clientSecretSecretId } : null,
            connection: { kind: 'connection', connectionId: started.completedConnection?.connectionId ?? connectionId },
          };
        }

        const result = yield* (executor.openapi.addSpec({
          scope,
          spec: openApiSpecToString(input.spec),
          name: input.name,
          baseUrl: resolveOpenApiBaseUrl(input.baseUrl, input.spec),
          namespace: input.namespace,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
          ...(oauth2 ? { oauth2 } : {}),
        }) as Effect.Effect<{ readonly toolCount: number }, unknown, never>);
        if (Object.keys(configureHeaders).length > 0 || Object.keys(configureQueryParams).length > 0 || configureOauth2) {
          yield* (executor.openapi.configure({ id: input.namespace, scope }, {
            scope,
            ...(Object.keys(configureHeaders).length > 0 ? { headers: configureHeaders } : {}),
            ...(Object.keys(configureQueryParams).length > 0 ? { queryParams: configureQueryParams } : {}),
            ...(configureOauth2 ? { oauth2: configureOauth2 } : {}),
            ...(oauth2 ? { oauth2Source: oauth2 } : {}),
          }) as Effect.Effect<unknown, unknown, never>);
        }
        return { namespace: input.namespace, toolCount: result.toolCount, ...(authorizationUrl !== undefined ? { authorizationUrl } : {}) };
      }),
      addGraphqlSource: Effect.fn('AgentExecutorRegistry.addGraphqlSource')(function* (agentId, input) {
        const { executor, scope } = yield* get(agentId);
        const credentials = yield* staticAuthToCredentialConfig(executor, scope, 'graphql', input.namespace, input.name, input.auth);
        const result = yield* (executor.graphql.addSource({
          scope,
          endpoint: input.endpoint,
          name: input.name,
          namespace: input.namespace,
          ...(input.introspectionJson ? { introspectionJson: input.introspectionJson } : {}),
          ...credentials,
        }) as Effect.Effect<{ readonly namespace: string; readonly toolCount: number }, unknown, never>);
        return { namespace: result.namespace, toolCount: result.toolCount };
      }),
      probeGoogleDiscovery: Effect.fn('AgentExecutorRegistry.probeGoogleDiscovery')(function* (agentId, input) {
        const { executor } = yield* get(agentId);
        return yield* (executor.googleDiscovery.probeDiscovery(input) as Effect.Effect<unknown, unknown, never>);
      }),
      addGoogleDiscoverySource: Effect.fn('AgentExecutorRegistry.addGoogleDiscoverySource')(function* (agentId, input) {
        const { executor, scope } = yield* get(agentId);
        let auth: Record<string, unknown> = { kind: 'none' };
        let authorizationUrl: string | null | undefined;
        if (input.auth.kind === 'oauth2') {
          const namespace = input.namespace ?? safeIdPart(input.name.toLowerCase()).replace(/-/g, '_');
          const clientIdSecretId = toSourceCredentialSecretId('google-discovery', namespace, 'oauth-client-id');
          const clientSecretSecretId = input.auth.oauth2.clientSecret ? toSourceCredentialSecretId('google-discovery', namespace, 'oauth-client-secret') : null;
          const connectionId = toPluginConnectionId('google-discovery', agentId, namespace);
          yield* storeSourceSecret(executor, scope, { id: clientIdSecretId, name: `${input.name} Google client ID`, value: input.auth.oauth2.clientId });
          if (clientSecretSecretId && input.auth.oauth2.clientSecret) {
            yield* storeSourceSecret(executor, scope, { id: clientSecretSecretId, name: `${input.name} Google client secret`, value: input.auth.oauth2.clientSecret });
          }
          const started = yield* executor.oauth.start({
            endpoint: input.discoveryUrl,
            redirectUrl: input.discoveryUrl,
            connectionId,
            tokenScope: scope,
            pluginId: 'google-discovery',
            identityLabel: `${input.name} Google`,
            strategy: {
              kind: 'authorization-code' as const,
              authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
              tokenEndpoint: 'https://oauth2.googleapis.com/token',
              issuerUrl: 'https://accounts.google.com',
              clientIdSecretId,
              clientSecretSecretId,
              scopes: input.auth.oauth2.scopes,
              extraAuthorizationParams: {
                access_type: 'offline',
                include_granted_scopes: 'true',
                prompt: 'consent',
              },
            },
          });
          authorizationUrl = started.authorizationUrl;
          auth = {
            kind: 'oauth2',
            connectionId: started.completedConnection?.connectionId ?? connectionId,
            clientIdSecretId,
            clientSecretSecretId,
            scopes: input.auth.oauth2.scopes,
          };
        }
        const result = yield* (executor.googleDiscovery.addSource({
          scope,
          discoveryUrl: input.discoveryUrl,
          name: input.name,
          ...(input.namespace ? { namespace: input.namespace } : {}),
          auth,
        }) as Effect.Effect<{ readonly namespace: string; readonly toolCount: number }, unknown, never>);
        return { namespace: result.namespace, toolCount: result.toolCount, ...(authorizationUrl !== undefined ? { authorizationUrl } : {}) };
      }),
      removeExecutorSource: Effect.fn('AgentExecutorRegistry.removeExecutorSource')(function* (agentId, sourceId) {
        const { executor, scope } = yield* get(agentId);
        const sources = yield* executor.sources.list();
        const source = sources.find((candidate: { readonly id: string }) => candidate.id === sourceId);
        if (source?.pluginId === 'openapi') {
          yield* (executor.openapi.removeSpec(sourceId, scope) as Effect.Effect<void, unknown, never>);
        } else if (source?.pluginId === 'graphql') {
          yield* (executor.graphql.removeSource(sourceId, scope) as Effect.Effect<void, unknown, never>);
        } else if (source?.pluginId === 'googleDiscovery' || source?.pluginId === 'google-discovery') {
          yield* (executor.googleDiscovery.removeSource(sourceId, scope) as Effect.Effect<void, unknown, never>);
        } else {
          yield* (executor.mcp.removeSource(sourceId, scope) as Effect.Effect<void, unknown, never>);
        }
        return { removed: true };
      }),
      setPinnedTools: Effect.fn('AgentExecutorRegistry.setPinnedTools')(function* (agentId, input) {
        const { executor } = yield* get(agentId);
        const tools = yield* executor.tools.list();
        const visibleToolIds = new Set(
          tools
            .filter((tool) => tool.sourceId !== EXECUTOR_SOURCE_ID)
            .map((tool) => tool.id),
        );
        const toolIds = [...new Set(input.toolIds)].filter((toolId) => visibleToolIds.has(toolId));
        yield* Effect.tryPromise({
          try: async () => {
            await db.transaction(async (tx) => {
              await tx.delete(executor_pinned_tool)
                .where(eq(executor_pinned_tool.agent_id, agentId))
                .run();
              if (toolIds.length > 0) {
                await tx.insert(executor_pinned_tool)
                  .values(toolIds.map((toolId) => ({ agent_id: agentId, tool_id: toolId, created_at: new Date() })))
                  .run();
              }
            });
          },
          catch: wrapStorageError('set pinned executor tools'),
        });
        return { updated: true };
      }),
      setToolModes: Effect.fn('AgentExecutorRegistry.setToolModes')(function* (agentId, input) {
        const { executor } = yield* get(agentId);
        const tools = yield* executor.tools.list({ includeBlocked: true });
        const visibleToolIds = new Set(
          tools
            .filter((tool) => tool.sourceId !== EXECUTOR_SOURCE_ID)
            .map((tool) => tool.id),
        );
        const modes = input.modes.filter(({ toolId }) => visibleToolIds.has(toolId));
        const toolIds = [...new Set(modes.map(({ toolId }) => toolId))];
        const nativeToolIds = toolIds.filter((toolId) => modes.find((mode) => mode.toolId === toolId)?.mode === 'native');
        const disabledToolIds = toolIds.filter((toolId) => modes.find((mode) => mode.toolId === toolId)?.mode === 'disabled');
        const scopeId = toScopeId(agentId);
        const now = new Date();

        yield* Effect.tryPromise({
          try: async () => {
            await db.transaction(async (tx) => {
              if (toolIds.length === 0) return;
              await tx.delete(executor_pinned_tool)
                .where(and(eq(executor_pinned_tool.agent_id, agentId), inArray(executor_pinned_tool.tool_id, toolIds)))
                .run();
              await tx.delete(tool_policy)
                .where(and(eq(tool_policy.scope_id, scopeId), inArray(tool_policy.id, toolIds.map(toDisabledToolPolicyId))))
                .run();
              if (nativeToolIds.length > 0) {
                await tx.insert(executor_pinned_tool)
                  .values(nativeToolIds.map((toolId) => ({ agent_id: agentId, tool_id: toolId, created_at: now })))
                  .run();
              }
              if (disabledToolIds.length > 0) {
                await tx.insert(tool_policy)
                  .values(disabledToolIds.map((toolId) => ({
                    id: toDisabledToolPolicyId(toolId),
                    scope_id: scopeId,
                    pattern: toolId,
                    action: 'block',
                    position: 'a0',
                    created_at: now,
                    updated_at: now,
                  })))
                  .run();
              }
            });
          },
          catch: wrapStorageError('set executor tool modes'),
        });
        return { updated: true };
      }),
      startOAuth: Effect.fn('AgentExecutorRegistry.startOAuth')(function* (agentId, input) {
        const { executor, scope } = yield* get(agentId);
        const connectionId = toConnectionId(agentId, input.namespace);
        const startInput = {
          endpoint: input.endpoint,
          connectionId,
          tokenScope: scope,
          redirectUrl: input.redirectUrl,
          pluginId: 'mcp',
          identityLabel: input.name,
        } as const;
        const started = yield* executor.oauth.start({
          ...startInput,
          strategy: { kind: 'dynamic-dcr' },
        });
        return { connectionId, sessionId: started.sessionId, authorizationUrl: started.authorizationUrl };
      }),
      completeOAuth: Effect.fn('AgentExecutorRegistry.completeOAuth')(function* (agentId, input) {
        const { executor } = yield* get(agentId);
        return yield* executor.oauth.complete({
          state: input.state,
          ...(input.code ? { code: input.code } : {}),
          ...(input.error ? { error: input.error } : {}),
        });
      }),
      createTools: Effect.fn('AgentExecutorRegistry.createTools')(function* (agentId) {
        const { executor, engine } = yield* get(agentId);
        const [description, tools, pinnedToolIds] = yield* Effect.all([
          engine.getDescription,
          executor.tools.list(),
          listPinnedToolIds(agentId),
        ]);
        const pinnedToolsDescription = formatPinnedToolsDescription(
          tools.filter((tool) => tool.sourceId !== EXECUTOR_SOURCE_ID && pinnedToolIds.has(tool.id)),
        );
        const effectContext = yield* Effect.context<never>();
        const runInContext = Effect.runPromiseWith(effectContext);
        return createExecutorExecutionToolsFromOperations({
          description: `${description}${pinnedToolsDescription}`,
          execute: (input) => runInContext(engine.executeWithPause(input.code).pipe(Effect.map(formatExecutionOutcome))),
          resume: (input) =>
            runInContext(
              engine.resume(input.executionId, {
                action: input.action,
                ...(input.content ? { content: input.content } : {}),
              }).pipe(
                Effect.map((outcome) =>
                  outcome ? formatExecutionOutcome(outcome) : { text: `No paused execution: ${input.executionId}`, isError: true },
                ),
              ),
            ),
        });
      }),
    });
  }),
);
