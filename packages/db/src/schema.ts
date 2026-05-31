import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const agentsTable = sqliteTable('agents', {
  id: text('id').primaryKey(),
  visibility: text('visibility', { enum: ['public', 'internal'] }).notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  tools: text('tools', { mode: 'json' }).$type<ReadonlyArray<string>>().notNull(),
  skillIds: text('skill_ids', { mode: 'json' }).$type<ReadonlyArray<string>>().notNull(),
  communication: text('communication', { mode: 'json' }).$type<{
    readonly allowAll: boolean;
    readonly allowedAgentIds: ReadonlyArray<string>;
  }>().notNull(),
  model: text('model').notNull(),
  instructions: text('instructions').notNull(),
  version: text('version').notNull(),
  capabilities: text('capabilities', { mode: 'json' }).$type<{
    readonly pushNotifications: boolean;
    readonly streaming: boolean;
  }>().notNull(),
  defaultInputModes: text('default_input_modes', { mode: 'json' }).$type<ReadonlyArray<string>>().notNull(),
  defaultOutputModes: text('default_output_modes', { mode: 'json' }).$type<ReadonlyArray<string>>().notNull(),
});

export const skillsTable = sqliteTable('skills', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description').notNull(),
  content: text('content').notNull(),
  license: text('license'),
  compatibility: text('compatibility'),
  allowedTools: text('allowed_tools'),
  source: text('source'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const workflowsTable = sqliteTable('workflows', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  version: text('version').notNull(),
  graph: text('graph', { mode: 'json' }).$type<{
    readonly nodes: ReadonlyArray<{
      readonly id: string;
      readonly type: 'input' | 'template' | 'condition' | 'agent' | 'output';
      readonly position: { readonly x: number; readonly y: number };
      readonly data: {
        readonly label: string;
        readonly template?: string | undefined;
        readonly conditionExpression?: string | undefined;
        readonly agentId?: string | undefined;
      };
    }>;
    readonly edges: ReadonlyArray<{
      readonly id: string;
      readonly source: string;
      readonly target: string;
      readonly condition?: 'true' | 'false' | undefined;
    }>;
  }>().notNull(),
});

export const agentCommunicationRulesTable = sqliteTable(
  'agent_communication_rules',
  {
    sourceAgentId: text('source_agent_id').notNull(),
    targetAgentId: text('target_agent_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.sourceAgentId, table.targetAgentId] })],
);

export const a2aTasksTable = sqliteTable(
  'a2a_tasks',
  {
    agentId: text('agent_id').notNull(),
    taskId: text('task_id').notNull(),
    contextId: text('context_id').notNull(),
    task: text('task', { mode: 'json' }).notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.taskId] }),
    index('a2a_tasks_agent_context_idx').on(table.agentId, table.contextId),
    index('a2a_tasks_agent_updated_idx').on(table.agentId, table.updatedAt),
  ],
);

export const a2aContextMessagesTable = sqliteTable(
  'a2a_context_messages',
  {
    agentId: text('agent_id').notNull(),
    contextId: text('context_id').notNull(),
    messageId: text('message_id').notNull(),
    messageIndex: integer('message_index').notNull(),
    message: text('message', { mode: 'json' }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.contextId, table.messageId] }),
    index('a2a_context_messages_agent_context_idx').on(table.agentId, table.contextId, table.messageIndex),
  ],
);

export const sessionsTable = sqliteTable(
  'sessions',
  {
    agentId: text('agent_id').notNull(),
    id: text('id').notNull(),
    taskId: text('task_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.id] }),
    index('sessions_agent_updated_idx').on(table.agentId, table.updatedAt),
  ],
);

export const source = sqliteTable(
  'source',
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    plugin_id: text('plugin_id').notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    url: text('url'),
    can_remove: integer('can_remove', { mode: 'boolean' }).default(true).notNull(),
    can_refresh: integer('can_refresh', { mode: 'boolean' }).default(false).notNull(),
    can_edit: integer('can_edit', { mode: 'boolean' }).default(false).notNull(),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index('source_scope_id_idx').on(table.scope_id),
    index('source_plugin_id_idx').on(table.plugin_id),
  ],
);

export const tool = sqliteTable(
  'tool',
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    source_id: text('source_id').notNull(),
    plugin_id: text('plugin_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    input_schema: text('input_schema', { mode: 'json' }),
    output_schema: text('output_schema', { mode: 'json' }),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index('tool_scope_id_idx').on(table.scope_id),
    index('tool_source_id_idx').on(table.source_id),
    index('tool_plugin_id_idx').on(table.plugin_id),
  ],
);

