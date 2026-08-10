CREATE TABLE `bell_event_overrides` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`local_date` text NOT NULL,
	`bell_event_id` integer NOT NULL,
	`kind` text NOT NULL,
	`effective_time` text,
	`created_by` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bell_event_id`) REFERENCES `bell_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "bell_event_override_kind_fields" CHECK((kind = 'SKIP' AND effective_time IS NULL)
        OR (kind = 'DELAY' AND effective_time IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bell_event_override_date_event_uniq` ON `bell_event_overrides` (`local_date`,`bell_event_id`);--> statement-breakpoint
ALTER TABLE `system_state` ADD `worker_heartbeat_at` integer;--> statement-breakpoint
ALTER TABLE `system_state` ADD `worker_started_at` integer;