ALTER TABLE `drill_steps` ADD `repeat_seconds` integer;--> statement-breakpoint
ALTER TABLE `drill_steps` ADD `repeat_for_seconds` integer;--> statement-breakpoint
ALTER TABLE `system_state` ADD `drill_step_ends_at` integer;--> statement-breakpoint
ALTER TABLE `system_state` ADD `drill_last_announced_at` integer;--> statement-breakpoint
ALTER TABLE `system_state` ADD `drill_announce_pending` integer DEFAULT false NOT NULL;