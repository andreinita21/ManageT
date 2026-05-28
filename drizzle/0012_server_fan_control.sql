ALTER TABLE `servers` ADD `fan_mode` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `servers` ADD `fan_target_rpm` integer;--> statement-breakpoint
ALTER TABLE `servers` ADD `fan_pending` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `servers` ADD `fan_error` text;
