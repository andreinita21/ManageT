ALTER TABLE `metric_snapshots` ADD `cpu_temp_c` real;--> statement-breakpoint
ALTER TABLE `metric_snapshots` ADD `gpu_temp_c` real;--> statement-breakpoint
ALTER TABLE `metric_snapshots` ADD `fans_json` text;--> statement-breakpoint
ALTER TABLE `metric_snapshots` ADD `fan_max_rpm` integer;
