ALTER TABLE `agents` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_revisions` ADD `bindings` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflows` ADD `bindings` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflows` DROP COLUMN `origin`;