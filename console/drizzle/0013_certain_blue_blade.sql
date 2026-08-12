ALTER TABLE `system_state` ADD `local_backup_last_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `system_state` ADD `local_backup_last_success_at` integer;--> statement-breakpoint
ALTER TABLE `system_state` ADD `local_backup_last_error` text;--> statement-breakpoint
ALTER TABLE `system_state` ADD `offsite_backup_last_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `system_state` ADD `offsite_backup_last_success_at` integer;--> statement-breakpoint
ALTER TABLE `system_state` ADD `offsite_backup_last_error` text;--> statement-breakpoint
ALTER TABLE `system_state` ADD `last_completed_r2_key` text;