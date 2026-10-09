CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`context_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`workflow_id` text,
	`workflow_run_id` text,
	`node_id` text,
	`origin_surface` text NOT NULL,
	`attempt` integer,
	`status_state` text NOT NULL,
	`status_timestamp` text NOT NULL,
	`status_message` text,
	`history` text NOT NULL,
	`artifacts` text NOT NULL,
	`metadata` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_runs_context_idx` ON `agent_runs` (`context_id`);--> statement-breakpoint
CREATE INDEX `agent_runs_agent_idx` ON `agent_runs` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_runs_workflow_run_idx` ON `agent_runs` (`workflow_run_id`);