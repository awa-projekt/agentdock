CREATE TABLE `workflow_tool_calls` (
	`run_id` text NOT NULL,
	`node_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`dispatch_seq` integer NOT NULL,
	`completion_seq` integer,
	`path` text NOT NULL,
	`args_hash` text NOT NULL,
	`status` text NOT NULL,
	`approval_action_id` text,
	`approval_status` text,
	`approval_content` text,
	`result` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	PRIMARY KEY(`run_id`, `node_id`, `code_hash`, `dispatch_seq`)
);
--> statement-breakpoint
CREATE INDEX `workflow_tool_calls_action_idx` ON `workflow_tool_calls` (`approval_action_id`);--> statement-breakpoint
CREATE INDEX `workflow_tool_calls_run_node_idx` ON `workflow_tool_calls` (`run_id`,`node_id`);