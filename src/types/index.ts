// ============================================================
// src/types/index.ts — SHARED CONTRACTS (DO NOT MODIFY ALONE)
// ============================================================

// --- Database entities ---

export interface User {
  id: string;
  username: string;
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
  | "uninstall_failed"
  /** Operator-initiated stop via `managet stop` on the host. Distinct
   *  from `unreachable` (which means the heartbeat just went missing).
   *  While in this state the UI must disable session attach/create
   *  with a precise message. Cleared back to `healthy` by the next
   *  heartbeat after `managet start`. */
  | "manually_stopped";

export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: "key" | "password";
  privateKeyPath?: string;
  /**
   * AES-GCM ciphertext of the SSH password. INTERNAL ONLY — populated by
   * `rowToServer` for the SSH/agent code paths and must never be sent to a
   * client. API responses go through `toPublicServer`, which strips it and
   * exposes `hasPassword` instead.
   */
  passwordEncrypted?: string;
  /** True when a password credential is stored. Safe to send to clients. */
  hasPassword?: boolean;
  /** SHA-256 fingerprint of the host's SSH public key (TOFU). Not secret. */
  hostKeyFingerprint?: string;
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
  // ---- Fan control ----
  /** Current target mode: auto (OS-managed), manual (pin to fanTargetRpm),
   *  or max (peg to hardware max). Defaults to auto on new servers. */
  fanMode: "auto" | "manual" | "max";
  /** Pinned RPM when `fanMode === "manual"`. Clamped by the agent
   *  against the hardware's reported safe range. */
  fanTargetRpm?: number;
  /** True when the dashboard has set a new fan command that the agent
   *  hasn't yet acknowledged (cleared on the heartbeat that ships it). */
  fanPending: boolean;
  /** Last error reported by the agent when it tried to apply a fan
   *  command. Apple Silicon Mac mini M4 returns "SMC reported
   *  zero-length key" for the `FS! ` write — fan control via legacy
   *  SMC keys isn't available there. Linux hosts may return permission
   *  errors when PWM channels are firmware-locked. */
  fanError?: string;
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

export interface FanReading {
  /** Driver-supplied label: "cpu_fan", "Fan 0", or a synthetic
   *  "<chip>/fanN" when the driver doesn't expose a label. Never empty. */
  name: string;
  /** Raw RPM from `fan*_input` / SMC `F<n>Ac`. */
  rpm: number;
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
  /** CPU package/proximity temperature in °C, or undefined when the
   *  agent didn't find a sensor (or the agent predates this field). */
  cpuTempC?: number;
  /** GPU temperature in °C. Always undefined on hosts the installer
   *  flagged as GPU-less. */
  gpuTempC?: number;
  /** Per-fan RPM readings from the most recent heartbeat. Empty/undefined
   *  on fanless systems (RPi) or unsupported platforms. */
  fans?: FanReading[];
  /** Pre-derived max RPM across `fans` at insert time. Populated on
   *  bucket-aggregated rows so charts can plot a fan-activity line
   *  without parsing the JSON blob in every row. */
  fanMaxRpm?: number;
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
  /** Latest CPU temperature (°C) of the host this service runs on, from the
   *  most recent metric snapshot within the freshness window. null when the
   *  host hasn't reported a usable sensor. Shared by all services on the
   *  same server. */
  cpuTempC: number | null;
  /** Latest GPU temperature (°C) of the host, or null on GPU-less hosts. */
  gpuTempC: number | null;
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
 *  `rowPartition` is the column count per row that the user picked from
 *  the arrangement menu (e.g. `[2, 2]` for a four-member group, `[1, 2]`
 *  for a three-member group). When present, it must sum to the current
 *  member count and have the same length as `rowHeights`. When absent,
 *  the UI falls back to the default 3-per-row layout.
 *
 *  `fontSizeBySession` carries optional per-pane font-size overrides
 *  (the user's +/- bumps from the cell bar). Keys that don't appear
 *  fall back to the global appearance default.
 */
export interface GroupLayout {
  rowHeights: number[];
  colWidthsByRow: number[][];
  rowPartition?: number[];
  fontSizeBySession?: Record<string, number>;
}

/** Allowed row arrangements for a group with `n` members. First entry is
 *  the default (matching the legacy 3-per-row rule). Each arrangement is
 *  the column count per row; the array sums to `n` and never exceeds two
 *  rows. */
export function allowedRowPartitions(n: number): number[][] {
  switch (n) {
    case 1:
      return [[1]];
    case 2:
      return [[2], [1, 1]];
    case 3:
      return [[3], [1, 2], [2, 1]];
    case 4:
      return [[3, 1], [4], [2, 2], [1, 3]];
    case 5:
      return [[3, 2], [5], [2, 3]];
    case 6:
      return [[3, 3], [6]];
    default:
      return [];
  }
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
