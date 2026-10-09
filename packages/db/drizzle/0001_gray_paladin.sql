ALTER TABLE `custom_providers` ADD `query_params` text;--> statement-breakpoint
ALTER TABLE `custom_providers` ADD `kind` text DEFAULT 'openai-compatible' NOT NULL;