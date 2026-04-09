"use client";

import React from "react";
import Link from "next/link";
import type { Server } from "@/types";
import { MetricSparkline } from "./MetricSparkline";
import { AlertBadge } from "./AlertBadge";
import { Badge } from "@/components/ui/Badge";

interface ServerCardProps {
  server: Server;
  cpuHistory?: number[];
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  alertCount?: number;
}

const statusConfig: Record<Server["status"], { color: string; glow: string; label: string; variant: "success" | "danger" | "warning" | "default" }> = {
  connected: { color: "bg-emerald-400", glow: "shadow-[0_0_8px_rgba(52,211,153,0.6)]", label: "Connected", variant: "success" },
  disconnected: { color: "bg-red-400", glow: "shadow-[0_0_8px_rgba(248,113,113,0.6)]", label: "Disconnected", variant: "danger" },
  reconnecting: { color: "bg-amber-400", glow: "shadow-[0_0_8px_rgba(251,191,36,0.6)]", label: "Reconnecting", variant: "warning" },
  unreachable: { color: "bg-red-600", glow: "shadow-[0_0_8px_rgba(220,38,38,0.6)]", label: "Unreachable", variant: "danger" },
  unknown: { color: "bg-zinc-500", glow: "shadow-[0_0_8px_rgba(113,113,122,0.4)]", label: "Unknown", variant: "default" },
};

export function ServerCard({ server, cpuHistory = [], memoryUsedMb, memoryTotalMb, alertCount = 0 }: ServerCardProps) {
  const status = statusConfig[server.status];
  const memoryPercent = memoryTotalMb && memoryTotalMb > 0 ? (memoryUsedMb ?? 0) / memoryTotalMb * 100 : 0;

  return (
    <Link href={`/servers/${server.id}`}>
      <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4 hover:border-mg-border-hover hover:shadow-glow transition-all duration-200 cursor-pointer group">
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <div className={`w-2 h-2 rounded-full ${status.color} ${status.glow}`} />
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
                backgroundColor: memoryPercent > 90 ? "#ef4444" : memoryPercent > 70 ? "#f59e0b" : "#a855f7",
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
