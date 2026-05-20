ALTER TABLE `servers` ADD `heartbeat_interval_secs` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `servers` ADD `log_level` text DEFAULT 'info' NOT NULL;--> statement-breakpoint
ALTER TABLE `servers` ADD `auto_update` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `servers` ADD `session_retention_days` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `servers` ADD `max_sessions` integer;