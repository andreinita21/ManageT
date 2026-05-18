CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`theme_key` text DEFAULT 'mg-default' NOT NULL,
	`terminal_font_family` text DEFAULT 'JetBrains Mono' NOT NULL,
	`terminal_font_size` integer DEFAULT 14 NOT NULL,
	`custom_theme` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
