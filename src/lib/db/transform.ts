/**
 * Helpers for converting Drizzle row types into the public `Server` type.
 *
 * SQLite columns are typed as `string | null` / `number | null`, but the
 * `Server` interface uses optional properties (`?`). This file centralises
 * the `null -> undefined` normalisation so every route/lib uses the same
 * shape.
 */
import type { servers } from "./schema";
import type { Server, AgentStatus } from "@/types";

type ServerRow = typeof servers.$inferSelect;

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
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