export const executor_pinned_tool = sqliteTable(
  'executor_pinned_tool',
  {
    agent_id: text('agent_id').notNull(),
    tool_id: text('tool_id').notNull(),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.agent_id, table.tool_id] })],
);

export const definition = sqliteTable(
  'definition',
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    source_id: text('source_id').notNull(),
    plugin_id: text('plugin_id').notNull(),
    name: text('name').notNull(),
    schema: text('schema', { mode: 'json' }).notNull(),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index('definition_scope_id_idx').on(table.scope_id),
    index('definition_source_id_idx').on(table.source_id),
    index('definition_plugin_id_idx').on(table.plugin_id),
  ],
);

export const secret = sqliteTable(
  'secret',
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    name: text('name').notNull(),
    provider: text('provider').notNull(),
    owned_by_connection_id: text('owned_by_connection_id'),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index('secret_scope_id_idx').on(table.scope_id),
    index('secret_provider_idx').on(table.provider),
    index('secret_owned_by_connection_id_idx').on(table.owned_by_connection_id),
  ],
);

export const connection = sqliteTable(
  'connection',
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    provider: text('provider').notNull(),
    identity_label: text('identity_label'),
    access_token_secret_id: text('access_token_secret_id').notNull(),
    refresh_token_secret_id: text('refresh_token_secret_id'),
    expires_at: integer('expires_at'),
    scope: text('scope'),
    provider_state: text('provider_state', { mode: 'json' }),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index('connection_scope_id_idx').on(table.scope_id),
    index('connection_provider_idx').on(table.provider),
  ],
);

export const oauth2_session = sqliteTable(
  'oauth2_session',
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    plugin_id: text('plugin_id').notNull(),
    strategy: text('strategy').notNull(),
    connection_id: text('connection_id').notNull(),
    token_scope: text('token_scope').notNull(),
    redirect_url: text('redirect_url').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    expires_at: integer('expires_at').notNull(),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index('oauth2_session_scope_id_idx').on(table.scope_id),
    index('oauth2_session_plugin_id_idx').on(table.plugin_id),
    index('oauth2_session_connection_id_idx').on(table.connection_id),
  ],
);

export const credential_binding = sqliteTable(
  'credential_binding',
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    plugin_id: text('plugin_id').notNull(),
    source_id: text('source_id').notNull(),
    source_scope_id: text('source_scope_id').notNull(),
    slot_key: text('slot_key').notNull(),
    kind: text('kind').notNull(),
    text_value: text('text_value'),
    secret_id: text('secret_id'),
    secret_scope_id: text('secret_scope_id'),
    connection_id: text('connection_id'),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index('credential_binding_scope_id_idx').on(table.scope_id),
    index('credential_binding_plugin_id_idx').on(table.plugin_id),
    index('credential_binding_source_id_idx').on(table.source_id),
    index('credential_binding_source_scope_id_idx').on(table.source_scope_id),
    index('credential_binding_slot_key_idx').on(table.slot_key),
    index('credential_binding_kind_idx').on(table.kind),
    index('credential_binding_secret_id_idx').on(table.secret_id),
    index('credential_binding_secret_scope_id_idx').on(table.secret_scope_id),
    index('credential_binding_connection_id_idx').on(table.connection_id),
  ],
);

export const tool_policy = sqliteTable(
  'tool_policy',
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    pattern: text('pattern').notNull(),
    action: text('action').notNull(),
    position: text('position').notNull(),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index('tool_policy_scope_id_position_idx').on(table.scope_id, table.position),
  ],
);

export const mcp_source = sqliteTable(
  'mcp_source',
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    name: text('name').notNull(),
    config: text('config', { mode: 'json' }).notNull(),
    auth_kind: text('auth_kind').default('none').notNull(),
    auth_header_name: text('auth_header_name'),
    auth_header_slot: text('auth_header_slot'),
    auth_header_prefix: text('auth_header_prefix'),
    auth_connection_slot: text('auth_connection_slot'),
    auth_client_id_slot: text('auth_client_id_slot'),
    auth_client_secret_slot: text('auth_client_secret_slot'),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index('mcp_source_scope_id_idx').on(table.scope_id),
  ],
);

export const mcp_source_header = sqliteTable(
  'mcp_source_header',
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    source_id: text('source_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    text_value: text('text_value'),
    slot_key: text('slot_key'),
    prefix: text('prefix'),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index('mcp_source_header_scope_id_idx').on(table.scope_id),
    index('mcp_source_header_source_id_idx').on(table.source_id),
  ],
);

