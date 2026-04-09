CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`metric` text NOT NULL,
	`threshold` real NOT NULL,
	`actual_value` real NOT NULL,
	`acknowledged` integer DEFAULT 0 NOT NULL,
	`triggered_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `command_history` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`server_id` text NOT NULL,
	`command` text NOT NULL,
	`cwd` text,
	`exit_code` integer,
	`duration_ms` integer,
	`classified_as` text NOT NULL,
	`was_restarted` integer DEFAULT 0 NOT NULL,
	`executed_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `metric_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`cpu_percent` real,
	`memory_used_mb` integer,
	`memory_total_mb` integer,
	`disk_used_percent` real,
	`load_1m` real,
	`load_5m` real,
	`load_15m` real,
	`active_connections` integer,
	`captured_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `restart_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text,
	`pattern` text NOT NULL,
	`pattern_type` text NOT NULL,
	`action` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`port` integer DEFAULT 22 NOT NULL,
	`username` text NOT NULL,
	`auth_method` text NOT NULL,
	`private_key_path` text,
	`password_encrypted` text,
	`labels` text DEFAULT '[]' NOT NULL,
	`group_name` text,
	`status` text DEFAULT 'unknown' NOT NULL,
	`last_connected_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`tmux_session_name` text NOT NULL,
	`status` text NOT NULL,
	`cwd` text,
	`last_command` text,
	`env_snapshot` text,
	`scroll_buffer_tail` text,
	`restart_policy` text DEFAULT 'ask' NOT NULL,
	`disconnected_at` integer,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'admin' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);