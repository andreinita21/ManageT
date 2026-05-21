// ============================================================
// src/types/index.ts — SHARED CONTRACTS (DO NOT MODIFY ALONE)
// ============================================================

// --- Database entities ---

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: "admin" | "operator" | "viewer";
  createdAt: number;
  updatedAt: number;
}

export type AgentStatus =
  | "not_installed"
  | "installing"
  | "install_failed"
  | "healthy"
  | "unreachable"
  | "uninstalling"
  | "uninstall_failed";

export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: "key" | "password";
  privateKeyPath?: string;
  passwordEncrypted?: string;
  labels: string[];
  groupName?: string;
  status: "connected" | "disconnected" | "reconnecting" | "unreachable" | "unknown";
  lastConnectedAt?: number;
  // --- Agent-based monitoring ---
  agentStatus: AgentStatus;
  agentTokenHash?: string;
  agentVersion?: string;
  agentArch?: string;
  agentLastHeartbeatAt?: number;
  agentInstallError?: string;
  agentInstallStage?: string;
  pendingUninstall: boolean;
  // ---- Per-server agent configuration ----
  heartbeatIntervalSecs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  autoUpdate: boolean;
  sessionRetentionDays: number;
  /** NULL / undefined = no cap on concurrent sessions for this server. */
  maxSessions?: number;
  /**
   * Dashboard URL the agent has been told to heartbeat to. `undefined`
   * for rows installed before this field existed — UI shows it as
   * "unknown" but still lets the user push a new value.
   */
  apiUrl?: string;
  /** `managet attach` status-bar colour. `undefined` = agent default (green). */
  barColor?: "green" | "cyan" | "magenta" | "yellow" | "blue" | "red" | "white" | "gray";
  /**
   * Comma-separated list of field keys for the status bar, in order
   * (e.g. `"session,user_host,detach"`). Recognised keys: session,
   * user_host, duration, detach. `undefined` = agent default.
   */
  barFields?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface Session {
  id: string;
  serverId: string;
  sessionName: string;
  status: "active" | "disconnected" | "reconnecting" | "recovering" | "closed";
  cwd?: string;
  lastCommand?: string;
  envSnapshot?: Record<string, string>;
  scrollBufferTail?: string;
  restartPolicy: "auto" | "ask" | "never";
  disconnectedAt?: number;
  retryCount: number;
  stackId?: string;
  groupId?: string;
  groupOrderIndex?: number;
  createdAt: number;
  updatedAt: number;
}

export interface RestartRule {
  id: string;
  scope: "global" | "server" | "session";
  scopeId?: string;
  pattern: string;
  patternType: "glob" | "regex" | "exact";
  action: "auto" | "ask" | "never";
  priority: number;
  createdBy: string;
  createdAt: number;
}

export interface CommandHistoryEntry {
  id: string;
  sessionId: string;
  serverId: string;
  command: string;
  cwd?: string;
  exitCode?: number;
  durationMs?: number;
  classifiedAs: "safe" | "dangerous" | "unknown";
  wasRestarted: boolean;
  executedAt: number;
}

export interface MetricSnapshot {
  id: string;
  serverId: string;
  cpuPercent?: number;
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  diskUsedPercent?: number;
  load1m?: number;
  load5m?: number;
  load15m?: number;
  activeConnections?: number;
  capturedAt: number;
}

export interface StackService {
  id: string;
  stackId: string;
  name: string;
  serverId: string;
  cwd?: string;
  command?: string;
  orderIndex: number;
}

export interface Stack {
  id: string;
  name: string;
  description?: string;
  /** Set when the stack has been soft-deleted (in Trash). */
  deletedAt?: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  services: StackService[];
}

export interface CreateStackServiceInput {
  name: string;
  serverId: string;
  cwd?: string;
  command?: string;
}

export interface CreateStackRequest {
  name: string;
  description?: string;
  services: CreateStackServiceInput[];
}

export interface UpdateStackRequest {
  name?: string;
  description?: string;
  services?: CreateStackServiceInput[];
}

/**
 * Aggregate state of a stack across all of its services. Derived from the
 * `sessions` table — see `getStackRuntime` in `src/lib/stacks/index.ts`.
 *
 *   - `idle`     — zero services have an active session.
 *   - `partial`  — some services are active, some are not.
 *   - `running`  — every service in the stack has an active session.
 */
export type StackRunState = "idle" | "partial" | "running";

export interface StackServiceRuntime {
  serviceId: string;
  serverId: string;
  /** id of the agent session backing this service, or null when none. */
  sessionId: string | null;
  /** "active" if a session row exists with status='active'; "inactive" otherwise. */
  status: "active" | "inactive";
  /** Live CPU% from the agent (sum across the process tree). null if the
   *  agent hasn't reported stats yet (older agent or no live PID). */
  cpuPercent: number | null;
  memoryMb: number | null;
  /** Milliseconds since the last stats update. null when never reported. */
  statsAgeMs: number | null;
  /** Number of processes summed for this service (root + descendants). */
  pidCount: number | null;
}

