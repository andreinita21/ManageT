CREATE TABLE `stack_layouts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`stack_id` text NOT NULL,
	`layout_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade
);
