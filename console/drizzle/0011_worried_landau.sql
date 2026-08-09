CREATE TABLE `sound_cue_parts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cue_id` integer NOT NULL,
	`position` integer NOT NULL,
	`audio_file_id` integer NOT NULL,
	FOREIGN KEY (`cue_id`) REFERENCES `sound_cues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audio_file_id`) REFERENCES `audio_files`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cue_part_position_uniq` ON `sound_cue_parts` (`cue_id`,`position`);--> statement-breakpoint
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
        OR (delivery_method = 'PROTECT_TALKBACK_AUDIO' AND audio_file_id IS NOT NULL)
        OR (delivery_method = 'PROTECT_TALKBACK_COMPOSITE'))
);
--> statement-breakpoint
INSERT INTO `__new_sound_cues`("id", "name", "description", "delivery_method", "webhook_id", "tts_text", "tts_tone", "audio_file_id", "estimated_duration_ms", "zone_id", "is_emergency", "is_enabled", "sort_order", "created_at", "updated_at") SELECT "id", "name", "description", "delivery_method", "webhook_id", "tts_text", "tts_tone", "audio_file_id", "estimated_duration_ms", "zone_id", "is_emergency", "is_enabled", "sort_order", "created_at", "updated_at" FROM `sound_cues`;--> statement-breakpoint
DROP TABLE `sound_cues`;--> statement-breakpoint
ALTER TABLE `__new_sound_cues` RENAME TO `sound_cues`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `sound_cues_name_unique` ON `sound_cues` (`name`);