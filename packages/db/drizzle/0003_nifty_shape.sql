CREATE TABLE `a2a_task_workflow_runs` (
	`target_id` text NOT NULL,
	`task_id` text NOT NULL,
	`workflow_run_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`target_id`, `task_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `a2a_task_workflow_runs_workflow_run_idx` ON `a2a_task_workflow_runs` (`workflow_run_id`);