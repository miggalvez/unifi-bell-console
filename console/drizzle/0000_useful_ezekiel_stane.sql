CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`user_id` integer,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`is_emergency` integer DEFAULT false NOT NULL,
	`detail` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_emergency_idx` ON `audit_log` (`is_emergency`);--> statement-breakpoint
CREATE TABLE `bell_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bell_plan_id` integer NOT NULL,
	`time` text NOT NULL,
	`cue_id` integer NOT NULL,
	`label` text,
	`is_enabled` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`bell_plan_id`) REFERENCES `bell_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cue_id`) REFERENCES `sound_cues`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `bell_events_plan_idx` ON `bell_events` (`bell_plan_id`);--> statement-breakpoint
CREATE TABLE `bell_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`is_archived` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bell_plans_name_unique` ON `bell_plans` (`name`);--> statement-breakpoint
CREATE TABLE `calendar_exceptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`type` text NOT NULL,
	`bell_plan_id` integer,
	`note` text,
	`created_by` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bell_plan_id`) REFERENCES `bell_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_exceptions_date_unique` ON `calendar_exceptions` (`date`);--> statement-breakpoint
CREATE TABLE `health_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`ok` integer NOT NULL,
	`latency_ms` real,
	`error` text,
	`speakers_online` integer,
	`speakers_total` integer
);
--> statement-breakpoint
CREATE INDEX `health_at_idx` ON `health_checks` (`at`);--> statement-breakpoint
CREATE TABLE `protect_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`seen_at` integer NOT NULL,
	`protect_version` text,
	`nvr_firmware` text,
	`speaker_firmware` text
);
--> statement-breakpoint
CREATE TABLE `scheduled_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`bell_event_id` integer,
	`cue_id` integer,
	`cue_name` text,
	`delivery_method` text NOT NULL,
	`webhook_id` text,
	`tts_text` text,
	`tts_tone` text,
	`target_macs` text,
	`scheduled_at_utc` integer NOT NULL,
	`local_date` text NOT NULL,
	`local_time` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`claimed_at` integer,
	`executed_at` integer,
	`http_status` integer,
	`latency_ms` real,
	`result_message` text,
	`requested_by` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bell_event_id`) REFERENCES `bell_events`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`cue_id`) REFERENCES `sound_cues`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_event_time_uniq` ON `scheduled_runs` (`bell_event_id`,`scheduled_at_utc`) WHERE bell_event_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `runs_claim_idx` ON `scheduled_runs` (`status`,`scheduled_at_utc`);--> statement-breakpoint
CREATE INDEX `runs_date_idx` ON `scheduled_runs` (`local_date`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sound_cues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`delivery_method` text NOT NULL,
	`webhook_id` text,
	`tts_text` text,
	`tts_tone` text DEFAULT 'welcome' NOT NULL,
	`zone_id` integer,
	`is_emergency` integer DEFAULT false NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`zone_id`) REFERENCES `zones`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "cue_method_fields" CHECK(("sound_cues"."delivery_method" = 'PROTECT_WEBHOOK' AND "sound_cues"."webhook_id" IS NOT NULL) OR ("sound_cues"."delivery_method" = 'PROTECT_NATIVE_TTS' AND "sound_cues"."tts_text" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sound_cues_name_unique` ON `sound_cues` (`name`);--> statement-breakpoint
CREATE TABLE `speakers` (
	`id` text PRIMARY KEY NOT NULL,
	`mac` text NOT NULL,
	`name` text,
	`state` text,
	`status` text,
	`volume` integer,
	`mic_volume` integer,
	`firmware_version` text,
	`last_seen_online_at` integer,
	`last_polled_at` integer,
	`raw` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `speakers_mac_unique` ON `speakers` (`mac`);--> statement-breakpoint
CREATE TABLE `system_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`paused_until` integer,
	`pause_reason` text,
	`paused_by` integer,
	`paused_at` integer,
	`tts_revalidate_flag` integer DEFAULT false NOT NULL,
	`tts_flag_reason` text,
	`last_health_ok_at` integer,
	`last_health_error` text,
	`consecutive_health_failures` integer DEFAULT 0 NOT NULL,
	`using_cloud_fallback` integer DEFAULT false NOT NULL,
	`api_key_expires_at` integer,
	`last_materialized_through` text,
	FOREIGN KEY (`paused_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "system_state_singleton" CHECK("system_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'STAFF' NOT NULL,
	`can_emergency` integer DEFAULT false NOT NULL,
	`is_disabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `week_schedule` (
	`day_of_week` integer PRIMARY KEY NOT NULL,
	`bell_plan_id` integer,
	FOREIGN KEY (`bell_plan_id`) REFERENCES `bell_plans`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `zone_members` (
	`zone_id` integer NOT NULL,
	`speaker_mac` text NOT NULL,
	PRIMARY KEY(`zone_id`, `speaker_mac`),
	FOREIGN KEY (`zone_id`) REFERENCES `zones`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `zones` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `zones_name_unique` ON `zones` (`name`);