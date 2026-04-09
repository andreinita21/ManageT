/**
 * Drizzle ORM schema definitions for ManageT.
 * All tables for the application database.
 */
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "operator", "viewer"] })
    .notNull()
    .default("admin"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const servers = sqliteTable("servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  host: text("host").notNull(),
  port: integer("port").notNull().default(22),
  username: text("username").notNull(),
  authMethod: text("auth_method", { enum: ["key", "password"] }).notNull(),
  privateKeyPath: text("private_key_path"),
  passwordEncrypted: text("password_encrypted"),
  labels: text("labels").notNull().default("[]"),
  groupName: text("group_name"),
  status: text("status", {
    enum: ["connected", "disconnected", "reconnecting", "unreachable", "unknown"],
  })
    .notNull()
    .default("unknown"),
  lastConnectedAt: integer("last_connected_at"),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  serverId: text("server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "cascade" }),
  tmuxSessionName: text("tmux_session_name").notNull(),
  status: text("status", {
    enum: ["active", "disconnected", "reconnecting", "recovering", "closed"],
  }).notNull(),
  cwd: text("cwd"),
  lastCommand: text("last_command"),
  envSnapshot: text("env_snapshot"),
  scrollBufferTail: text("scroll_buffer_tail"),
  restartPolicy: text("restart_policy", { enum: ["auto", "ask", "never"] })
    .notNull()
    .default("ask"),
  disconnectedAt: integer("disconnected_at"),
  retryCount: integer("retry_count").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const restartRules = sqliteTable("restart_rules", {
  id: text("id").primaryKey(),
  scope: text("scope", { enum: ["global", "server", "session"] }).notNull(),
  scopeId: text("scope_id"),
  pattern: text("pattern").notNull(),
  patternType: text("pattern_type", { enum: ["glob", "regex", "exact"] }).notNull(),
  action: text("action", { enum: ["auto", "ask", "never"] }).notNull(),
  priority: integer("priority").notNull().default(0),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at").notNull(),
});

export const commandHistory = sqliteTable("command_history", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  serverId: text("server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "cascade" }),
  command: text("command").notNull(),
  cwd: text("cwd"),
  exitCode: integer("exit_code"),
  durationMs: integer("duration_ms"),
  classifiedAs: text("classified_as", { enum: ["safe", "dangerous", "unknown"] }).notNull(),
  wasRestarted: integer("was_restarted").notNull().default(0),
  executedAt: integer("executed_at").notNull(),
});

export const metricSnapshots = sqliteTable("metric_snapshots", {
  id: text("id").primaryKey(),
  serverId: text("server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "cascade" }),
  cpuPercent: real("cpu_percent"),
  memoryUsedMb: integer("memory_used_mb"),
  memoryTotalMb: integer("memory_total_mb"),
  diskUsedPercent: real("disk_used_percent"),
  load1m: real("load_1m"),
  load5m: real("load_5m"),
  load15m: real("load_15m"),
  activeConnections: integer("active_connections"),
  capturedAt: integer("captured_at").notNull(),
});

export const alerts = sqliteTable("alerts", {
  id: text("id").primaryKey(),
  serverId: text("server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "cascade" }),
  metric: text("metric").notNull(),
  threshold: real("threshold").notNull(),
  actualValue: real("actual_value").notNull(),
  acknowledged: integer("acknowledged").notNull().default(0),
  triggeredAt: integer("triggered_at").notNull(),
});
