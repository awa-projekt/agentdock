CREATE TABLE `a2a_context_messages` (
	`target_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`context_id` text NOT NULL,
	`message_id` text NOT NULL,
	`message_index` integer NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`target_id`, `context_id`, `message_id`)
);
--> statement-breakpoint
CREATE INDEX `a2a_context_messages_target_context_idx` ON `a2a_context_messages` (`target_id`,`context_id`,`message_index`);--> statement-breakpoint
CREATE INDEX `a2a_context_messages_branch_idx` ON `a2a_context_messages` (`branch_id`);--> statement-breakpoint
CREATE TABLE `a2a_tasks` (
	`target_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`task_id` text NOT NULL,
	`context_id` text NOT NULL,
	`task` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`target_id`, `task_id`)
);
--> statement-breakpoint
CREATE INDEX `a2a_tasks_target_context_idx` ON `a2a_tasks` (`target_id`,`context_id`);--> statement-breakpoint
CREATE INDEX `a2a_tasks_branch_idx` ON `a2a_tasks` (`branch_id`);--> statement-breakpoint
CREATE INDEX `a2a_tasks_target_updated_idx` ON `a2a_tasks` (`target_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `agent_communication_rules` (
	`source_agent_id` text NOT NULL,
	`target_agent_id` text NOT NULL,
	PRIMARY KEY(`source_agent_id`, `target_agent_id`)
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`visibility` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`tools` text NOT NULL,
	`skill_ids` text NOT NULL,
	`communication` text NOT NULL,
	`model` text NOT NULL,
	`instructions` text NOT NULL,
	`version` text NOT NULL,
	`capabilities` text NOT NULL,
	`default_input_modes` text NOT NULL,
	`default_output_modes` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `blob` (
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`namespace`, `key`)
);
--> statement-breakpoint
CREATE TABLE `connection` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`provider` text NOT NULL,
	`identity_label` text,
	`access_token_secret_id` text NOT NULL,
	`refresh_token_secret_id` text,
	`expires_at` integer,
	`scope` text,
	`provider_state` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `connection_scope_id_idx` ON `connection` (`scope_id`);--> statement-breakpoint
CREATE INDEX `connection_provider_idx` ON `connection` (`provider`);--> statement-breakpoint
CREATE TABLE `credential_binding` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`source_id` text NOT NULL,
	`source_scope_id` text NOT NULL,
	`slot_key` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`secret_id` text,
	`secret_scope_id` text,
	`connection_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `credential_binding_scope_id_idx` ON `credential_binding` (`scope_id`);--> statement-breakpoint
CREATE INDEX `credential_binding_plugin_id_idx` ON `credential_binding` (`plugin_id`);--> statement-breakpoint
CREATE INDEX `credential_binding_source_id_idx` ON `credential_binding` (`source_id`);--> statement-breakpoint
CREATE INDEX `credential_binding_source_scope_id_idx` ON `credential_binding` (`source_scope_id`);--> statement-breakpoint
CREATE INDEX `credential_binding_slot_key_idx` ON `credential_binding` (`slot_key`);--> statement-breakpoint
CREATE INDEX `credential_binding_kind_idx` ON `credential_binding` (`kind`);--> statement-breakpoint
CREATE INDEX `credential_binding_secret_id_idx` ON `credential_binding` (`secret_id`);--> statement-breakpoint
CREATE INDEX `credential_binding_secret_scope_id_idx` ON `credential_binding` (`secret_scope_id`);--> statement-breakpoint
CREATE INDEX `credential_binding_connection_id_idx` ON `credential_binding` (`connection_id`);--> statement-breakpoint
CREATE TABLE `custom_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `definition` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`name` text NOT NULL,
	`schema` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `definition_scope_id_idx` ON `definition` (`scope_id`);--> statement-breakpoint
CREATE INDEX `definition_source_id_idx` ON `definition` (`source_id`);--> statement-breakpoint
CREATE INDEX `definition_plugin_id_idx` ON `definition` (`plugin_id`);--> statement-breakpoint
CREATE TABLE `email_poll_state` (
	`mailbox` text PRIMARY KEY NOT NULL,
	`watermark` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `executor_pinned_tool` (
	`agent_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `tool_id`)
);
--> statement-breakpoint
CREATE TABLE `external_a2a_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`visibility` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`endpoint_url` text NOT NULL,
	`version` text NOT NULL,
	`capabilities` text NOT NULL,
	`default_input_modes` text NOT NULL,
	`default_output_modes` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_a2a_agents_endpoint_url_unique` ON `external_a2a_agents` (`endpoint_url`);--> statement-breakpoint
CREATE TABLE `google_discovery_binding` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`binding` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `google_discovery_binding_source_id_idx` ON `google_discovery_binding` (`source_id`);--> statement-breakpoint
CREATE TABLE `google_discovery_source` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`auth_kind` text DEFAULT 'none' NOT NULL,
	`auth_connection_id` text,
	`auth_client_id_secret_id` text,
	`auth_client_secret_secret_id` text,
	`auth_scopes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `google_discovery_source_scope_id_idx` ON `google_discovery_source` (`scope_id`);--> statement-breakpoint
CREATE TABLE `google_discovery_source_credential_header` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`secret_id` text,
	`secret_prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `google_discovery_source_credential_header_source_id_idx` ON `google_discovery_source_credential_header` (`source_id`);--> statement-breakpoint
