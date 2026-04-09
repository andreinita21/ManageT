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
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface Session {
  id: string;
  serverId: string;
  tmuxSessionName: string;
  status: "active" | "disconnected" | "reconnecting" | "recovering" | "closed";
  cwd?: string;
  lastCommand?: string;
  envSnapshot?: Record<string, string>;
  scrollBufferTail?: string;
  restartPolicy: "auto" | "ask" | "never";
  disconnectedAt?: number;
  retryCount: number;
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
  tmuxSession: string;
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
  | { type: "terminal:resize"; sessionId: string; cols: number; rows: number }
  | { type: "session:create"; serverId: string; command?: string; cwd?: string }
  | { type: "session:attach"; sessionId: string }
  | { type: "session:detach"; sessionId: string }
  | { type: "session:kill"; sessionId: string };

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
