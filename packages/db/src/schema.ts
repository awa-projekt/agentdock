import type {
  AgentCapabilities,
  AgentCommunicationToolConfig,
  AgentIntegrations,
  AgentRunArtifact,
  AgentRunMessage,
  AgentRunOrigin,
  AgentRunStatusHistoryEntry,
  AgentSkills,
  ChannelBindingMatch,
  EvalCaseSnapshot,
  EvalGrade,
  EvalGrader,
  EvalGraderConfig,
  EvalReview,
  EvalRunStatus,
  EvalRunTarget,
  EvalRunTrigger,
  EvalTargetUsage,
  EvalTrialOutput,
  EvalTrialStatus,
  InputContract,
  Json,
  JsonObject,
  OutputContract,
  ReasoningEffort,
  SessionSummary,
  TriggerSpec,
  TriggerTaskTemplate,
  Usage,
  WorkflowBindings,
  WorkflowGraph,
  WorkflowManifest,
  WorkflowPendingActionStatus,
  WorkflowRunEvent,
  WorkflowRunStatus,
  WorkflowStepRunStatus,
} from 'agentdock-sdk/schemas';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const orgsTable = sqliteTable('orgs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const usersTable = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    externalSubjectId: text('external_subject_id').notNull(),
    role: text('role', { enum: ['admin', 'user'] }).notNull(),
    email: text('email'),
    displayName: text('display_name'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (table) => [
    index('users_org_idx').on(table.orgId),
    uniqueIndex('users_external_subject_idx').on(table.orgId, table.externalSubjectId),
  ],
);

export const authUserTable = sqliteTable('auth_user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  role: text('role', { enum: ['admin', 'user'] })
    .notNull()
    .default('user'),
  banned: integer('banned', { mode: 'boolean' }).notNull().default(false),
  banReason: text('ban_reason'),
  banExpires: integer('ban_expires', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const authSessionTable = sqliteTable('auth_session', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => authUserTable.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  impersonatedBy: text('impersonated_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const authAccountTable = sqliteTable('auth_account', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => authUserTable.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
  scope: text('scope'),
  idToken: text('id_token'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const authVerificationTable = sqliteTable('auth_verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
});

/** better-auth device-authorization plugin state: the CLI login flow. */
export const authDeviceCodeTable = sqliteTable('auth_device_code', {
  id: text('id').primaryKey(),
  deviceCode: text('device_code').notNull(),
  userCode: text('user_code').notNull(),
  userId: text('user_id'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  status: text('status').notNull(),
  lastPolledAt: integer('last_polled_at', { mode: 'timestamp' }),
  pollingInterval: integer('polling_interval'),
  clientId: text('client_id'),
  scope: text('scope'),
});

/**
 * An MCP client program (Claude Code, Codex, …) known to this server's OAuth
 * authorization server, registered dynamically (`dcr`) or identified by the
 * URL of its client metadata document (`cimd`).
 */
export const mcpOAuthClientsTable = sqliteTable('mcp_oauth_clients', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['dcr', 'cimd'] }).notNull(),
  clientId: text('client_id').notNull().unique(),
  name: text('name').notNull(),
  redirectUris: text('redirect_uris', { mode: 'json' }).$type<ReadonlyArray<string>>().notNull(),
  createdAt: integer('created_at').notNull(),
});

/** An authorization in progress, waiting for a signed-in person to approve or deny it. */
export const mcpOAuthRequestsTable = sqliteTable('mcp_oauth_requests', {
  id: text('id').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => mcpOAuthClientsTable.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  state: text('state'),
  codeChallenge: text('code_challenge').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

/** A person's revocable authorization for a client to act on their behalf over MCP. */
export const mcpOAuthGrantsTable = sqliteTable(
  'mcp_oauth_grants',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => mcpOAuthClientsTable.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
  },
  (table) => [uniqueIndex('mcp_oauth_grants_binding_idx').on(table.clientId, table.userId)],
);

/**
 * Authorization codes and access/refresh tokens, stored as SHA-256 hashes.
 * Refresh tokens rotate: every token minted from one code shares a family, and
 * replaying a spent refresh token revokes the whole family.
 */
export const mcpOAuthTokensTable = sqliteTable(
  'mcp_oauth_tokens',
  {
    hash: text('hash').primaryKey(),
    kind: text('kind', { enum: ['code', 'access', 'refresh'] }).notNull(),
    grantId: text('grant_id')
      .notNull()
      .references(() => mcpOAuthGrantsTable.id, { onDelete: 'cascade' }),
    familyId: text('family_id').notNull(),
    redirectUri: text('redirect_uri'),
    codeChallenge: text('code_challenge'),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
  },
  (table) => [index('mcp_oauth_tokens_family_idx').on(table.familyId)],
);

export const agentsTable = sqliteTable('agents', {
  id: text('id').primaryKey(),
  orgId: text('org_id'),
  createdByUserId: text('created_by_user_id'),
  visibility: text('visibility', { enum: ['public'] }).notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  color: text('color').notNull().default('#2563eb'),
  integrations: text('integrations', { mode: 'json' }).$type<AgentIntegrations>().notNull().default({}),
  skills: text('skills', { mode: 'json' }).$type<AgentSkills>().notNull().default({}),
  communication: text('communication', { mode: 'json' }).$type<AgentCommunicationToolConfig>().notNull(),
  model: text('model').notNull(),
  reasoningEffort: text('reasoning_effort').$type<ReasoningEffort>(),
  instructions: text('instructions').notNull(),
  version: text('version').notNull(),
  capabilities: text('capabilities', { mode: 'json' }).$type<AgentCapabilities>().notNull(),
  defaultInputModes: text('default_input_modes', { mode: 'json' }).$type<ReadonlyArray<string>>().notNull(),
  defaultOutputModes: text('default_output_modes', { mode: 'json' }).$type<ReadonlyArray<string>>().notNull(),
  inputContract: text('input_contract', { mode: 'json' }).$type<InputContract>(),
  outputContract: text('output_contract', { mode: 'json' }).$type<OutputContract>(),
  /** Bumped on every update; clients send it back so a stale push is rejected. */
  revision: integer('revision').notNull().default(1),
});

export const externalA2aAgentsTable = sqliteTable('external_a2a_agents', {
  id: text('id').primaryKey(),
  visibility: text('visibility', { enum: ['external'] }).notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  endpointUrl: text('endpoint_url').notNull().unique(),
  version: text('version').notNull(),
  capabilities: text('capabilities', { mode: 'json' }).$type<AgentCapabilities>().notNull(),
  defaultInputModes: text('default_input_modes', { mode: 'json' }).$type<ReadonlyArray<string>>().notNull(),
  defaultOutputModes: text('default_output_modes', { mode: 'json' }).$type<ReadonlyArray<string>>().notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
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

export const providerKeysTable = sqliteTable('provider_keys', {
  provider: text('provider').primaryKey(),
  apiKey: text('api_key').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const customProvidersTable = sqliteTable('custom_providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKey: text('api_key').notNull(),
  queryParams: text('query_params', { mode: 'json' }).$type<Record<string, string>>(),
  kind: text('kind').notNull().default('openai-compatible'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * A registered code workflow: a pointer at an artifact folder on disk plus the
 * manifest snapshot taken when it was registered. Name/description/version all
 * live in the manifest — it is the single source of truth, so there is nothing
 * to keep in sync.
 */
export const workflowsTable = sqliteTable('workflows', {
  id: text('id').primaryKey(),
  /** Absolute path to the installed, content-addressed artifact folder. */
  source: text('source').notNull(),
  manifest: text('manifest', { mode: 'json' }).$type<WorkflowManifest>().notNull(),
  /** Hash of the artifact's sources at registration; runs record theirs to expose drift. */
  sourceHash: text('source_hash').notNull(),
  /**
   * Topology read off the compiled LangGraph at registration, for the
   * visualizer. Derived data: rows that predate it backfill empty and fill in
   * when the artifact is registered again.
   */
  graph: text('graph', { mode: 'json' }).$type<WorkflowGraph>().notNull().default({ nodes: [], edges: [] }),
  /** Manifest agent/workflow names resolved to concrete targets at registration. */
  bindings: text('bindings', { mode: 'json' }).$type<WorkflowBindings>().notNull().default({}),
  /** The revision currently deployed; see `workflowRevisionsTable`. */
  revision: integer('revision').notNull().default(1),
});

/**
 * Immutable workflow revisions. Each registration creates a new row;
 * `workflows.revision` points at the deployed one, so every manifest this
 * workflow ever ran under stays inspectable.
 */
export const workflowRevisionsTable = sqliteTable('workflow_revisions', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id').notNull(),
  revision: integer('revision').notNull(),
  source: text('source').notNull(),
  /** SHA-256 over the artifact's manifest and source files. */
  sourceHash: text('source_hash').notNull(),
  manifest: text('manifest', { mode: 'json' }).$type<WorkflowManifest>().notNull(),
  graph: text('graph', { mode: 'json' }).$type<WorkflowGraph>().notNull().default({ nodes: [], edges: [] }),
  bindings: text('bindings', { mode: 'json' }).$type<WorkflowBindings>().notNull().default({}),
  createdAt: integer('created_at').notNull(),
});

export const workflowRunsTable = sqliteTable(
  'workflow_runs',
  {
    id: text('id').primaryKey(),
    workflowId: text('workflow_id').notNull(),
    taskId: text('task_id').notNull(),
    contextId: text('context_id'),
    status: text('status').$type<WorkflowRunStatus>().notNull(),
    input: text('input').notNull(),
    output: text('output'),
    error: text('error'),
    /** Hash of the artifact sources actually executed, for drift detection. */
    sourceHash: text('source_hash'),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
  },
  (table) => [
    index('workflow_runs_workflow_started_idx').on(table.workflowId, table.startedAt),
    index('workflow_runs_task_idx').on(table.taskId),
    index('workflow_runs_task_context_idx').on(table.workflowId, table.taskId, table.contextId),
  ],
);

export const langgraphCheckpointsTable = sqliteTable(
  'langgraph_checkpoints',
  {
    threadId: text('thread_id').notNull(),
    checkpointNs: text('checkpoint_ns').notNull().default(''),
    checkpointId: text('checkpoint_id').notNull(),
    parentCheckpointId: text('parent_checkpoint_id'),
    checkpoint: text('checkpoint', { mode: 'json' }).$type<Json>().notNull(),
    metadata: text('metadata', { mode: 'json' }).$type<Json>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.checkpointNs, table.checkpointId] }),
    index('langgraph_checkpoints_thread_created_idx').on(table.threadId, table.checkpointNs, table.createdAt),
  ],
);

export const langgraphCheckpointWritesTable = sqliteTable(
  'langgraph_checkpoint_writes',
  {
    threadId: text('thread_id').notNull(),
    checkpointNs: text('checkpoint_ns').notNull().default(''),
    checkpointId: text('checkpoint_id').notNull(),
    taskId: text('task_id').notNull(),
    idx: integer('idx').notNull(),
    channel: text('channel').notNull(),
    value: text('value', { mode: 'json' }).$type<Json>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.checkpointNs, table.checkpointId, table.taskId, table.idx] }),
    index('langgraph_checkpoint_writes_checkpoint_idx').on(table.threadId, table.checkpointNs, table.checkpointId),
  ],
);

export const workflowPendingActionsTable = sqliteTable(
  'workflow_pending_actions',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    taskId: text('task_id').notNull(),
    contextId: text('context_id').notNull(),
    stepId: text('step_id').notNull(),
    kind: text('kind', { enum: ['human-input'] }).notNull(),
    status: text('status').$type<WorkflowPendingActionStatus>().notNull(),
    request: text('request', { mode: 'json' }).$type<JsonObject>().notNull(),
    response: text('response', { mode: 'json' }).$type<JsonObject>(),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (table) => [
    index('workflow_pending_actions_task_idx').on(table.workflowId, table.taskId, table.contextId, table.status),
    index('workflow_pending_actions_run_idx').on(table.runId, table.status),
  ],
);

export const workflowToolCallsTable = sqliteTable(
  'workflow_tool_calls',
  {
    runId: text('run_id').notNull(),
    stepId: text('step_id').notNull(),
    codeHash: text('code_hash').notNull(),
    dispatchSeq: integer('dispatch_seq').notNull(),
    completionSeq: integer('completion_seq'),
    path: text('path').notNull(),
    argsHash: text('args_hash').notNull(),
    status: text('status', { enum: ['pending-approval', 'completed'] }).notNull(),
    approvalId: text('approval_id'),
    result: text('result', { mode: 'json' }).$type<Json>(),
    createdAt: text('created_at').notNull(),
    completedAt: text('completed_at'),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.stepId, table.codeHash, table.dispatchSeq] }),
    index('workflow_tool_calls_approval_idx').on(table.approvalId),
    index('workflow_tool_calls_run_step_idx').on(table.runId, table.stepId),
  ],
);

