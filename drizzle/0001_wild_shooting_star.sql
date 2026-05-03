-- ============================================================================
-- Migration 0001: agent-based monitoring
-- ============================================================================
-- Switches server status/metrics from SSH-polling to a Rust agent that pushes
-- heartbeats. See src/lib/agent/*.
--
-- Because status and metric semantics change, any existing server rows were
-- added under the old SSH-only model and are stale. Per user decision, we
-- wipe them out — users will re-add via the new Add Server flow which auto-
-- installs the agent. Cascading deletes handle children, but we're explicit
-- so the intent is visible in the migration log.
-- ----------------------------------------------------------------------------
DELETE FROM `alerts`;--> statement-breakpoint
DELETE FROM `command_history`;--> statement-breakpoint
DELETE FROM `metric_snapshots`;--> statement-breakpoint
DELETE FROM `sessions`;--> statement-breakpoint
DELETE FROM `servers`;--> statement-breakpoint

-- stacks / stack_services may already exist in older dev databases from a
-- previous `drizzle-kit push` that wasn't captured as a migration. Use
-- IF NOT EXISTS so this migration is idempotent on those DBs and still
-- creates the tables on fresh ones.
CREATE TABLE IF NOT EXISTS `stacks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `stack_services` (
	`id` text PRIMARY KEY NOT NULL,
	`stack_id` text NOT NULL,
	`name` text NOT NULL,
	`server_id` text NOT NULL,
	`cwd` text,
	`command` text,
	`order_index` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `servers` ADD `agent_status` text DEFAULT 'not_installed' NOT NULL;--> statement-breakpoint
ALTER TABLE `servers` ADD `agent_token_hash` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `agent_version` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `agent_arch` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `agent_last_heartbeat_at` integer;--> statement-breakpoint
ALTER TABLE `servers` ADD `agent_install_error` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `agent_install_stage` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `pending_uninstall` integer DEFAULT 0 NOT NULL;