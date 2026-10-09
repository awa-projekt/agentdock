CREATE TABLE `channel_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`enabled` integer NOT NULL,
	`application_id` text NOT NULL,
	`bot_token` text NOT NULL,
	`public_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `channel_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`match` text NOT NULL,
	`require_mention` integer NOT NULL,
	`allowed_user_ids` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `channel_bindings_account_idx` ON `channel_bindings` (`account_id`);--> statement-breakpoint
CREATE TABLE `channel_state_entries` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer,
	PRIMARY KEY(`scope`, `key`)
);
--> statement-breakpoint
CREATE TABLE `channel_state_list_items` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `channel_state_list_items_key_idx` ON `channel_state_list_items` (`scope`,`key`,`seq`);--> statement-breakpoint
CREATE TABLE `channel_state_locks` (
	`scope` text NOT NULL,
	`thread_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `thread_id`)
);
--> statement-breakpoint
CREATE TABLE `channel_state_queue_items` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`thread_id` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `channel_state_queue_items_thread_idx` ON `channel_state_queue_items` (`scope`,`thread_id`,`seq`);--> statement-breakpoint
CREATE TABLE `channel_state_subscriptions` (
	`scope` text NOT NULL,
	`thread_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `thread_id`)
);
--> statement-breakpoint
CREATE TABLE `channel_threads` (
	`account_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`context_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`pending_task_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `thread_id`)
);
