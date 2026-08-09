CREATE TABLE `audio_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`stored_name` text NOT NULL,
	`original_name` text,
	`mime_type` text,
	`size_bytes` integer NOT NULL,
	`duration_ms` integer,
	`uploaded_by` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audio_files_stored_name_unique` ON `audio_files` (`stored_name`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sound_cues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`delivery_method` text NOT NULL,
	`webhook_id` text,
	`tts_text` text,
	`tts_tone` text DEFAULT 'welcome' NOT NULL,
	`audio_file_id` integer,
	`estimated_duration_ms` integer,
	`zone_id` integer,
	`is_emergency` integer DEFAULT false NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`audio_file_id`) REFERENCES `audio_files`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`zone_id`) REFERENCES `zones`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "cue_method_fields" CHECK((delivery_method = 'PROTECT_WEBHOOK' AND webhook_id IS NOT NULL)
        OR (delivery_method = 'PROTECT_NATIVE_TTS' AND tts_text IS NOT NULL)
        OR (delivery_method = 'PROTECT_TALKBACK_AUDIO' AND audio_file_id IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_sound_cues`("id", "name", "description", "delivery_method", "webhook_id", "tts_text", "tts_tone", "zone_id", "is_emergency", "is_enabled", "sort_order", "created_at", "updated_at") SELECT "id", "name", "description", "delivery_method", "webhook_id", "tts_text", "tts_tone", "zone_id", "is_emergency", "is_enabled", "sort_order", "created_at", "updated_at" FROM `sound_cues`;--> statement-breakpoint
DROP TABLE `sound_cues`;--> statement-breakpoint
ALTER TABLE `__new_sound_cues` RENAME TO `sound_cues`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `sound_cues_name_unique` ON `sound_cues` (`name`);--> statement-breakpoint
ALTER TABLE `scheduled_runs` ADD `audio_path` text;--> statement-breakpoint
ALTER TABLE `system_state` ADD `speaker_busy_until` integer;