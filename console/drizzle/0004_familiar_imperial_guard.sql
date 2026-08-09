CREATE TABLE `drill_sequences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`is_enabled` integer DEFAULT true NOT NULL,
	`created_by` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drill_sequences_name_unique` ON `drill_sequences` (`name`);--> statement-breakpoint
CREATE TABLE `drill_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sequence_id` integer NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`cue_id` integer,
	`wait_seconds` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sequence_id`) REFERENCES `drill_sequences`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cue_id`) REFERENCES `sound_cues`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "drill_step_kind_fields" CHECK((kind = 'PLAY' AND cue_id IS NOT NULL)
        OR (kind = 'WAIT' AND wait_seconds IS NOT NULL AND wait_seconds > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drill_step_position_uniq` ON `drill_steps` (`sequence_id`,`position`);--> statement-breakpoint
ALTER TABLE `system_state` ADD `drill_sequence_id` integer REFERENCES drill_sequences(id);--> statement-breakpoint
ALTER TABLE `system_state` ADD `drill_started_at` integer;--> statement-breakpoint
ALTER TABLE `system_state` ADD `drill_started_by` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `system_state` ADD `drill_step_index` integer;--> statement-breakpoint
ALTER TABLE `system_state` ADD `drill_next_step_at` integer;--> statement-breakpoint
ALTER TABLE `system_state` ADD `drill_until` integer;--> statement-breakpoint
-- Every drill opens with this, and it cannot be removed from a sequence. A
-- lockdown tone with no warning in front of it is the one failure mode a
-- drill feature must make structurally impossible. Admins may point the
-- `drillPreambleCueId` setting at their own recording instead, but not at
-- nothing. 'neutral' is deliberate: only 'welcome' and 'neutral' are accepted
-- by Protect (see lib/protect/tones.ts).
INSERT OR IGNORE INTO `sound_cues`
  (`name`, `description`, `delivery_method`, `tts_text`, `tts_tone`,
   `is_emergency`, `is_enabled`, `sort_order`, `created_at`, `updated_at`)
VALUES
  ('Drill preamble',
   'Played automatically at the start of every drill. Cannot be removed.',
   'PROTECT_NATIVE_TTS',
   'This is a drill. This is only a drill.',
   'neutral', 0, 1, -1, unixepoch() * 1000, unixepoch() * 1000);