CREATE TABLE `google_discovery_source_credential_query_param` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`secret_id` text,
	`secret_prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `google_discovery_source_credential_query_param_source_id_idx` ON `google_discovery_source_credential_query_param` (`source_id`);--> statement-breakpoint
CREATE TABLE `graphql_operation` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`binding` text NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `graphql_operation_source_id_idx` ON `graphql_operation` (`source_id`);--> statement-breakpoint
CREATE TABLE `graphql_source` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`endpoint` text NOT NULL,
	`auth_kind` text DEFAULT 'none' NOT NULL,
	`auth_connection_slot` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `graphql_source_scope_id_idx` ON `graphql_source` (`scope_id`);--> statement-breakpoint
CREATE TABLE `graphql_source_header` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`slot_key` text,
	`prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `graphql_source_header_source_id_idx` ON `graphql_source_header` (`source_id`);--> statement-breakpoint
CREATE TABLE `graphql_source_query_param` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`slot_key` text,
	`prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `graphql_source_query_param_source_id_idx` ON `graphql_source_query_param` (`source_id`);--> statement-breakpoint
CREATE TABLE `mcp_binding` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`binding` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `mcp_binding_scope_id_idx` ON `mcp_binding` (`scope_id`);--> statement-breakpoint
CREATE INDEX `mcp_binding_source_id_idx` ON `mcp_binding` (`source_id`);--> statement-breakpoint
CREATE TABLE `mcp_source` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`auth_kind` text DEFAULT 'none' NOT NULL,
	`auth_header_name` text,
	`auth_header_slot` text,
	`auth_header_prefix` text,
	`auth_connection_slot` text,
	`auth_client_id_slot` text,
	`auth_client_secret_slot` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `mcp_source_scope_id_idx` ON `mcp_source` (`scope_id`);--> statement-breakpoint
CREATE TABLE `mcp_source_header` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`slot_key` text,
	`prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `mcp_source_header_scope_id_idx` ON `mcp_source_header` (`scope_id`);--> statement-breakpoint
CREATE INDEX `mcp_source_header_source_id_idx` ON `mcp_source_header` (`source_id`);--> statement-breakpoint
CREATE TABLE `mcp_source_query_param` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`slot_key` text,
	`prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `mcp_source_query_param_scope_id_idx` ON `mcp_source_query_param` (`scope_id`);--> statement-breakpoint
CREATE INDEX `mcp_source_query_param_source_id_idx` ON `mcp_source_query_param` (`source_id`);--> statement-breakpoint
CREATE TABLE `oauth2_session` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`strategy` text NOT NULL,
	`connection_id` text NOT NULL,
	`token_scope` text NOT NULL,
	`redirect_url` text NOT NULL,
	`payload` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `oauth2_session_scope_id_idx` ON `oauth2_session` (`scope_id`);--> statement-breakpoint
CREATE INDEX `oauth2_session_plugin_id_idx` ON `oauth2_session` (`plugin_id`);--> statement-breakpoint
CREATE INDEX `oauth2_session_connection_id_idx` ON `oauth2_session` (`connection_id`);--> statement-breakpoint
CREATE TABLE `openapi_operation` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`binding` text NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `openapi_operation_source_id_idx` ON `openapi_operation` (`source_id`);--> statement-breakpoint
CREATE TABLE `openapi_source` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`spec` text NOT NULL,
	`source_url` text,
	`base_url` text,
	`oauth2` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `openapi_source_scope_id_idx` ON `openapi_source` (`scope_id`);--> statement-breakpoint
CREATE TABLE `openapi_source_header` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`slot_key` text,
	`prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `openapi_source_header_source_id_idx` ON `openapi_source_header` (`source_id`);--> statement-breakpoint
CREATE TABLE `openapi_source_query_param` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`slot_key` text,
	`prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `openapi_source_query_param_source_id_idx` ON `openapi_source_query_param` (`source_id`);--> statement-breakpoint
CREATE TABLE `openapi_source_spec_fetch_header` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`slot_key` text,
	`prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `openapi_source_spec_fetch_header_source_id_idx` ON `openapi_source_spec_fetch_header` (`source_id`);--> statement-breakpoint
CREATE TABLE `openapi_source_spec_fetch_query_param` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`slot_key` text,
	`prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `openapi_source_spec_fetch_query_param_source_id_idx` ON `openapi_source_spec_fetch_query_param` (`source_id`);--> statement-breakpoint
CREATE TABLE `provider_keys` (
	`provider` text PRIMARY KEY NOT NULL,
	`api_key` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `secret` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`owned_by_connection_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `secret_scope_id_idx` ON `secret` (`scope_id`);--> statement-breakpoint
