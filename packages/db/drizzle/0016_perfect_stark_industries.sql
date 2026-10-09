-- Code workflows replace the node-graph DSL.
--
-- Graph definitions cannot be expressed as artifact folders, so `workflows` and
-- `workflow_revisions` are rebuilt empty and their dependent run history is
-- cleared. Everything that survives the change (`agent_runs`,
-- `workflow_tool_calls`, `workflow_run_events`) keeps its rows via column
-- renames.

-- Step records: node runs become steps, discovered at runtime rather than
-- enumerated from a graph, so there is nothing to carry over.
DROP TABLE `workflow_node_runs`;--> statement-breakpoint
CREATE TABLE `workflow_steps` (
	`run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`label` text NOT NULL,
	`status` text NOT NULL,
	`input` text,
	`output` text,
	`error` text,
	`started_at` text,
	`completed_at` text,
	PRIMARY KEY(`run_id`, `step_id`)
);
--> statement-breakpoint
CREATE INDEX `workflow_steps_run_idx` ON `workflow_steps` (`run_id`);--> statement-breakpoint

-- Column renames: SQLite rewrites primary-key and index references itself, so
-- these preserve every existing row.
DROP INDEX `workflow_run_events_node_idx`;--> statement-breakpoint
ALTER TABLE `workflow_run_events` RENAME COLUMN `node_id` TO `step_id`;--> statement-breakpoint
CREATE INDEX `workflow_run_events_step_idx` ON `workflow_run_events` (`run_id`,`step_id`);--> statement-breakpoint

DROP INDEX `workflow_tool_calls_run_node_idx`;--> statement-breakpoint
ALTER TABLE `workflow_tool_calls` RENAME COLUMN `node_id` TO `step_id`;--> statement-breakpoint
CREATE INDEX `workflow_tool_calls_run_step_idx` ON `workflow_tool_calls` (`run_id`,`step_id`);--> statement-breakpoint

ALTER TABLE `agent_runs` RENAME COLUMN `node_id` TO `step_id`;--> statement-breakpoint
ALTER TABLE `workflow_pending_actions` RENAME COLUMN `node_id` TO `step_id`;--> statement-breakpoint

-- Runs of graph workflows reference definitions that no longer exist.
DELETE FROM `workflow_run_events`;--> statement-breakpoint
DELETE FROM `workflow_pending_actions`;--> statement-breakpoint
DELETE FROM `workflow_tool_calls`;--> statement-breakpoint
DELETE FROM `workflow_runs`;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `source_hash` text;--> statement-breakpoint

-- Definition tables: rebuilt, not migrated. A graph has no artifact folder to
-- point `source` at, so the NOT NULL columns could not be backfilled.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TABLE `workflow_revisions`;--> statement-breakpoint
CREATE TABLE `workflow_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`revision` integer NOT NULL,
	`source` text NOT NULL,
	`source_hash` text NOT NULL,
	`manifest` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
DROP TABLE `workflows`;--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`manifest` text NOT NULL,
	`source_hash` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
