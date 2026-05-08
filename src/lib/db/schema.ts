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
  // ---- Agent-based monitoring fields ----
  // The Rust agent (installed on the remote server) is now the source of
  // truth for status + resource metrics. See src/lib/agent/*.
  agentStatus: text("agent_status", {
    enum: [
      "not_installed",
      "installing",
      "install_failed",
      "healthy",
      "unreachable",
      "uninstalling",
      "uninstall_failed",
    ],
  })
    .notNull()
    .default("not_installed"),
  // sha256 hex of the bearer token the agent uses to authenticate.
  agentTokenHash: text("agent_token_hash"),
  // Populated from the first successful heartbeat.
  agentVersion: text("agent_version"),
  // e.g. "x86_64-unknown-linux-musl" — filled in by the installer.
  agentArch: text("agent_arch"),
  // Epoch-ms of the most recent heartbeat. Drives the "unreachable" flip.
  agentLastHeartbeatAt: integer("agent_last_heartbeat_at"),
  // Last error string from install attempts. Shown in the UI on failure.
  agentInstallError: text("agent_install_error"),
  // Human-readable stage string written by the installer as it progresses
  // (e.g. "uploading binary", "starting service"). Used by the UI progress
  // panel to show what's happening right now.
  agentInstallStage: text("agent_install_stage"),
  // 0 | 1 — when 1, the next heartbeat returns {directive:"uninstall"}.
  pendingUninstall: integer("pending_uninstall").notNull().default(0),
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
  sessionName: text("session_name").notNull(),
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
  // When set, this session was launched as part of a stack and the column
  // points at the row in `stacks` so we can group / co-kill them.
  stackId: text("stack_id").references(() => stacks.id, { onDelete: "set null" }),
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

export const stacks = sqliteTable("stacks", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  // Soft-delete timestamp. When non-null the stack is in the Trash and
  // hidden from the active list, but its services + sessions still
  // resolve so an accidental delete can be restored without losing any
  // launched workloads.
  deletedAt: integer("deleted_at"),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const stackServices = sqliteTable("stack_services", {
  id: text("id").primaryKey(),
  stackId: text("stack_id")
    .notNull()
    .references(() => stacks.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  serverId: text("server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "cascade" }),
  cwd: text("cwd"),
  command: text("command"),
  orderIndex: integer("order_index").notNull().default(0),
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
