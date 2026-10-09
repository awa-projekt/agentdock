DROP TABLE `agent_tool_credential_scopes`;--> statement-breakpoint
DROP TABLE `blob`;--> statement-breakpoint
DROP TABLE `connection`;--> statement-breakpoint
DROP TABLE `credential_binding`;--> statement-breakpoint
DROP TABLE `definition`;--> statement-breakpoint
DROP TABLE `executor_integration_auth_policy`;--> statement-breakpoint
DROP TABLE `executor_native_tool`;--> statement-breakpoint
DROP TABLE `google_discovery_binding`;--> statement-breakpoint
DROP TABLE `google_discovery_source`;--> statement-breakpoint
DROP TABLE `google_discovery_source_credential_header`;--> statement-breakpoint
DROP TABLE `google_discovery_source_credential_query_param`;--> statement-breakpoint
DROP TABLE `graphql_operation`;--> statement-breakpoint
DROP TABLE `graphql_source`;--> statement-breakpoint
DROP TABLE `graphql_source_header`;--> statement-breakpoint
DROP TABLE `graphql_source_query_param`;--> statement-breakpoint
DROP TABLE `mcp_binding`;--> statement-breakpoint
DROP TABLE `mcp_source`;--> statement-breakpoint
DROP TABLE `mcp_source_header`;--> statement-breakpoint
DROP TABLE `mcp_source_query_param`;--> statement-breakpoint
DROP TABLE `oauth2_session`;--> statement-breakpoint
DROP TABLE `openapi_operation`;--> statement-breakpoint
DROP TABLE `openapi_source`;--> statement-breakpoint
DROP TABLE `openapi_source_header`;--> statement-breakpoint
DROP TABLE `openapi_source_query_param`;--> statement-breakpoint
DROP TABLE `openapi_source_spec_fetch_header`;--> statement-breakpoint
DROP TABLE `openapi_source_spec_fetch_query_param`;--> statement-breakpoint
DROP TABLE `secret`;--> statement-breakpoint
DROP TABLE `source`;--> statement-breakpoint
DROP TABLE `tool`;--> statement-breakpoint
DROP TABLE `tool_policy`;--> statement-breakpoint
DROP INDEX `workflow_tool_calls_action_idx`;--> statement-breakpoint
ALTER TABLE `workflow_tool_calls` ADD `approval_id` text;--> statement-breakpoint
CREATE INDEX `workflow_tool_calls_approval_idx` ON `workflow_tool_calls` (`approval_id`);--> statement-breakpoint
ALTER TABLE `workflow_tool_calls` DROP COLUMN `approval_action_id`;--> statement-breakpoint
ALTER TABLE `workflow_tool_calls` DROP COLUMN `approval_status`;--> statement-breakpoint
ALTER TABLE `workflow_tool_calls` DROP COLUMN `approval_content`;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `credential_config`;