export const mcp_source_query_param = sqliteTable(
  'mcp_source_query_param',
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    source_id: text('source_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    text_value: text('text_value'),
    slot_key: text('slot_key'),
    prefix: text('prefix'),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index('mcp_source_query_param_scope_id_idx').on(table.scope_id),
    index('mcp_source_query_param_source_id_idx').on(table.source_id),
  ],
);

export const mcp_binding = sqliteTable(
  'mcp_binding',
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    source_id: text('source_id').notNull(),
    binding: text('binding', { mode: 'json' }).notNull(),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.id] }),
    index('mcp_binding_scope_id_idx').on(table.scope_id),
    index('mcp_binding_source_id_idx').on(table.source_id),
  ],
);

export const openapi_source = sqliteTable(
  'openapi_source',
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    name: text('name').notNull(),
    spec: text('spec').notNull(),
    source_url: text('source_url'),
    base_url: text('base_url'),
    oauth2: text('oauth2', { mode: 'json' }),
  },
  (table) => [primaryKey({ columns: [table.scope_id, table.id] }), index('openapi_source_scope_id_idx').on(table.scope_id)],
);

export const openapi_operation = sqliteTable(
  'openapi_operation',
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    source_id: text('source_id').notNull(),
    binding: text('binding', { mode: 'json' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope_id, table.id] }), index('openapi_operation_source_id_idx').on(table.source_id)],
);

const openapiCredentialTable = (name: string) => sqliteTable(
  name,
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    source_id: text('source_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    text_value: text('text_value'),
    slot_key: text('slot_key'),
    prefix: text('prefix'),
  },
  (table) => [primaryKey({ columns: [table.scope_id, table.id] }), index(`${name}_source_id_idx`).on(table.source_id)],
);

export const openapi_source_header = openapiCredentialTable('openapi_source_header');
export const openapi_source_query_param = openapiCredentialTable('openapi_source_query_param');
export const openapi_source_spec_fetch_header = openapiCredentialTable('openapi_source_spec_fetch_header');
export const openapi_source_spec_fetch_query_param = openapiCredentialTable('openapi_source_spec_fetch_query_param');

export const graphql_source = sqliteTable(
  'graphql_source',
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    name: text('name').notNull(),
    endpoint: text('endpoint').notNull(),
    auth_kind: text('auth_kind').default('none').notNull(),
    auth_connection_slot: text('auth_connection_slot'),
  },
  (table) => [primaryKey({ columns: [table.scope_id, table.id] }), index('graphql_source_scope_id_idx').on(table.scope_id)],
);

export const graphql_source_header = openapiCredentialTable('graphql_source_header');
export const graphql_source_query_param = openapiCredentialTable('graphql_source_query_param');

export const graphql_operation = sqliteTable(
  'graphql_operation',
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    source_id: text('source_id').notNull(),
    binding: text('binding', { mode: 'json' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope_id, table.id] }), index('graphql_operation_source_id_idx').on(table.source_id)],
);

export const google_discovery_source = sqliteTable(
  'google_discovery_source',
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    name: text('name').notNull(),
    config: text('config', { mode: 'json' }).notNull(),
    auth_kind: text('auth_kind').default('none').notNull(),
    auth_connection_id: text('auth_connection_id'),
    auth_client_id_secret_id: text('auth_client_id_secret_id'),
    auth_client_secret_secret_id: text('auth_client_secret_secret_id'),
    auth_scopes: text('auth_scopes', { mode: 'json' }),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope_id, table.id] }), index('google_discovery_source_scope_id_idx').on(table.scope_id)],
);

const googleCredentialTable = (name: string) => sqliteTable(
  name,
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    source_id: text('source_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    text_value: text('text_value'),
    secret_id: text('secret_id'),
    secret_prefix: text('secret_prefix'),
  },
  (table) => [primaryKey({ columns: [table.scope_id, table.id] }), index(`${name}_source_id_idx`).on(table.source_id)],
);

export const google_discovery_source_credential_header = googleCredentialTable('google_discovery_source_credential_header');
export const google_discovery_source_credential_query_param = googleCredentialTable('google_discovery_source_credential_query_param');

export const google_discovery_binding = sqliteTable(
  'google_discovery_binding',
  {
    id: text('id').notNull(),
    scope_id: text('scope_id').notNull(),
    source_id: text('source_id').notNull(),
    binding: text('binding', { mode: 'json' }).notNull(),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope_id, table.id] }), index('google_discovery_binding_source_id_idx').on(table.source_id)],
);

export const blob = sqliteTable(
  'blob',
  {
    namespace: text('namespace').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
  },
  (table) => [primaryKey({ columns: [table.namespace, table.key] })],
);