export interface StackRuntime {
  stackId: string;
  state: StackRunState;
  activeCount: number;
  totalCount: number;
  services: StackServiceRuntime[];
}

export interface LaunchStackResponse {
  stackId: string;
  launched: Array<{
    serviceId: string;
    sessionId: string;
    serverId: string;
    sessionName: string;
  }>;
  failed: Array<{
    serviceId: string;
    serverId: string;
    error: string;
  }>;
}

// --- Groups (mosaic-view collections of standalone sessions) ---

/** Hard cap on terminals per group. Matches the mosaic layout (max two
 *  rows of three). */
export const GROUP_MAX_MEMBERS = 6;

export interface Group {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Member sessions, ordered by `groupOrderIndex`. */
  members: Session[];
}

/** Per-user persisted layout for a group's mosaic.
 *
 *  `rowHeights` is a 1- or 2-entry array summing to 1. `colWidthsByRow`
 *  has one inner array per row; each inner array sums to 1 and has length
 *  matching the number of members in that row. If counts no longer match
 *  the current member arrangement, the UI falls back to the default
 *  equal-split layout (and overwrites on the next drag).
 *
 *  `fontSizeBySession` carries optional per-pane font-size overrides
 *  (the user's +/- bumps from the cell bar). Keys that don't appear
 *  fall back to the global appearance default.
 */
export interface GroupLayout {
  rowHeights: number[];
  colWidthsByRow: number[][];
  fontSizeBySession?: Record<string, number>;
}

export interface CreateGroupRequest {
  name: string;
  /** First member — required, since empty groups aren't allowed. */
  sessionId: string;
}

export interface UpdateGroupRequest {
  name?: string;
}

export interface AddGroupMemberRequest {
  sessionId: string;
}

export interface ReorderGroupRequest {
  /** Full ordered list of session ids in the group. Length must equal
   *  current member count. */
  sessionIds: string[];
}

export interface Alert {
  id: string;
  serverId: string;
  metric: string;
  threshold: number;
  actualValue: number;
  acknowledged: boolean;
  triggeredAt: number;
}

// --- Session snapshot (in-memory + persisted) ---

export interface SessionSnapshot {
  sessionId: string;
  serverId: string;
  sessionName: string;
  cwd: string;
  lastCommand: string;
  env: Record<string, string>;
  scrollBuffer: string[];
  status: Session["status"];
  disconnectedAt?: number;
  retryCount: number;
}

// --- WebSocket protocol ---

export type ClientMessage =
  | { type: "terminal:input"; sessionId: string; data: string }
  | { type: "terminal:resize"; sessionId: string; cols: number; rows: number; serverId?: string }
  | { type: "session:create"; serverId: string; command?: string; name?: string; cwd?: string }
  | { type: "session:attach"; sessionId: string; serverId: string }
  | { type: "session:detach"; sessionId: string }
  | { type: "session:kill"; sessionId: string; serverId: string };

export type ServerMessage =
  | { type: "terminal:output"; sessionId: string; data: string }
  | { type: "session:state"; session: SessionSnapshot }
  | { type: "session:recovered"; sessionId: string; method: "reattach" | "recreate"; command?: string; cwd?: string }
  | { type: "session:lost"; sessionId: string; reason: string }
  | { type: "metrics:update"; serverId: string; metrics: MetricSnapshot }
  | { type: "server:status"; serverId: string; status: Server["status"] };

// --- Restart classification ---

export type RestartAction = "auto" | "ask" | "never";

export interface ClassificationResult {
  command: string;
  action: RestartAction;
  matchedBy: "session-override" | "user-rule" | "builtin-dangerous" | "builtin-safe" | "heuristic" | "default";
  ruleName?: string;
  confidence: "high" | "medium" | "low";
}

// --- API request/response types ---

export interface CreateServerRequest {
  name: string;
  host: string;
  port?: number;
  username: string;
  authMethod: "key" | "password";
  privateKeyPath?: string;
  password?: string;
  labels?: string[];
  groupName?: string;
}

export interface ExecCommandRequest {
  command: string;
  cwd?: string;
  timeout?: number;
}

export interface ExecCommandResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface CreateRestartRuleRequest {
  scope: "global" | "server" | "session";
  scopeId?: string;
  pattern: string;
  patternType: "glob" | "regex" | "exact";
  action: RestartAction;
  priority?: number;
}

export interface TestRestartRuleRequest {
  command: string;
  serverId?: string;
  sessionId?: string;
}

export interface TestRestartRuleResponse {
  result: ClassificationResult;
  matchedRules: RestartRule[];
}
