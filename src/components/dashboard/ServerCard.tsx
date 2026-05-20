"use client";

import React from "react";
import Link from "next/link";
import type { Server } from "@/types";
import { MetricSparkline } from "./MetricSparkline";
import { AlertBadge } from "./AlertBadge";
import { Badge } from "@/components/ui/Badge";
import { AgentStatusBadge } from "@/components/server/AgentStatusBadge";

interface ServerCardProps {
  server: Server;
  cpuHistory?: number[];
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  alertCount?: number;
}

/**
 * Map agent status to the status-dot colour used on the card header. The
 * actual agent pill is rendered separately via <AgentStatusBadge/>; this
 * mapping only controls the little glowing circle next to the name.
 */
const dotByAgentStatus: Record<Server["agentStatus"], { color: string; glow: string }> = {
  healthy: {
    color: "bg-mg-success",
    glow: "shadow-[0_0_8px_var(--color-mg-success)]",
  },
  installing: {
    color: "bg-mg-info animate-pulse",
    glow: "shadow-[0_0_8px_var(--color-mg-info)]",
  },
  install_failed: {
    color: "bg-mg-danger",
    glow: "shadow-[0_0_8px_var(--color-mg-danger)]",
  },
  unreachable: {
    color: "bg-mg-warning",
    glow: "shadow-[0_0_8px_var(--color-mg-warning)]",
  },
  uninstalling: {
    color: "bg-mg-text-tertiary animate-pulse",
    glow: "shadow-[0_0_8px_var(--color-mg-text-tertiary)]",
  },
  uninstall_failed: {
    color: "bg-mg-danger",
    glow: "shadow-[0_0_8px_var(--color-mg-danger)]",
  },
  not_installed: {
    color: "bg-mg-text-tertiary",
    glow: "shadow-[0_0_8px_var(--color-mg-text-tertiary)]",
  },
};

export function ServerCard({ server, cpuHistory = [], memoryUsedMb, memoryTotalMb, alertCount = 0 }: ServerCardProps) {
  const dot = dotByAgentStatus[server.agentStatus];
  const memoryPercent = memoryTotalMb && memoryTotalMb > 0 ? (memoryUsedMb ?? 0) / memoryTotalMb * 100 : 0;

  return (
    <Link href={`/servers/${server.id}`}>
      <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4 hover:border-mg-border-hover hover:shadow-glow transition-all duration-200 cursor-pointer group">
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <div className={`w-2 h-2 rounded-full ${dot.color} ${dot.glow}`} />
            <div>
              <h3 className="text-sm font-semibold text-mg-text group-hover:text-mg-accent-bright transition-colors duration-200">
                {server.name}
              </h3>
              <p className="text-xs text-mg-text-tertiary mt-0.5">
                {server.username}@{server.host}:{server.port}
              </p>
            </div>
          </div>
          <AlertBadge count={alertCount} />
        </div>

        {/* Agent status pill */}
        <div className="mb-3">
          <AgentStatusBadge
            status={server.agentStatus}
            lastHeartbeatAt={server.agentLastHeartbeatAt}
            installStage={server.agentInstallStage}
            installError={server.agentInstallError}
          />
        </div>

        {/* CPU Sparkline */}
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-mg-text-tertiary">CPU</span>
            {cpuHistory.length > 0 && (
              <span className="text-xs text-mg-text-secondary font-mono">
                {cpuHistory[cpuHistory.length - 1]?.toFixed(1)}%
              </span>
            )}
          </div>
          <MetricSparkline data={cpuHistory} />
        </div>

        {/* RAM Bar */}
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-mg-text-tertiary">RAM</span>
            <span className="text-xs text-mg-text-secondary font-mono">
              {memoryUsedMb != null ? `${(memoryUsedMb / 1024).toFixed(1)}` : "0"}
              {memoryTotalMb != null ? ` / ${(memoryTotalMb / 1024).toFixed(1)} GB` : ""}
            </span>
          </div>
          <div className="w-full h-1.5 bg-mg-bg-tertiary rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${Math.min(memoryPercent, 100)}%`,
                backgroundColor:
                  memoryPercent > 90
                    ? "var(--color-mg-danger)"
                    : memoryPercent > 70
                      ? "var(--color-mg-warning)"
                      : "var(--color-mg-accent)",
              }}
            />
          </div>
        </div>

        {/* Labels */}
        {server.labels.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {server.labels.map((label) => (
              <Badge key={label} variant="accent">
                {label}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}
