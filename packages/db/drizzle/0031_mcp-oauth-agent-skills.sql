CREATE TABLE `mcp_oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_oauth_clients_client_id_unique` ON `mcp_oauth_clients` (`client_id`);--> statement-breakpoint
CREATE TABLE `mcp_oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `mcp_oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_oauth_grants_binding_idx` ON `mcp_oauth_grants` (`client_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `mcp_oauth_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`state` text,
	`code_challenge` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `mcp_oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mcp_oauth_tokens` (
	`hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`grant_id` text NOT NULL,
	`family_id` text NOT NULL,
	`redirect_uri` text,
	`code_challenge` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`grant_id`) REFERENCES `mcp_oauth_grants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mcp_oauth_tokens_family_idx` ON `mcp_oauth_tokens` (`family_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`created_by_user_id` text,
	`visibility` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`color` text DEFAULT '#2563eb' NOT NULL,
	`integrations` text DEFAULT '{}' NOT NULL,
	`skills` text DEFAULT '{}' NOT NULL,
	`communication` text NOT NULL,
	`model` text NOT NULL,
	`reasoning_effort` text,
	`instructions` text NOT NULL,
	`version` text NOT NULL,
	`capabilities` text NOT NULL,
	`default_input_modes` text NOT NULL,
	`default_output_modes` text NOT NULL,
	`input_contract` text,
	`output_contract` text,
	`revision` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_agents`("id", "org_id", "created_by_user_id", "visibility", "name", "description", "color", "integrations", "skills", "communication", "model", "reasoning_effort", "instructions", "version", "capabilities", "default_input_modes", "default_output_modes", "input_contract", "output_contract", "revision") SELECT "id", "org_id", "created_by_user_id", "visibility", "name", "description", "color", "integrations", (SELECT json_group_object("value", 'on-demand') FROM json_each("agents"."skill_ids")), "communication", "model", "reasoning_effort", "instructions", "version", "capabilities", "default_input_modes", "default_output_modes", "input_contract", "output_contract", "revision" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;