/**
 * One row per step a run executed. Steps are discovered as the artifact runs —
 * there is no static graph to enumerate them from — so rows are upserted on
 * first sight. Manifest-declared steps are seeded as `pending` at run creation.
 */
export const workflowStepsTable = sqliteTable(
  'workflow_steps',
  {
    runId: text('run_id').notNull(),
    /** The LangGraph node or `task()` name the artifact used. */
    stepId: text('step_id').notNull(),
    label: text('label').notNull(),
    status: text('status').$type<WorkflowStepRunStatus>().notNull(),
    input: text('input'),
    output: text('output'),
    error: text('error'),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
  },
  (table) => [primaryKey({ columns: [table.runId, table.stepId] }), index('workflow_steps_run_idx').on(table.runId)],
);

export const workflowRunEventsTable = sqliteTable(
  'workflow_run_events',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    taskId: text('task_id').notNull(),
    eventType: text('event_type').notNull(),
    stepId: text('step_id'),
    timestamp: text('timestamp').notNull(),
    event: text('event', { mode: 'json' }).$type<WorkflowRunEvent>().notNull(),
  },
  (table) => [
    index('workflow_run_events_run_timestamp_idx').on(table.runId, table.timestamp),
    index('workflow_run_events_workflow_timestamp_idx').on(table.workflowId, table.timestamp),
    index('workflow_run_events_step_idx').on(table.runId, table.stepId),
  ],
);

