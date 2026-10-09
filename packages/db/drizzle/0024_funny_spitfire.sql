CREATE TABLE `__new_channel_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`enabled` integer NOT NULL,
	`credentials` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_channel_accounts` (`id`, `name`, `platform`, `enabled`, `credentials`, `created_at`, `updated_at`)
SELECT
	`id`,
	`name`,
	`platform`,
	`enabled`,
	CASE
		WHEN `public_key` IS NULL THEN json_object(
			'platform', 'discord',
			'applicationId', `application_id`,
			'botToken', `bot_token`
		)
		ELSE json_object(
			'platform', 'discord',
			'applicationId', `application_id`,
			'botToken', `bot_token`,
			'publicKey', `public_key`
		)
	END,
	`created_at`,
	`updated_at`
FROM `channel_accounts`;--> statement-breakpoint
DROP TABLE `channel_accounts`;--> statement-breakpoint
ALTER TABLE `__new_channel_accounts` RENAME TO `channel_accounts`;--> statement-breakpoint
UPDATE `channel_bindings`
SET `match` = json_remove(json_set(`match`, '$.workspaceId', json_extract(`match`, '$.guildId')), '$.guildId')
WHERE json_type(`match`, '$.guildId') IS NOT NULL;
