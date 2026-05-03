"use client";

/**
 * AgentStatusBadge — renders a pill summarising the state of the Rust
 * monitoring agent on a server. Pulls from `Server.agentStatus` (which the
 * backend derives from install progress + heartbeat freshness).
 */
import React from "react";
import type { Server } from "@/types";

type AgentStatus = NonNullable<Server["agentStatus"]>;

interface AgentStatusBadgeProps {
  status: AgentStatus;
  lastHeartbeatAt?: number;
  installStage?: string;
  installError?: string;
  className?: string;
}

/** Visual config per status. */
const STATUS: Record<
  AgentStatus,
  { label: string; dot: string; bg: string; text: string; ring: string }
> = {
  not_installed: {
    label: "Not installed",
    dot: "bg-zinc-500",
    bg: "bg-zinc-500/10",
    text: "text-zinc-300",
    ring: "ring-zinc-500/30",
  },
  installing: {
    label: "Installing agent",
    dot: "bg-blue-400 animate-pulse",
    bg: "bg-blue-500/10",
    text: "text-blue-300",
    ring: "ring-blue-500/30",
  },
  install_failed: {
    label: "Install failed",
    dot: "bg-red-500",
    bg: "bg-red-500/10",
    text: "text-red-300",
    ring: "ring-red-500/40",
  },
  healthy: {
    label: "Healthy",
    dot: "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]",
    bg: "bg-emerald-500/10",
    text: "text-emerald-300",
    ring: "ring-emerald-500/30",
  },
  unreachable: {
    label: "Unreachable",
    dot: "bg-amber-400",
    bg: "bg-amber-500/10",
    text: "text-amber-300",
    ring: "ring-amber-500/40",
  },
  uninstalling: {
    label: "Uninstalling",
    dot: "bg-zinc-400 animate-pulse",
    bg: "bg-zinc-500/10",
    text: "text-zinc-300",
    ring: "ring-zinc-500/30",
  },
  uninstall_failed: {
    label: "Uninstall failed",
    dot: "bg-red-500",
    bg: "bg-red-500/10",
    text: "text-red-300",
    ring: "ring-red-500/40",
  },
};

/** Produce a short "4s ago" style string from a timestamp. */
function formatAge(ts: number | undefined): string | null {
  if (!ts) return null;
  const deltaMs = Date.now() - ts;
  if (deltaMs < 0) return "just now";
  const secs = Math.floor(deltaMs / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function AgentStatusBadge({
  status,
  lastHeartbeatAt,
  installStage,
  installError,
  className = "",
}: AgentStatusBadgeProps) {
  const cfg = STATUS[status];
  const age = formatAge(lastHeartbeatAt);

  // Per-status detail line.
  let detail: string | null = null;
  if (status === "healthy" && age) {
    detail = `heartbeat ${age}`;
  } else if (status === "installing" && installStage) {
    detail = installStage;
  } else if (status === "install_failed") {
    detail = installError ?? "install failed";
  } else if (status === "unreachable" && age) {
    detail = `no heartbeat for ${age}`;
  } else if (status === "uninstalling" && installStage) {
    detail = installStage;
  } else if (status === "uninstall_failed") {
    detail = installError ?? "uninstall failed";
  }

  return (
    <span
      className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs ring-1 ${cfg.bg} ${cfg.text} ${cfg.ring} ${className}`}
      title={detail ?? cfg.label}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      <span className="font-medium">{cfg.label}</span>
      {detail && (
        <span className="text-mg-text-tertiary font-normal truncate max-w-[14rem]">
          · {detail}
        </span>
      )}
    </span>
  );
}