CREATE INDEX `secret_provider_idx` ON `secret` (`provider`);--> statement-breakpoint
CREATE INDEX `secret_owned_by_connection_id_idx` ON `secret` (`owned_by_connection_id`);--> statement-breakpoint
CREATE TABLE `session_branches` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`context_id` text NOT NULL,
	`parent_branch_id` text,
	`origin` text NOT NULL,
	`fork_point` text,
	`title` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `session_branches_session_idx` ON `session_branches` (`session_id`);--> statement-breakpoint
CREATE INDEX `session_branches_context_idx` ON `session_branches` (`context_id`);--> statement-breakpoint
CREATE INDEX `session_branches_parent_idx` ON `session_branches` (`parent_branch_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_session_id` text,
	`active_branch_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`target_name` text NOT NULL,
	`title` text NOT NULL,
	`slug` text,
	`metadata` text,
	`summary` text,
	`usage` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `sessions_target_updated_idx` ON `sessions` (`target_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `sessions_parent_idx` ON `sessions` (`parent_session_id`);--> statement-breakpoint
CREATE INDEX `sessions_active_branch_idx` ON `sessions` (`active_branch_id`);--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`content` text NOT NULL,
	`license` text,
	`compatibility` text,
	`allowed_tools` text,
	`source` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_name_unique` ON `skills` (`name`);--> statement-breakpoint
CREATE TABLE `source` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`url` text,
	`can_remove` integer DEFAULT true NOT NULL,
	`can_refresh` integer DEFAULT false NOT NULL,
	`can_edit` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `source_scope_id_idx` ON `source` (`scope_id`);--> statement-breakpoint
CREATE INDEX `source_plugin_id_idx` ON `source` (`plugin_id`);--> statement-breakpoint
CREATE TABLE `tool` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`input_schema` text,
	`output_schema` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `tool_scope_id_idx` ON `tool` (`scope_id`);--> statement-breakpoint
CREATE INDEX `tool_source_id_idx` ON `tool` (`source_id`);--> statement-breakpoint
CREATE INDEX `tool_plugin_id_idx` ON `tool` (`plugin_id`);--> statement-breakpoint
CREATE TABLE `tool_policy` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`pattern` text NOT NULL,
	`action` text NOT NULL,
	`position` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `tool_policy_scope_id_position_idx` ON `tool_policy` (`scope_id`,`position`);--> statement-breakpoint
CREATE TABLE `trigger_firings` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger_id` text NOT NULL,
	`task_id` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`fired_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trigger_firings_trigger_idx` ON `trigger_firings` (`trigger_id`,`fired_at`);--> statement-breakpoint
CREATE TABLE `triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`task_template` text NOT NULL,
	`spec_type` text NOT NULL,
	`spec` text NOT NULL,
	`next_run_at` text,
	`last_run_at` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `triggers_due_idx` ON `triggers` (`spec_type`,`enabled`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `workflow_node_runs` (
	`run_id` text NOT NULL,
	`node_id` text NOT NULL,
	`node_type` text NOT NULL,
	`label` text NOT NULL,
	`status` text NOT NULL,
	`input` text,
	`output` text,
	`error` text,
	`selected_branch` text,
	`started_at` text,
	`completed_at` text,
	PRIMARY KEY(`run_id`, `node_id`)
);
--> statement-breakpoint
CREATE INDEX `workflow_node_runs_run_idx` ON `workflow_node_runs` (`run_id`);--> statement-breakpoint
CREATE TABLE `workflow_pending_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`task_id` text NOT NULL,
	`context_id` text NOT NULL,
	`node_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`request` text NOT NULL,
	`response` text,
	`created_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE INDEX `workflow_pending_actions_task_idx` ON `workflow_pending_actions` (`workflow_id`,`task_id`,`context_id`,`status`);--> statement-breakpoint
CREATE INDEX `workflow_pending_actions_run_idx` ON `workflow_pending_actions` (`run_id`,`status`);--> statement-breakpoint
CREATE TABLE `workflow_run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`task_id` text NOT NULL,
	`event_type` text NOT NULL,
	`node_id` text,
	`timestamp` text NOT NULL,
	`event` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workflow_run_events_run_timestamp_idx` ON `workflow_run_events` (`run_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `workflow_run_events_workflow_timestamp_idx` ON `workflow_run_events` (`workflow_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `workflow_run_events_node_idx` ON `workflow_run_events` (`run_id`,`node_id`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`task_id` text NOT NULL,
	`context_id` text,
	`status` text NOT NULL,
	`input` text NOT NULL,
	`checkpoint` text,
	`output` text,
	`error` text,
	`started_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_workflow_started_idx` ON `workflow_runs` (`workflow_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `workflow_runs_task_idx` ON `workflow_runs` (`task_id`);--> statement-breakpoint
CREATE INDEX `workflow_runs_task_context_idx` ON `workflow_runs` (`workflow_id`,`task_id`,`context_id`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`version` text NOT NULL,
	`graph` text NOT NULL
);
