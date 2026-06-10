-- 0021_palette_commands: per-user command palette (slots 1-9).
--
-- Saved commands pasteable into any terminal: web UI overlay (button
-- next to the image upload) and CLI `Ctrl-A P` overlay. Synced per user
-- via /api/palette (browser, NextAuth cookie) and /api/cli/palette
-- (CLI, bearer token).
--
-- NOTE: drizzle migration tracking is stuck at 0010 on the live DB —
-- apply this by hand:  sqlite3 data/managet.db < drizzle/0021_palette_commands.sql

CREATE TABLE `palette_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`slot` integer NOT NULL,
	`label` text,
	`command` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `palette_commands_user_slot_idx` ON `palette_commands` (`user_id`,`slot`);
