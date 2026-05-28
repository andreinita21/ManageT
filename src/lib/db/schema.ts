/**
 * Drizzle ORM schema definitions for ManageT.
 * All tables for the application database.
 */
import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
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
      // Operator-initiated stop via `managet stop` on the host. Distinct
      // from `unreachable` (which means "we lost the heartbeat and we
      // don't know why"). The agent POSTs to /api/agent/lifecycle
      // immediately before signalling systemd to stop, so the dashboard
      // can disable session attach/create with a precise message
      // instead of the generic "unreachable" warning. Cleared back to
      // `healthy` by the next heartbeat the agent sends when it's
      // restarted via `managet start`.
      "manually_stopped",
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
  // ---- Per-server agent configuration (editable from Settings) ----
  // Heartbeat cadence the agent should run at (seconds). The agent
  // reads this from its on-disk config; for now we only enforce at
  // install time. A future patch will push live updates via the
  // heartbeat response.
  heartbeatIntervalSecs: integer("heartbeat_interval_secs").notNull().default(10),
  // Verbosity of the agent's tracing logs. Applied at next install /
  // restart; not pushed live yet.
  logLevel: text("log_level", { enum: ["debug", "info", "warn", "error"] })
    .notNull()
    .default("info"),
  // When true, the agent should self-update to the latest binary on
  // start-up. Off by default — opt-in.
  autoUpdate: integer("auto_update").notNull().default(0),
  // How long closed sessions are retained before the dashboard's
  // cleanup pass deletes them. 0 = never auto-delete.
  sessionRetentionDays: integer("session_retention_days").notNull().default(30),
  // Cap on concurrent (non-closed) sessions per server. NULL = no cap.
  // Enforced when creating a new session via the API.
  maxSessions: integer("max_sessions"),
  // Dashboard URL the agent has been told to heartbeat to. Populated at
  // install time and editable from Settings → Servers → Agent so users
  // can repoint agents (e.g. switching a LAN install onto a Cloudflare
  // tunnel without a full reinstall). NULL on rows installed before
  // this column existed; the dashboard treats NULL as "use the URL
  // currently in the agent's config.toml — unknown to us".
  apiUrl: text("api_url"),
  // ---- `managet attach` status bar ----
  // Stored as the strings the agent's `bar.toml` understands, so a
  // dashboard PUT can be SSH-pushed verbatim. NULL = "leave whatever
  // the agent has on disk alone".
  barColor: text("bar_color", {
    enum: ["green", "cyan", "magenta", "yellow", "blue", "red", "white", "gray"],
  }),
  // Comma-separated list of field keys, in order, e.g. "session,user_host,detach".
  // Recognised keys: session, user_host, duration, detach. Same shape
  // we pass to `managet-agent reconfigure --bar-fields`.
  barFields: text("bar_fields"),
  // ---- Fan control (Phase 2) ----
  // Desired fan mode the dashboard wants on this host. "auto" lets the OS
  // / firmware manage fans (the safe default and the value the agent
  // restores on graceful shutdown). "manual" pins to `fan_target_rpm`.
  // "max" pins to the hardware's maximum, useful for "cool down after a
  // hard run" scenarios.
  fanMode: text("fan_mode", { enum: ["auto", "manual", "max"] })
    .notNull()
    .default("auto"),
  // Target RPM when fan_mode = "manual". NULL otherwise. Clamped against
  // the hardware's safe min/max by the agent on apply.
  fanTargetRpm: integer("fan_target_rpm"),
  // 0/1 — when 1, the next heartbeat response carries the fan command
  // so the agent applies it. Cleared by the heartbeat handler after
  // embedding the directive.
  fanPending: integer("fan_pending").notNull().default(0),
  // Free-form text — populated when the agent's most recent apply
  // failed (Apple Silicon may reject `FS! ` writes, Linux PWM may be
  // firmware-locked). Surfaced in the UI so operators understand why
  // a setting didn't stick. Cleared on a subsequent successful apply.
  fanError: text("fan_error"),
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
  // ---- Per-session live resource stats ----
  // Reported by the agent on every heartbeat for sessions whose root PID
  // it owns. NULL means "agent didn't report" (older agent, session not
  // owned by this agent, or shell already exited). All three are written
  // together; statsUpdatedAt drives the "stale" indicator in the UI.
  cpuPercent: real("cpu_percent"),
  memoryMb: integer("memory_mb"),
  statsUpdatedAt: integer("stats_updated_at"),
  // When set, this session was launched as part of a stack and the column
  // points at the row in `stacks` so we can group / co-kill them.
  stackId: text("stack_id").references(() => stacks.id, { onDelete: "set null" }),
  // Optional membership in a `groups` row. Mutually exclusive with stackId
  // at the application layer — stack-bound sessions can't be added to groups.
  // ON DELETE SET NULL so deleting a group frees its sessions instead of
  // killing them.
  groupId: text("group_id").references(() => groups.id, { onDelete: "set null" }),
  // Position within the group's mosaic (0..5). Meaningful only when
  // groupId is set; otherwise ignored. Used for both the slot index and
  // the persisted drag-and-drop order.
  groupOrderIndex: integer("group_order_index").notNull().default(0),
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