export const triggersTable = sqliteTable(
  'triggers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    targetKind: text('target_kind', { enum: ['agent', 'workflow'] }).notNull(),
    targetId: text('target_id').notNull(),
    taskTemplate: text('task_template', { mode: 'json' }).$type<TriggerTaskTemplate>().notNull(),
    specType: text('spec_type', { enum: ['schedule', 'webhook', 'email'] }).notNull(),
    spec: text('spec', { mode: 'json' }).$type<TriggerSpec>().notNull(),
    nextRunAt: text('next_run_at'),
    lastRunAt: text('last_run_at'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('triggers_due_idx').on(table.specType, table.enabled, table.nextRunAt)],
);

export const triggerFiringsTable = sqliteTable(
  'trigger_firings',
  {
    id: text('id').primaryKey(),
    triggerId: text('trigger_id').notNull(),
    taskId: text('task_id').notNull(),
    source: text('source', { enum: ['schedule', 'webhook', 'email'] }).notNull(),
    status: text('status', { enum: ['dispatched', 'failed'] }).notNull(),
    error: text('error'),
    firedAt: integer('fired_at').notNull(),
  },
  (table) => [index('trigger_firings_trigger_idx').on(table.triggerId, table.firedAt)],
);

/** Per-mailbox watermark for Microsoft Graph email polling. */
export const emailPollStateTable = sqliteTable('email_poll_state', {
  mailbox: text('mailbox').primaryKey(),
  /** ISO `receivedDateTime` of the most recently processed message. */
  watermark: text('watermark').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const channelAccountsTable = sqliteTable('channel_accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  platform: text('platform', { enum: ['discord', 'teams'] }).notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  credentials: text('credentials', { mode: 'json' })
    .$type<
      | {
          readonly platform: 'discord';
          readonly applicationId: string;
          readonly botToken: string;
          readonly publicKey?: string | undefined;
        }
      | {
          readonly platform: 'teams';
          readonly appId: string;
          readonly appPassword: string;
          readonly appType: 'MultiTenant' | 'SingleTenant';
          readonly tenantId?: string | undefined;
        }
    >()
    .notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const channelBindingsTable = sqliteTable(
  'channel_bindings',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    name: text('name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    targetKind: text('target_kind', { enum: ['agent', 'workflow'] }).notNull(),
    targetId: text('target_id').notNull(),
    match: text('match', { mode: 'json' }).$type<ChannelBindingMatch>().notNull(),
    requireMention: integer('require_mention', { mode: 'boolean' }).notNull(),
    allowedUserIds: text('allowed_user_ids', { mode: 'json' }).$type<ReadonlyArray<string>>().notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('channel_bindings_account_idx').on(table.accountId)],
);

/** Maps a platform conversation to the a2a context that continues it. */
export const channelThreadsTable = sqliteTable(
  'channel_threads',
  {
    accountId: text('account_id').notNull(),
    threadId: text('thread_id').notNull(),
    contextId: text('context_id').notNull(),
    targetKind: text('target_kind', { enum: ['agent', 'workflow'] }).notNull(),
    targetId: text('target_id').notNull(),
    /** Task waiting on user input in this conversation, if any. */
    pendingTaskId: text('pending_task_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.threadId] })],
);

/** Chat SDK `StateAdapter` storage; `scope` is the channel account id. */
export const channelStateSubscriptionsTable = sqliteTable(
  'channel_state_subscriptions',
  {
    scope: text('scope').notNull(),
    threadId: text('thread_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.threadId] })],
);

export const channelStateLocksTable = sqliteTable(
  'channel_state_locks',
  {
    scope: text('scope').notNull(),
    threadId: text('thread_id').notNull(),
    token: text('token').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.threadId] })],
);

export const channelStateEntriesTable = sqliteTable(
  'channel_state_entries',
  {
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at'),
  },
  (table) => [primaryKey({ columns: [table.scope, table.key] })],
);

export const channelStateListItemsTable = sqliteTable(
  'channel_state_list_items',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at'),
  },
  (table) => [index('channel_state_list_items_key_idx').on(table.scope, table.key, table.seq)],
);

export const channelStateQueueItemsTable = sqliteTable(
  'channel_state_queue_items',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    scope: text('scope').notNull(),
    threadId: text('thread_id').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [index('channel_state_queue_items_thread_idx').on(table.scope, table.threadId, table.seq)],
);

export const agentCommunicationRulesTable = sqliteTable(
  'agent_communication_rules',
  {
    sourceAgentId: text('source_agent_id').notNull(),
    targetAgentId: text('target_agent_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.sourceAgentId, table.targetAgentId] })],
);

/**
 * General (protocol-independent) store for every agent run — protocol-originated
 * (via the `TaskStore` adapter in `packages/api/src/sessions/service.ts`),
 * workflow-node-originated, or direct SDK calls. Backs the SDK's
 * `AgentRunStore` service (see `packages/api/src/agents/run-store.ts`).
 * `originSurface`/`workflowId`/`workflowRunId`/`stepId`/`attempt` flatten the
 * `AgentRunOrigin` union; the latter four are only set for `workflow` origin.
 */
export const agentRunsTable = sqliteTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    contextId: text('context_id').notNull(),
    agentId: text('agent_id').notNull(),
    workflowId: text('workflow_id'),
    workflowRunId: text('workflow_run_id'),
    stepId: text('step_id'),
    originSurface: text('origin_surface', { enum: ['a2a', 'ag-ui', 'sdk', 'eval', 'delegation', 'workflow'] })
      .$type<AgentRunOrigin['surface']>()
      .notNull(),
    /** The calling agent's task for `delegation` runs. */
    parentTaskId: text('parent_task_id'),
    attempt: integer('attempt'),
    statusState: text('status_state').notNull(),
    statusTimestamp: text('status_timestamp').notNull(),
    statusMessage: text('status_message', { mode: 'json' }).$type<AgentRunMessage>(),
    statusHistory: text('status_history', { mode: 'json' }).$type<ReadonlyArray<AgentRunStatusHistoryEntry>>(),
    history: text('history', { mode: 'json' }).$type<ReadonlyArray<AgentRunMessage>>().notNull(),
    artifacts: text('artifacts', { mode: 'json' }).$type<ReadonlyArray<AgentRunArtifact>>().notNull(),
    metadata: text('metadata', { mode: 'json' }).$type<JsonObject>(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('agent_runs_context_idx').on(table.contextId),
    index('agent_runs_agent_idx').on(table.agentId),
    index('agent_runs_workflow_run_idx').on(table.workflowRunId),
  ],
);

export const a2aContextMessagesTable = sqliteTable(
  'a2a_context_messages',
  {
    targetId: text('target_id').notNull(),
    branchId: text('branch_id').notNull(),
    contextId: text('context_id').notNull(),
    messageId: text('message_id').notNull(),
    messageIndex: integer('message_index').notNull(),
    message: text('message', { mode: 'json' }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.targetId, table.contextId, table.messageId] }),
    index('a2a_context_messages_target_context_idx').on(table.targetId, table.contextId, table.messageIndex),
    index('a2a_context_messages_branch_idx').on(table.branchId),
  ],
);

export const sessionsTable = sqliteTable(
  'sessions',
  {
    id: text('id').notNull(),
    orgId: text('org_id'),
    userId: text('user_id'),
    parentSessionId: text('parent_session_id'),
    activeBranchId: text('active_branch_id').notNull(),
    targetKind: text('target_kind', { enum: ['agent', 'workflow'] }).notNull(),
    targetId: text('target_id').notNull(),
    targetName: text('target_name').notNull(),
    title: text('title').notNull(),
    slug: text('slug'),
    metadata: text('metadata', { mode: 'json' }).$type<JsonObject>(),
    summary: text('summary', { mode: 'json' }).$type<SessionSummary>(),
    usage: text('usage', { mode: 'json' }).$type<Usage>(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    archivedAt: integer('archived_at'),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index('sessions_target_updated_idx').on(table.targetId, table.updatedAt),
    index('sessions_org_user_updated_idx').on(table.orgId, table.userId, table.updatedAt),
    index('sessions_parent_idx').on(table.parentSessionId),
    index('sessions_active_branch_idx').on(table.activeBranchId),
  ],
);

export const sessionBranchesTable = sqliteTable(
  'session_branches',
  {
    id: text('id').notNull(),
    sessionId: text('session_id').notNull(),
    contextId: text('context_id').notNull(),
    parentBranchId: text('parent_branch_id'),
    origin: text('origin', { enum: ['initial', 'edit-message', 'regenerate', 'fork-session'] }).notNull(),
    forkPoint: text('fork_point', { mode: 'json' }).$type<{
      readonly parentBranchId: string;
      readonly messageId?: string;
      readonly taskId?: string;
      readonly messageIndex: number;
    }>(),
    title: text('title'),
    metadata: text('metadata', { mode: 'json' }).$type<JsonObject>(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    archivedAt: integer('archived_at'),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index('session_branches_session_idx').on(table.sessionId),
    index('session_branches_context_idx').on(table.contextId),
    index('session_branches_parent_idx').on(table.parentBranchId),
  ],
);

export const gatewayPrincipalsTable = sqliteTable(
  'gateway_principals',
  {
    kind: text('kind', { enum: ['agent', 'workflow', 'platform'] }).notNull(),
    refId: text('ref_id').notNull(),
    clientId: text('client_id').notNull().unique(),
    accessProfileId: text('access_profile_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.kind, table.refId] })],
);

export const graphExecutionsTable = sqliteTable(
  'graph_executions',
  {
    id: text('id').primaryKey(),
    target: text('target').notNull(),
    threadId: text('thread_id').notNull(),
    contextId: text('context_id').notNull(),
    runtimeHash: text('runtime_hash').notNull(),
    deployment: text('deployment', { mode: 'json' }).$type<import('agentdock-sdk').GraphDeployment>().notNull(),
    message: text('message', { mode: 'json' }).$type<import('@a2a-js/sdk').Message>().notNull(),
    task: text('task', { mode: 'json' }).$type<import('@a2a-js/sdk').Task>(),
    status: text('status').$type<import('agentdock-sdk').GraphExecution['status']>().notNull(),
    owner: text('owner'),
    leaseUntil: integer('lease_until').notNull().default(0),
    cancelRequested: integer('cancel_requested', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    index('graph_executions_recovery_idx').on(table.status, table.leaseUntil),
    index('graph_executions_thread_idx').on(table.threadId),
  ],
);

export const graphExecutionEventsTable = sqliteTable(
  'graph_execution_events',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    requestId: text('request_id').notNull(),
    executionId: text('execution_id')
      .notNull()
      .references(() => graphExecutionsTable.id),
    event: text('event', { mode: 'json' }).$type<import('@a2a-js/sdk/server').AgentExecutionEvent>().notNull(),
  },
  (table) => [index('graph_execution_events_execution_idx').on(table.executionId, table.sequence)],
);

/**
 * Eval datasets and their cases. Cases are ordered by `position`, which is
 * also the order a run works through them. Deleting a dataset deletes its
 * cases in the same transaction; there are no foreign keys to cascade.
 */
export const evalDatasetsTable = sqliteTable('eval_datasets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  graderIds: text('grader_ids', { mode: 'json' }).$type<ReadonlyArray<string>>().notNull().default([]),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const evalCasesTable = sqliteTable(
  'eval_cases',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id').notNull(),
    position: integer('position').notNull(),
    input: text('input').notNull(),
    expected: text('expected'),
    metadata: text('metadata', { mode: 'json' }).$type<JsonObject>(),
    tags: text('tags', { mode: 'json' }).$type<ReadonlyArray<string>>().notNull().default([]),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('eval_cases_dataset_idx').on(table.datasetId, table.position)],
);

export const evalGradersTable = sqliteTable('eval_graders', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  config: text('config', { mode: 'json' }).$type<EvalGraderConfig>().notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * A run snapshots the dataset name, target and graders it started with, so
 * editing or deleting any of them later leaves its results readable.
 */
export const evalRunsTable = sqliteTable(
  'eval_runs',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    sourceRunId: text('source_run_id'),
    datasetId: text('dataset_id').notNull(),
    datasetName: text('dataset_name').notNull(),
    target: text('target', { mode: 'json' }).$type<EvalRunTarget>().notNull(),
    graders: text('graders', { mode: 'json' }).$type<ReadonlyArray<EvalGrader>>().notNull(),
    trials: integer('trials').notNull(),
    concurrency: integer('concurrency').notNull(),
    status: text('status').$type<EvalRunStatus>().notNull(),
    error: text('error'),
    trigger: text('trigger', { mode: 'json' }).$type<EvalRunTrigger>().notNull().default({ kind: 'manual' }),
    /** The previous finished run of the same dataset and target, which this one is compared with. */
    baselineRunId: text('baseline_run_id'),
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (table) => [
    index('eval_runs_created_idx').on(table.createdAt),
    index('eval_runs_dataset_idx').on(table.datasetId, table.createdAt),
  ],
);

/** One attempt at one case within a run; `position` orders cases, then attempts. */
export const evalTrialsTable = sqliteTable(
  'eval_trials',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    caseId: text('case_id').notNull(),
    position: integer('position').notNull(),
    trialIndex: integer('trial_index').notNull(),
    case: text('case', { mode: 'json' }).$type<EvalCaseSnapshot>().notNull(),
    status: text('status').$type<EvalTrialStatus>().notNull(),
    output: text('output', { mode: 'json' }).$type<EvalTrialOutput>(),
    error: text('error'),
    grades: text('grades', { mode: 'json' }).$type<ReadonlyArray<EvalGrade>>().notNull().default([]),
    passed: integer('passed', { mode: 'boolean' }),
    usage: text('usage', { mode: 'json' }).$type<EvalTargetUsage>(),
    review: text('review', { mode: 'json' }).$type<EvalReview>(),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
  },
  (table) => [
    index('eval_trials_run_idx').on(table.runId, table.position),
    index('eval_trials_status_idx').on(table.status),
  ],
);

/**
 * Regression gates: a dataset rerun against an agent whenever the agent's
 * watched settings change. `watched` holds those settings as of the gate's
 * last run (or its creation), so a mismatch with the live agent is a change
 * still to be evaluated, even one made while the server was down.
 */
export const evalGatesTable = sqliteTable(
  'eval_gates',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id').notNull(),
    agentId: text('agent_id').notNull(),
    graderIds: text('grader_ids', { mode: 'json' }).$type<ReadonlyArray<string>>().notNull(),
    tags: text('tags', { mode: 'json' }).$type<ReadonlyArray<string>>().notNull().default([]),
    trials: integer('trials').notNull(),
    concurrency: integer('concurrency').notNull(),
    caseLimit: integer('case_limit'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    watched: text('watched', { mode: 'json' }).$type<JsonObject>().notNull(),
    lastRunId: text('last_run_id'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('eval_gates_agent_idx').on(table.agentId)],
);
