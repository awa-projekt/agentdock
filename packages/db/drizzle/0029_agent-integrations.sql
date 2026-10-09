DROP TABLE `agent_native_tools`;--> statement-breakpoint
ALTER TABLE `agents` ADD `integrations` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `tools`;