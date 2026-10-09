CREATE TABLE `agent_tool_credential_scopes` (
	`agent_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`credential_owner` text NOT NULL,
	`required_scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `target_kind`, `target_id`)
);
--> statement-breakpoint
CREATE INDEX `agent_tool_credential_scopes_agent_idx` ON `agent_tool_credential_scopes` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_tool_credential_scopes_target_idx` ON `agent_tool_credential_scopes` (`target_kind`,`target_id`);--> statement-breakpoint
CREATE TABLE `orgs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`external_subject_id` text NOT NULL,
	`role` text NOT NULL,
	`email` text,
	`display_name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `users_org_idx` ON `users` (`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_external_subject_idx` ON `users` (`org_id`,`external_subject_id`);--> statement-breakpoint
ALTER TABLE `agents` ADD `org_id` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `created_by_user_id` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `credential_config` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `org_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `user_id` text;--> statement-breakpoint
CREATE INDEX `sessions_org_user_updated_idx` ON `sessions` (`org_id`,`user_id`,`updated_at`);
