CREATE TABLE `graph_execution_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`execution_id` text NOT NULL,
	`event` text NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `graph_executions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `graph_execution_events_execution_idx` ON `graph_execution_events` (`execution_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `graph_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`target` text NOT NULL,
	`thread_id` text NOT NULL,
	`context_id` text NOT NULL,
	`runtime_hash` text NOT NULL,
	`deployment` text NOT NULL,
	`message` text NOT NULL,
	`task` text,
	`status` text NOT NULL,
	`owner` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`cancel_requested` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `graph_executions_recovery_idx` ON `graph_executions` (`status`,`lease_until`);--> statement-breakpoint
CREATE INDEX `graph_executions_thread_idx` ON `graph_executions` (`thread_id`);--> statement-breakpoint
DROP TABLE `agent_langgraph_checkpoint_writes`;--> statement-breakpoint
DROP TABLE `agent_langgraph_checkpoints`;--> statement-breakpoint
ALTER TABLE `workflows` ADD `origin` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `harness`;