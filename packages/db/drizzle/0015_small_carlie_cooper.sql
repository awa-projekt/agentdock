CREATE TABLE `workflow_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`revision` integer NOT NULL,
	`content_hash` text NOT NULL,
	`graph` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `workflows` ADD `revision` integer DEFAULT 1 NOT NULL;