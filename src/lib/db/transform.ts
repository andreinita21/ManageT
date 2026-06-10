/**
 * Helpers for converting Drizzle row types into the public `Server` type.
 *
 * SQLite columns are typed as `string | null` / `number | null`, but the
 * `Server` interface uses optional properties (`?`). This file centralises
 * the `null -> undefined` normalisation so every route/lib uses the same
 * shape.
 */
import type { servers, sessions } from "./schema";
import type { Server, AgentStatus, Session } from "@/types";

type ServerRow = typeof servers.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;

export function rowToServer(r: ServerRow): Server {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    port: r.port,
    username: r.username,
    authMethod: r.authMethod as Server["authMethod"],
    privateKeyPath: r.privateKeyPath ?? undefined,
    passwordEncrypted: r.passwordEncrypted ?? undefined,
    labels: JSON.parse(r.labels) as string[],
    groupName: r.groupName ?? undefined,
    status: r.status as Server["status"],
    lastConnectedAt: r.lastConnectedAt ?? undefined,
    agentStatus: r.agentStatus as AgentStatus,
    agentTokenHash: r.agentTokenHash ?? undefined,
    agentVersion: r.agentVersion ?? undefined,
    agentArch: r.agentArch ?? undefined,
    agentLastHeartbeatAt: r.agentLastHeartbeatAt ?? undefined,
    agentInstallError: r.agentInstallError ?? undefined,
    agentInstallStage: r.agentInstallStage ?? undefined,
    pendingUninstall: r.pendingUninstall === 1,
    heartbeatIntervalSecs: r.heartbeatIntervalSecs,
    logLevel: r.logLevel as Server["logLevel"],
    autoUpdate: r.autoUpdate === 1,
    sessionRetentionDays: r.sessionRetentionDays,
    maxSessions: r.maxSessions ?? undefined,
    apiUrl: r.apiUrl ?? undefined,
    barColor: (r.barColor as Server["barColor"]) ?? undefined,
    barFields: r.barFields ?? undefined,
    fanMode: r.fanMode as Server["fanMode"],
    fanTargetRpm: r.fanTargetRpm ?? undefined,
    fanPending: r.fanPending === 1,
    fanError: r.fanError ?? undefined,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Public-facing server shape for API responses. Strips secrets that the
 * internal `rowToServer` carries for the SSH/agent code paths — the
 * encrypted password ciphertext and the agent token hash must never reach
 * a client — and exposes a `hasPassword` boolean instead. Use this at every
 * HTTP response boundary; use `rowToServer` only inside the server.
 */
export function toPublicServer(r: ServerRow): Server {
  const { passwordEncrypted, agentTokenHash, ...safe } = rowToServer(r);
  void passwordEncrypted;
  void agentTokenHash;
  return { ...safe, hasPassword: !!r.passwordEncrypted };
}

export function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    serverId: r.serverId,
    sessionName: r.sessionName,
    status: r.status as Session["status"],
    restartPolicy: r.restartPolicy as Session["restartPolicy"],
    cwd: r.cwd ?? undefined,
    lastCommand: r.lastCommand ?? undefined,
    envSnapshot: r.envSnapshot
      ? (JSON.parse(r.envSnapshot) as Record<string, string>)
      : undefined,
    scrollBufferTail: r.scrollBufferTail ?? undefined,
    disconnectedAt: r.disconnectedAt ?? undefined,
    retryCount: r.retryCount,
    stackId: r.stackId ?? undefined,
    groupId: r.groupId ?? undefined,
    groupOrderIndex: r.groupOrderIndex,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
