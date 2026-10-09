CREATE TABLE `executor_integration_auth_policy` (
	`integration_id` text PRIMARY KEY NOT NULL,
	`auth_mode` text DEFAULT 'org' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
