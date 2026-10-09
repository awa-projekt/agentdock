CREATE TABLE `eval_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset_id` text NOT NULL,
	`position` integer NOT NULL,
	`input` text NOT NULL,
	`expected` text,
	`metadata` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `eval_cases_dataset_idx` ON `eval_cases` (`dataset_id`,`position`);--> statement-breakpoint
CREATE TABLE `eval_datasets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`grader_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `eval_gates` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`grader_ids` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`trials` integer NOT NULL,
	`concurrency` integer NOT NULL,
	`case_limit` integer,
	`enabled` integer NOT NULL,
	`watched` text NOT NULL,
	`last_run_id` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `eval_gates_agent_idx` ON `eval_gates` (`agent_id`);--> statement-breakpoint
CREATE TABLE `eval_graders` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`config` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `eval_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source_run_id` text,
	`dataset_id` text NOT NULL,
	`dataset_name` text NOT NULL,
	`target` text NOT NULL,
	`graders` text NOT NULL,
	`trials` integer NOT NULL,
	`concurrency` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`trigger` text DEFAULT '{"kind":"manual"}' NOT NULL,
	`baseline_run_id` text,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `eval_runs_created_idx` ON `eval_runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `eval_runs_dataset_idx` ON `eval_runs` (`dataset_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `eval_trials` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`case_id` text NOT NULL,
	`position` integer NOT NULL,
	`trial_index` integer NOT NULL,
	`case` text NOT NULL,
	`status` text NOT NULL,
	`output` text,
	`error` text,
	`grades` text DEFAULT '[]' NOT NULL,
	`passed` integer,
	`usage` text,
	`review` text,
	`started_at` integer,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `eval_trials_run_idx` ON `eval_trials` (`run_id`,`position`);--> statement-breakpoint
CREATE INDEX `eval_trials_status_idx` ON `eval_trials` (`status`);