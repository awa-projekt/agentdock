CREATE TABLE `agent_native_tools` (
	`agent_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `tool_id`)
);
--> statement-breakpoint
CREATE TABLE `gateway_principals` (
	`kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`client_id` text NOT NULL,
	`access_profile_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `ref_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_principals_client_id_unique` ON `gateway_principals` (`client_id`);