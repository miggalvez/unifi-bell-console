CREATE TABLE `fob_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fob_mac` text NOT NULL,
	`button` text NOT NULL,
	`press_type` text NOT NULL,
	`action` text NOT NULL,
	`cue_id` integer,
	`repeat_seconds` integer,
	`is_enabled` integer DEFAULT true NOT NULL,
	`nvr_alarm_id` text,
	`token_hash` text,
	`desired_hash` text,
	`provision_state` text DEFAULT 'PENDING' NOT NULL,
	`provision_error` text,
	`last_triggered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`cue_id`) REFERENCES `sound_cues`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "fob_mapping_action_fields" CHECK((action = 'STOP_ALERT' AND cue_id IS NULL)
        OR (action IN ('START_ALERT','TRIGGER_CUE') AND cue_id IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fob_mapping_slot_uniq` ON `fob_mappings` (`fob_mac`,`button`,`press_type`);--> statement-breakpoint
CREATE TABLE `fobs` (
	`mac` text PRIMARY KEY NOT NULL,
	`protect_id` text,
	`name` text,
	`state` text,
	`battery_status` text,
	`firmware_version` text,
	`last_seen_at` integer,
	`last_polled_at` integer,
	`raw` text
);
--> statement-breakpoint
ALTER TABLE `system_state` ADD `fob_reprovision_flag` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `system_state` ADD `fob_provision_lock_until` integer;--> statement-breakpoint
ALTER TABLE `system_state` ADD `fob_last_reconcile_at` integer;--> statement-breakpoint
ALTER TABLE `system_state` ADD `fob_last_reconcile_error` text;