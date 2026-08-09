ALTER TABLE `system_state` ADD `alert_cue_id` integer REFERENCES sound_cues(id);--> statement-breakpoint
ALTER TABLE `system_state` ADD `alert_started_at` integer;--> statement-breakpoint
ALTER TABLE `system_state` ADD `alert_started_by` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `system_state` ADD `alert_repeat_seconds` integer;--> statement-breakpoint
ALTER TABLE `system_state` ADD `alert_until` integer;--> statement-breakpoint
ALTER TABLE `system_state` ADD `alert_last_played_at` integer;