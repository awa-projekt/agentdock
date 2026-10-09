CREATE TABLE `agent_langgraph_checkpoint_writes` (
	`thread_id` text NOT NULL,
	`checkpoint_ns` text DEFAULT '' NOT NULL,
	`checkpoint_id` text NOT NULL,
	`task_id` text NOT NULL,
	`idx` integer NOT NULL,
	`channel` text NOT NULL,
	`value` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`thread_id`, `checkpoint_ns`, `checkpoint_id`, `task_id`, `idx`)
);
--> statement-breakpoint
CREATE INDEX `agent_langgraph_checkpoint_writes_checkpoint_idx` ON `agent_langgraph_checkpoint_writes` (`thread_id`,`checkpoint_ns`,`checkpoint_id`);--> statement-breakpoint
CREATE TABLE `agent_langgraph_checkpoints` (
	`thread_id` text NOT NULL,
	`checkpoint_ns` text DEFAULT '' NOT NULL,
	`checkpoint_id` text NOT NULL,
	`parent_checkpoint_id` text,
	`checkpoint` text NOT NULL,
	`metadata` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`thread_id`, `checkpoint_ns`, `checkpoint_id`)
);
--> statement-breakpoint
CREATE INDEX `agent_langgraph_checkpoints_thread_created_idx` ON `agent_langgraph_checkpoints` (`thread_id`,`checkpoint_ns`,`created_at`);