export const metricSnapshots = sqliteTable(
  "metric_snapshots",
  {
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
    // CPU package/proximity temperature in °C. Null when the agent
    // couldn't find a usable sensor (most hosts produce a value).
    cpuTempC: real("cpu_temp_c"),
    // GPU temperature in °C. Null on hosts the installer flagged as
    // GPU-less so the agent never even tries.
    gpuTempC: real("gpu_temp_c"),
    // JSON-serialised [{name, rpm}] for the raw snapshot. Used to
    // populate the "latest fan readings" widget; for time-series we
    // store a scalar summary alongside (see fan_max_rpm).
    fansJson: text("fans_json"),
    // Pre-derived max RPM across the sample's fans so bucket-aggregation
    // (AVG/MIN/MAX over a time window) can run as a normal SQL aggregate
    // without parsing JSON for every row.
    fanMaxRpm: integer("fan_max_rpm"),
    capturedAt: integer("captured_at").notNull(),
  },
  (t) => [
    // Composite index for the dashboard graph query, which filters by
    // serverId + a captured_at range. Without it, the route does a full
    // scan + per-row filter, which gets slow as the table grows.
    index("metric_snapshots_server_captured_idx").on(t.serverId, t.capturedAt),
  ]
);

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

/**
 * Groups co-locate up to 6 standalone terminal sessions into a single
 * mosaic view. Distinct from `stacks` (which define services to launch
 * together) — a group is a *display* construct over already-running
 * sessions. Membership is one-group-per-session; stack-bound sessions
 * are ineligible. Empty groups are auto-deleted by the API layer.
 */
export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Per-user persisted layout for a group's mosaic — row heights and
 * per-row column widths as ratios in [0, 1]. Stored as JSON so the schema
 * doesn't need to change if we add e.g. font overrides later. One row per
 * (userId, groupId).
 */
export const groupLayouts = sqliteTable("group_layouts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  groupId: text("group_id")
    .notNull()
    .references(() => groups.id, { onDelete: "cascade" }),
  layoutJson: text("layout_json").notNull(),
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

/**
 * Per-user appearance preferences. One row per user; absent row means
 * "all defaults" (the legacy purple theme + JetBrains Mono 14px).
 *
 *  - `themeKey` selects a preset or "custom" — the canonical list lives
 *    in src/lib/themes/presets.ts.
 *  - `customTheme` is a JSON-serialised ThemeColors payload, used when
 *    themeKey === "custom"; ignored otherwise.
 *  - Font settings apply to the terminal only (xterm config). The rest
 *    of the UI uses the inter/jetbrains pair from globals.css.
 */
export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  themeKey: text("theme_key").notNull().default("mg-default"),
  terminalFontFamily: text("terminal_font_family")
    .notNull()
    .default("JetBrains Mono"),
  terminalFontSize: integer("terminal_font_size").notNull().default(14),
  customTheme: text("custom_theme"),
  /** Controls what the group-mosaic cell title bar shows for each
   *  terminal's server: "host" (default — the SSH host) or "name" (the
   *  user-assigned friendly name). */
  groupViewServerLabel: text("group_view_server_label").notNull().default("host"),
  updatedAt: integer("updated_at").notNull(),
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
